/**
 * Bitcoin HTLC leg — script parity with the ZEC leg, address encoding, claim/refund
 * builds, and an INDEPENDENT legacy-sighash verification: the test serializes the
 * spend for signing by hand (straight from the original Bitcoin sighash algorithm,
 * no shared code with the implementation) and checks the embedded ECDSA signature
 * against that digest. If the implementation's sighash drifted, this fails.
 */
import { describe, expect, it } from 'vitest';
import * as utxolib from '@bitgo/utxo-lib';
import { createHash } from 'node:crypto';
import {
  htlcRedeemScript,
  hashlockOf,
  parsePreimageFromScriptSig,
  type HtlcTerms,
} from '../src/htlc-script.js';
import { btcHtlcAddress, btcHtlcOutputScript, buildBtcClaimTx, buildBtcRefundTx } from '../src/bitcoin/htlc.js';
import { btcSpendFee, MIN_FEE_SAT, CLAIM_TX_VBYTES } from '../src/bitcoin/network.js';
import { htlcAddress as zecHtlcAddress } from '../src/zcash/htlc.js';

const { ECPair, script: bscript } = utxolib;

const sha256d = (b: Buffer) =>
  createHash('sha256').update(createHash('sha256').update(b).digest()).digest();

const claimant = ECPair.fromPrivateKey(Buffer.alloc(32, 7), { network: utxolib.networks.bitcoin });
const refunder = ECPair.fromPrivateKey(Buffer.alloc(32, 9), { network: utxolib.networks.bitcoin });
const preimage = Buffer.alloc(32, 0x42);

const terms: HtlcTerms = {
  hashlock: hashlockOf(preimage),
  claimantPubkey: Buffer.from(claimant.publicKey),
  refundPubkey: Buffer.from(refunder.publicKey),
  timeoutHeight: 905_000,
};
const utxo = { txid: 'aa'.repeat(32), vout: 1, valueZat: 250_000 };
const DEST = '1BitcoinEaterAddressDontSendf59kuE';

const signerOf = (pair: typeof claimant) => ({
  publicKey: Buffer.from(pair.publicKey),
  sign: (h: Buffer) => Buffer.from(pair.sign(h)),
});

/** Hand-rolled ORIGINAL Bitcoin sighash (SIGHASH_ALL, single input): serialize the tx
 * with the input's script replaced by the redeem script, append the hashtype, sha256d. */
function legacySighash(rawHex: string, redeemScript: Buffer, lockTime: number): Buffer {
  const tx = utxolib.bitgo.createTransactionFromBuffer(
    Buffer.from(rawHex, 'hex'),
    utxolib.networks.bitcoin,
    { amountType: 'number' },
  );
  const parts: Buffer[] = [];
  const u32 = (n: number) => {
    const b = Buffer.alloc(4);
    b.writeUInt32LE(n >>> 0);
    return b;
  };
  const u64 = (n: number) => {
    const b = Buffer.alloc(8);
    b.writeBigUInt64LE(BigInt(n));
    return b;
  };
  parts.push(u32(tx.version));
  parts.push(Buffer.from([tx.ins.length]));
  for (const inp of tx.ins) {
    parts.push(inp.hash as Buffer, u32(inp.index));
    parts.push(Buffer.from([redeemScript.length]), redeemScript);
    parts.push(u32(inp.sequence));
  }
  parts.push(Buffer.from([tx.outs.length]));
  for (const out of tx.outs) {
    parts.push(u64(out.value as number));
    parts.push(Buffer.from([out.script.length]), out.script as Buffer);
  }
  parts.push(u32(lockTime));
  parts.push(u32(0x01)); // SIGHASH_ALL
  return sha256d(Buffer.concat(parts));
}

describe('BTC HTLC script + address', () => {
  it('reuses the EXACT redeem script bytes of the ZEC leg (that is the atomicity)', () => {
    // Same terms → same script hash on both chains; only the address encoding differs.
    const btcAddr = btcHtlcAddress(terms, 'mainnet');
    const zecAddr = zecHtlcAddress(terms, 'mainnet');
    expect(btcAddr.startsWith('3')).toBe(true); // Bitcoin P2SH, base58 version 0x05
    expect(zecAddr.startsWith('t3')).toBe(true); // Zcash P2SH, two-byte version
    const decodedBtc = utxolib.address.fromBase58Check(btcAddr, utxolib.networks.bitcoin);
    const decodedZec = utxolib.address.fromBase58Check(zecAddr, utxolib.networks.zcash);
    expect(decodedBtc.hash.equals(decodedZec.hash)).toBe(true);
  });

  it('output script is the canonical P2SH form', () => {
    const spk = btcHtlcOutputScript(terms, 'mainnet');
    expect(spk.length).toBe(23); // OP_HASH160 <20> OP_EQUAL
    expect(spk[0]).toBe(utxolib.opcodes.OP_HASH160);
    expect(spk[22]).toBe(utxolib.opcodes.OP_EQUAL);
  });
});

