/**
 * Deterministic tests for the Zcash HTLC leg. No network — these prove the script
 * assembly, address derivation, spend construction and preimage recovery are correct
 * before a single zatoshi is put at risk.
 */
import { describe, it, expect } from 'vitest';
import * as utxolib from '@bitgo/utxo-lib';
import { sha256 } from '@noble/hashes/sha256';
import {
  buildClaimTx,
  buildRefundTx,
  hashlockOf,
  htlcAddress,
  htlcOutputScript,
  htlcRedeemScript,
  parsePreimageFromScriptSig,
  pubkeyHash,
  type HtlcTerms,
} from '../src/zcash/htlc.js';
import { branchIdAtHeight, zip317Fee, MAINNET_UPGRADES } from '../src/zcash/network.js';

const { opcodes, script: bscript, ECPair } = utxolib;

// Fixed keys so every assertion below is reproducible.
const claimant = ECPair.fromPrivateKey(Buffer.alloc(32, 0x11));
const refunder = ECPair.fromPrivateKey(Buffer.alloc(32, 0x22));
const stranger = ECPair.fromPrivateKey(Buffer.alloc(32, 0x33));

const SECRET = Buffer.alloc(32, 0xab);
const HASHLOCK = Buffer.from(sha256(SECRET));
const TIMEOUT = 2_500_000;

function terms(over: Partial<HtlcTerms> = {}): HtlcTerms {
  return {
    hashlock: HASHLOCK,
    claimantPubkey: Buffer.from(claimant.publicKey),
    refundPubkey: Buffer.from(refunder.publicKey),
    timeoutHeight: TIMEOUT,
    ...over,
  };
}

function signerOf(pair: typeof claimant) {
  return {
    publicKey: Buffer.from(pair.publicKey),
    sign: (h: Buffer) => Buffer.from(pair.sign(h)),
  };
}

const utxo = { txid: 'a'.repeat(64), vout: 0, valueZat: 10_000_000 }; // 0.1 ZEC

describe('hashlock', () => {
  it('is a single SHA-256 of the raw preimage — the cross-chain contract', () => {
    // This exact equality is what makes the swap atomic: Zcash's OP_SHA256 and the SOV
    // chain's `sha256(preimage) == hashlock` must agree byte-for-byte. Not double-SHA,
    // not HASH160.
    expect(hashlockOf(SECRET)).toEqual(Buffer.from(sha256(SECRET)));
    expect(hashlockOf(SECRET).length).toBe(32);
  });
});

describe('redeem script', () => {
  it('encodes both spend paths in the canonical HTLC shape', () => {
    const chunks = bscript.decompile(htlcRedeemScript(terms()))!;
    expect(chunks[0]).toBe(opcodes.OP_IF);
    expect(chunks[1]).toBe(opcodes.OP_SHA256);
    expect(chunks[2]).toEqual(HASHLOCK);
    expect(chunks[3]).toBe(opcodes.OP_EQUALVERIFY);
    expect(chunks[6]).toEqual(pubkeyHash(Buffer.from(claimant.publicKey)));
    expect(chunks[7]).toBe(opcodes.OP_ELSE);
    expect(chunks[8]).toEqual(bscript.number.encode(TIMEOUT));
    expect(chunks[9]).toBe(opcodes.OP_CHECKLOCKTIMEVERIFY);
    expect(chunks[10]).toBe(opcodes.OP_DROP);
    expect(chunks[13]).toEqual(pubkeyHash(Buffer.from(refunder.publicKey)));
    expect(chunks[14]).toBe(opcodes.OP_ENDIF);
    expect(chunks[15]).toBe(opcodes.OP_EQUALVERIFY);
    expect(chunks[16]).toBe(opcodes.OP_CHECKSIG);
  });

  it('is deterministic — both parties derive the identical script from the same terms', () => {
    // The counterparty must be able to recompute the escrow independently; if this were
    // not stable, neither side could verify what the other funded.
    expect(htlcRedeemScript(terms())).toEqual(htlcRedeemScript(terms()));
  });

  it('changes if any term changes', () => {
    const base = htlcRedeemScript(terms());
    expect(htlcRedeemScript(terms({ timeoutHeight: TIMEOUT + 1 }))).not.toEqual(base);
    expect(htlcRedeemScript(terms({ hashlock: Buffer.alloc(32, 0xcd) }))).not.toEqual(base);
    expect(
      htlcRedeemScript(terms({ claimantPubkey: Buffer.from(stranger.publicKey) })),
    ).not.toEqual(base);
  });

  it('rejects malformed terms rather than producing an unspendable escrow', () => {
    expect(() => htlcRedeemScript(terms({ hashlock: Buffer.alloc(31) }))).toThrow(/32 bytes/);
    expect(() => htlcRedeemScript(terms({ claimantPubkey: Buffer.alloc(65, 0x04) }))).toThrow(
      /compressed/,
    );
    expect(() => htlcRedeemScript(terms({ timeoutHeight: 0 }))).toThrow(/positive integer/);
    // A "height" past 500e6 is read by consensus as a unix timestamp — a classic footgun
    // that would make the refund path behave nothing like intended.
    expect(() => htlcRedeemScript(terms({ timeoutHeight: 500_000_001 }))).toThrow(/timestamp/);
  });
});

