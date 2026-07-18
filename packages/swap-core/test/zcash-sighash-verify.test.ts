/**
 * DECISIVE, money-free proof of the Zcash HTLC spend path.
 *
 * The existing htlc.test.ts checks *shape* (script layout, fee, hex format) but never
 * proves the ONE thing that puts money at risk: that the signature swap-core produces
 * actually validates against the ZIP-243 sighash the Zcash network will compute, and that
 * the redeem-script spend conditions are satisfiable. This file closes that gap before a
 * single zatoshi is locked.
 *
 * Strategy (three independent checks that must all agree):
 *   1. INDEPENDENT ZIP-243 sighash. A from-scratch implementation of the Sapling/ZIP-243
 *      transparent sighash (BLAKE2b-256, personalized), fed the values we EXPECT the tx to
 *      carry (branch id from the height table, version-group 0x892f2085, the utxo value).
 *      Cross-checked against @bitgo's hashForSignatureByNetwork on the actual built tx.
 *   2. ECDSA verify. The signature embedded in the produced scriptSig must verify against
 *      that sighash under the claimant/refund pubkey. This is exactly what OP_CHECKSIG does.
 *   3. Script conditions. OP_SHA256(preimage)==hashlock (claim) and HASH160(pubkey)==PKH —
 *      the rest of what the redeem script enforces.
 */
import { describe, it, expect } from 'vitest';
import * as utxolib from '@bitgo/utxo-lib';
import { blake2b } from '@noble/hashes/blake2b';
import { sha256 } from '@noble/hashes/sha256';
import {
  buildClaimTx,
  buildRefundTx,
  htlcRedeemScript,
  htlcAddress,
  htlcOutputScript,
  pubkeyHash,
  type HtlcTerms,
} from '../src/zcash/htlc.js';
import { branchIdAtHeight } from '../src/zcash/network.js';

const { script: bscript, ECPair, crypto: bcrypto } = utxolib;
const ZCASH = utxolib.networks.zcash;

// ---------------------------------------------------------------------------
// Independent ZIP-243 transparent sighash (Sapling v4, transparent-only tx).
// Written from the ZIP-243 spec structure, NOT copied from @bitgo, so agreement
// between the two is a genuine cross-check of the digest + wiring.
// ---------------------------------------------------------------------------
const VGID_SAPLING = 0x892f2085;
const ZERO32 = Buffer.alloc(32);

function pers(prefix: string, branchId?: number): Buffer {
  const p = Buffer.alloc(16);
  p.write(prefix);
  if (branchId !== undefined) p.writeUInt32LE(branchId >>> 0, prefix.length);
  return p;
}
function blake(msg: Buffer, personal: Buffer): Buffer {
  return Buffer.from(blake2b(msg, { dkLen: 32, personalization: personal }));
}
function varSlice(b: Buffer): Buffer {
  // scriptCode/scriptPubKey are < 0xfd bytes for our txs; encode the 1-byte length prefix.
  if (b.length >= 0xfd) throw new Error('varint>1byte not needed here');
  return Buffer.concat([Buffer.from([b.length]), b]);
}
function u32le(n: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n >>> 0);
  return b;
}
function u64le(n: number): Buffer {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(BigInt(n));
  return b;
}

interface ParsedTx {
  version: number;
  overwintered: boolean;
  versionGroupId: number;
  locktime: number;
  expiryHeight: number;
  ins: Array<{ hash: Buffer; index: number; sequence: number; script: Buffer }>;
  outs: Array<{ script: Buffer; value: number }>;
}