describe('BTC claim spend', () => {
  const feeSat = btcSpendFee('claim', 4);
  const built = buildBtcClaimTx({
    terms,
    utxo,
    destination: DEST,
    net: 'mainnet',
    signer: signerOf(claimant),
    preimage,
    feeSat,
  });

  it('deducts its own fee from the claimed value', () => {
    expect(built.valueSat).toBe(utxo.valueZat - feeSat);
    expect(built.feeSat).toBe(feeSat);
  });

  it('puts the preimage on-chain where the counterparty can read it', () => {
    const tx = utxolib.bitgo.createTransactionFromBuffer(
      Buffer.from(built.hex, 'hex'),
      utxolib.networks.bitcoin,
      { amountType: 'number' },
    );
    const got = parsePreimageFromScriptSig(tx.ins[0].script as Buffer, terms.hashlock);
    expect(got?.equals(preimage)).toBe(true);
  });

  it('signature verifies against an INDEPENDENTLY computed legacy sighash', () => {
    const redeem = htlcRedeemScript(terms);
    const digest = legacySighash(built.hex, redeem, 0);
    const tx = utxolib.bitgo.createTransactionFromBuffer(
      Buffer.from(built.hex, 'hex'),
      utxolib.networks.bitcoin,
      { amountType: 'number' },
    );
    const chunks = bscript.decompile(tx.ins[0].script as Buffer)!;
    const { signature } = bscript.signature.decode(chunks[0] as Buffer);
    const ok = ECPair.fromPublicKey(Buffer.from(claimant.publicKey)).verify(digest, signature);
    expect(ok).toBe(true);
  });

  it('refuses a wrong preimage or a non-claimant signer', () => {
    expect(() =>
      buildBtcClaimTx({
        terms,
        utxo,
        destination: DEST,
        net: 'mainnet',
        signer: signerOf(claimant),
        preimage: Buffer.alloc(32, 0x43),
        feeSat,
      }),
    ).toThrow(/preimage/);
    expect(() =>
      buildBtcClaimTx({
        terms,
        utxo,
        destination: DEST,
        net: 'mainnet',
        signer: signerOf(refunder),
        preimage,
        feeSat,
      }),
    ).toThrow(/claimant/);
  });
});

describe('BTC refund spend', () => {
  it('refuses to build before the timeout, builds after with nLockTime = timeout', () => {
    const feeSat = btcSpendFee('refund', 4);
    expect(() =>
      buildBtcRefundTx({
        terms,
        utxo,
        destination: DEST,
        net: 'mainnet',
        signer: signerOf(refunder),
        feeSat,
        tipHeight: terms.timeoutHeight - 1,
      }),
    ).toThrow(/not timed out/);

    const built = buildBtcRefundTx({
      terms,
      utxo,
      destination: DEST,
      net: 'mainnet',
      signer: signerOf(refunder),
      feeSat,
      tipHeight: terms.timeoutHeight,
    });
    const tx = utxolib.bitgo.createTransactionFromBuffer(
      Buffer.from(built.hex, 'hex'),
      utxolib.networks.bitcoin,
      { amountType: 'number' },
    );
    expect(tx.locktime).toBe(terms.timeoutHeight);
    // Sequence must be non-final for CLTV to be enforceable.
    expect(tx.ins[0].sequence).toBeLessThan(0xffffffff);
    // Refund signature verifies against the independent digest too.
    const digest = legacySighash(built.hex, htlcRedeemScript(terms), terms.timeoutHeight);
    const chunks = bscript.decompile(tx.ins[0].script as Buffer)!;
    const { signature } = bscript.signature.decode(chunks[0] as Buffer);
    expect(ECPair.fromPublicKey(Buffer.from(refunder.publicKey)).verify(digest, signature)).toBe(true);
  });
});

describe('BTC fee policy', () => {
  it('floors, scales by size, and caps garbage rates', () => {
    expect(btcSpendFee('claim', 0)).toBe(MIN_FEE_SAT);
    expect(btcSpendFee('claim', NaN)).toBe(MIN_FEE_SAT);
    expect(btcSpendFee('claim', 10)).toBe(10 * CLAIM_TX_VBYTES);
    expect(btcSpendFee('claim', 1e9)).toBeLessThanOrEqual(500 * CLAIM_TX_VBYTES);
  });
});