describe('address derivation', () => {
  it('derives a mainnet t3 P2SH address', () => {
    const addr = htlcAddress(terms(), 'mainnet');
    expect(addr.startsWith('t3')).toBe(true);
  });

  it('round-trips to the HTLC output script — funds land where we think they do', () => {
    // The address we publish and the script we later spend MUST be the same escrow.
    // Zcash's two-byte version prefix is where a naive bitcoin encoder goes wrong, so
    // this pins the encoding end-to-end rather than trusting the prefix by eye.
    const addr = htlcAddress(terms(), 'mainnet');
    const fromAddr = utxolib.address.toOutputScript(addr, utxolib.networks.zcash);
    expect(fromAddr).toEqual(htlcOutputScript(terms(), 'mainnet'));
  });
});

describe('consensus branch id', () => {
  it('selects the newest upgrade active at the height', () => {
    const nu62 = MAINNET_UPGRADES.find((u) => u.name === 'NU6.2')!;
    const nu63 = MAINNET_UPGRADES.find((u) => u.name === 'NU6.3')!;
    expect(branchIdAtHeight('mainnet', nu62.activationHeight)).toBe(nu62.branchId);
    expect(branchIdAtHeight('mainnet', nu63.activationHeight - 1)).toBe(nu62.branchId);
    // NU6.3 activates 2026-07-28; a stale branch id here means every tx we sign is
    // silently unbroadcastable, so this boundary is the one to keep honest.
    expect(branchIdAtHeight('mainnet', nu63.activationHeight)).toBe(nu63.branchId);
    expect(branchIdAtHeight('mainnet', nu63.activationHeight + 10_000)).toBe(nu63.branchId);
  });

  it('throws below the oldest known upgrade instead of guessing', () => {
    expect(() => branchIdAtHeight('mainnet', 1)).toThrow(/no known Zcash consensus branch id/);
  });
});

describe('ZIP-317 fee', () => {
  it('charges the 2-action minimum for a simple 1-in/1-out sweep', () => {
    expect(zip317Fee(1, 1)).toBe(10_000); // 0.0001 ZEC
  });
});