/** ZIP-243 sighash for input `inIndex`, SIGHASH_ALL, over transparent-only tx. */
function zip243SighashAll(
  tx: ParsedTx,
  inIndex: number,
  scriptCode: Buffer,
  amountZat: number,
  branchId: number,
): Buffer {
  const HASH_TYPE = 1; // SIGHASH_ALL

  const prevouts = Buffer.concat(tx.ins.map((i) => Buffer.concat([i.hash, u32le(i.index)])));
  const hashPrevouts = blake(prevouts, pers('ZcashPrevoutHash'));

  const sequences = Buffer.concat(tx.ins.map((i) => u32le(i.sequence)));
  const hashSequence = blake(sequences, pers('ZcashSequencHash')); // NB: spec spelling, no 'e'

  const outputs = Buffer.concat(
    tx.outs.map((o) => Buffer.concat([u64le(o.value), varSlice(o.script)])),
  );
  const hashOutputs = blake(outputs, pers('ZcashOutputsHash'));

  const header = Buffer.alloc(4);
  header.writeUInt32LE((tx.version | (tx.overwintered ? 0x80000000 : 0)) >>> 0);

  const input = tx.ins[inIndex];
  const preimage = Buffer.concat([
    header,
    u32le(tx.versionGroupId),
    hashPrevouts,
    hashSequence,
    hashOutputs,
    ZERO32, // hashJoinSplits
    ZERO32, // hashShieldedSpends (transparent-only ⇒ zero)
    ZERO32, // hashShieldedOutputs (transparent-only ⇒ zero)
    u32le(tx.locktime),
    u32le(tx.expiryHeight),
    u64le(0), // valueBalance = 0 (no Sapling value)
    u32le(HASH_TYPE),
    input.hash,
    u32le(input.index),
    varSlice(scriptCode),
    u64le(amountZat),
    u32le(input.sequence),
  ]);
  return blake(preimage, pers('ZcashSigHash', branchId));
}

function parse(hex: string): ParsedTx & { _raw: any } {
  const t = utxolib.bitgo.createTransactionFromBuffer(Buffer.from(hex, 'hex'), ZCASH, {
    amountType: 'number',
  }) as any;
  return {
    _raw: t,
    version: t.version,
    overwintered: !!t.overwintered,
    versionGroupId: t.versionGroupId,
    locktime: t.locktime,
    expiryHeight: t.expiryHeight,
    ins: t.ins.map((i: any) => ({ hash: i.hash, index: i.index, sequence: i.sequence, script: i.script })),
    outs: t.outs.map((o: any) => ({ script: o.script, value: o.value })),
  };
}

// ---------------------------------------------------------------------------
// Fixtures — a self-swap style HTLC where one key is both claimant and refund.
// ---------------------------------------------------------------------------
const key = ECPair.fromPrivateKey(Buffer.alloc(32, 0x44));
const otherKey = ECPair.fromPrivateKey(Buffer.alloc(32, 0x55));
const SECRET = Buffer.from(sha256(Buffer.from('the-swap-secret-preimage-seed')));
const HASHLOCK = Buffer.from(sha256(SECRET));
const TIP = 3_430_000; // > NU6.3 activation
const TIMEOUT = TIP + 40;

function terms(): HtlcTerms {
  return {
    hashlock: HASHLOCK,
    claimantPubkey: Buffer.from(key.publicKey),
    refundPubkey: Buffer.from(otherKey.publicKey),
    timeoutHeight: TIMEOUT,
  };
}
const utxo = { txid: 'b'.repeat(64), vout: 1, valueZat: 1_000_000 }; // 0.01 ZEC
const DEST = 't1U7Qt5ULyXuTxoUrTHjNsPLTaYpuDGhujW';

function signerOf(pair: any) {
  return { publicKey: Buffer.from(pair.publicKey), sign: (h: Buffer) => Buffer.from(pair.sign(h)) };
}

/** Pull [sig64, hashType, pubkey, preimage?] out of a finished HTLC scriptSig. */
function dissect(scriptSig: Buffer) {
  const chunks = bscript.decompile(scriptSig)!;
  const sigDer = chunks[0] as Buffer;
  const pubkey = chunks[1] as Buffer;
  const { signature, hashType } = bscript.signature.decode(sigDer);
  return { signature, hashType, pubkey, chunks };
}