describe('claim spend', () => {
  const opts = {
    terms: terms(),
    utxo,
    destination: 't1U7Qt5ULyXuTxoUrTHjNsPLTaYpuDGhujW',
    net: 'mainnet' as const,
    tipHeight: 3_400_000,
    signer: signerOf(claimant),
    preimage: SECRET,
  };

  it('builds a broadcastable tx that deducts its own fee from the claimed value', () => {
    const built = buildClaimTx(opts);
    expect(built.hex).toMatch(/^[0-9a-f]+$/);
    expect(built.txid).toHaveLength(64);
    // Zero pre-funded ZEC: the claim pays for itself out of the money it sweeps.
    expect(built.feeZat).toBe(10_000);
    expect(built.valueZat).toBe(utxo.valueZat - 10_000);
  });

  it('binds the signature to the branch id in force at the tip', () => {
    const nu63 = MAINNET_UPGRADES.find((u) => u.name === 'NU6.3')!;
    expect(buildClaimTx(opts).consensusBranchId).toBe(0x5437f330); // NU6.2 at 3.4M
    const after = buildClaimTx({ ...opts, tipHeight: nu63.activationHeight });
    expect(after.consensusBranchId).toBe(nu63.branchId);
    // Different branch id ⇒ different sighash ⇒ genuinely different signed tx.
    expect(after.hex).not.toBe(buildClaimTx(opts).hex);
  });

  it('puts the preimage on-chain where the counterparty can read it', () => {
    const built = buildClaimTx(opts);
    const tx = utxolib.bitgo.createTransactionFromBuffer(
      Buffer.from(built.hex, 'hex'),
      utxolib.networks.zcash,
      { amountType: 'number' },
    );
    const recovered = parsePreimageFromScriptSig(tx.ins[0].script, HASHLOCK);
    expect(recovered).toEqual(SECRET);
  });

  it('refuses a preimage that does not match the hashlock', () => {
    expect(() => buildClaimTx({ ...opts, preimage: Buffer.alloc(32, 0xff) })).toThrow(
      /does not hash to this HTLC/,
    );
  });

  it('refuses to sign for anyone but the claimant', () => {
    expect(() => buildClaimTx({ ...opts, signer: signerOf(stranger) })).toThrow(
      /not the claimant/,
    );
  });

  it('refuses a utxo too small to cover its own fee', () => {
    expect(() => buildClaimTx({ ...opts, utxo: { ...utxo, valueZat: 5_000 } })).toThrow(
      /does not cover/,
    );
  });
});

describe('refund spend', () => {
  const opts = {
    terms: terms(),
    utxo,
    destination: 't1U7Qt5ULyXuTxoUrTHjNsPLTaYpuDGhujW',
    net: 'mainnet' as const,
    tipHeight: TIMEOUT,
    signer: signerOf(refunder),
  };

  it('builds once the timeout is reached, with nLockTime at the timeout', () => {
    const built = buildRefundTx(opts);
    const tx = utxolib.bitgo.createTransactionFromBuffer(
      Buffer.from(built.hex, 'hex'),
      utxolib.networks.zcash,
      { amountType: 'number' },
    );
    // CLTV compares against nLockTime, and requires a non-final sequence to be enforced
    // at all — both must hold or the refund silently isn't a refund.
    expect(tx.locktime).toBe(TIMEOUT);
    expect(tx.ins[0].sequence).toBeLessThan(0xffffffff);
  });

  it('refuses before the timeout — the money is not ours to take yet', () => {
    expect(() => buildRefundTx({ ...opts, tipHeight: TIMEOUT - 1 })).toThrow(/has not timed out/);
  });

  it('refuses to sign for anyone but the refund party', () => {
    expect(() => buildRefundTx({ ...opts, signer: signerOf(claimant) })).toThrow(
      /not the refund party/,
    );
  });

  it('takes the ELSE branch and reveals no preimage', () => {
    const built = buildRefundTx(opts);
    const tx = utxolib.bitgo.createTransactionFromBuffer(
      Buffer.from(built.hex, 'hex'),
      utxolib.networks.zcash,
      { amountType: 'number' },
    );
    expect(parsePreimageFromScriptSig(tx.ins[0].script, HASHLOCK)).toBeNull();
  });
});

describe('preimage recovery', () => {
  it('ignores junk and non-matching pushes', () => {
    expect(parsePreimageFromScriptSig(Buffer.from('deadbeef', 'hex'), HASHLOCK)).toBeNull();
    const decoy = bscript.compile([Buffer.alloc(32, 0x01), Buffer.alloc(32, 0x02)]);
    expect(parsePreimageFromScriptSig(decoy, HASHLOCK)).toBeNull();
  });

  it('verifies against the hashlock rather than trusting push position', () => {
    // A hostile claim could pad extra pushes; we must still find the real secret.
    const padded = bscript.compile([Buffer.alloc(10, 0x09), SECRET, Buffer.alloc(5, 0x08)]);
    expect(parsePreimageFromScriptSig(padded, HASHLOCK)).toEqual(SECRET);
  });
});