describe('ZIP-243 sighash — independent cross-check + ECDSA verify', () => {
  it('CLAIM: signature validates against an independently-computed ZIP-243 sighash', () => {
    const built = buildClaimTx({
      terms: terms(), utxo, destination: DEST, net: 'mainnet',
      tipHeight: TIP, signer: signerOf(key), preimage: SECRET,
    });
    const tx = parse(built.hex);
    const redeem = htlcRedeemScript(terms());
    const expectedBranch = branchIdAtHeight('mainnet', TIP);

    // Wiring must be what we expect (else the network computes a different digest).
    expect(tx.version).toBe(4);
    expect(tx.overwintered).toBe(true);
    expect(tx.versionGroupId).toBe(VGID_SAPLING);
    expect(built.consensusBranchId).toBe(expectedBranch);

    // 1. Independent ZIP-243 digest vs @bitgo's digest on the SAME tx — must agree.
    //    NB: the consensus branch id is NOT serialized in a v4 tx, so a re-parsed tx
    //    defaults it to the library's newest-known branch (a real gotcha). We restore the
    //    branch the signer actually committed to before asking @bitgo to re-derive.
    tx._raw.consensusBranchId = expectedBranch;
    const mine = zip243SighashAll(tx, 0, redeem, utxo.valueZat, expectedBranch);
    const bitgo = tx._raw.hashForSignatureByNetwork(0, redeem, utxo.valueZat, 1);
    expect(mine.toString('hex')).toBe(bitgo.toString('hex'));

    // 2. ECDSA verify — exactly what OP_CHECKSIG does on the network.
    const { signature, hashType, pubkey, chunks } = dissect(tx.ins[0].script);
    expect(hashType).toBe(1);
    expect(ECPair.fromPublicKey(pubkey).verify(mine, signature)).toBe(true);

    // 3. Script conditions: preimage push hashes to the lock; pubkey hashes to claimant PKH.
    const preimage = chunks[2] as Buffer;
    expect(Buffer.from(sha256(preimage))).toEqual(HASHLOCK);
    expect(bcrypto.hash160(pubkey)).toEqual(pubkeyHash(Buffer.from(key.publicKey)));
    // IF-branch selector present.
    expect(chunks[chunks.length - 2]).toBe(utxolib.opcodes.OP_1);
    expect(chunks[chunks.length - 1]).toEqual(redeem);
  });

  it('REFUND: signature validates against an independently-computed ZIP-243 sighash', () => {
    const built = buildRefundTx({
      terms: terms(), utxo, destination: DEST, net: 'mainnet',
      tipHeight: TIMEOUT, signer: signerOf(otherKey),
    });
    const tx = parse(built.hex);
    const redeem = htlcRedeemScript(terms());
    const expectedBranch = branchIdAtHeight('mainnet', TIMEOUT);

    expect(tx.locktime).toBe(TIMEOUT);
    expect(tx.ins[0].sequence).toBeLessThan(0xffffffff);

    tx._raw.consensusBranchId = expectedBranch;
    const mine = zip243SighashAll(tx, 0, redeem, utxo.valueZat, expectedBranch);
    const bitgo = tx._raw.hashForSignatureByNetwork(0, redeem, utxo.valueZat, 1);
    expect(mine.toString('hex')).toBe(bitgo.toString('hex'));

    const { signature, pubkey, chunks } = dissect(tx.ins[0].script);
    expect(ECPair.fromPublicKey(pubkey).verify(mine, signature)).toBe(true);
    expect(bcrypto.hash160(pubkey)).toEqual(pubkeyHash(Buffer.from(otherKey.publicKey)));
    // ELSE-branch selector.
    expect(chunks[chunks.length - 2]).toBe(utxolib.opcodes.OP_0);
  });

  it('funding address = HASH160(redeemScript) — funds land in a script we can spend', () => {
    const addr = htlcAddress(terms(), 'mainnet');
    const fromAddr = utxolib.address.toOutputScript(addr, ZCASH);
    expect(fromAddr).toEqual(htlcOutputScript(terms(), 'mainnet'));
    // And the output script is OP_HASH160 <h160(redeem)> OP_EQUAL.
    const h160 = bcrypto.hash160(htlcRedeemScript(terms()));
    expect(htlcOutputScript(terms(), 'mainnet')).toEqual(
      bscript.compile([utxolib.opcodes.OP_HASH160, h160, utxolib.opcodes.OP_EQUAL]),
    );
  });

  it('a WRONG branch id would produce a different (network-rejected) sighash', () => {
    const built = buildClaimTx({
      terms: terms(), utxo, destination: DEST, net: 'mainnet',
      tipHeight: TIP, signer: signerOf(key), preimage: SECRET,
    });
    const tx = parse(built.hex);
    const redeem = htlcRedeemScript(terms());
    const right = zip243SighashAll(tx, 0, redeem, utxo.valueZat, branchIdAtHeight('mainnet', TIP));
    const wrong = zip243SighashAll(tx, 0, redeem, utxo.valueZat, 0x00000000);
    expect(right.toString('hex')).not.toBe(wrong.toString('hex'));
  });
});
