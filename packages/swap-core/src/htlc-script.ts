/**
 * The chain-agnostic HTLC script — shared by every UTXO leg (Zcash, Bitcoin).
 *
 * The redeem script is BYTE-IDENTICAL on both chains; that is the point of the swap.
 * Both are Bitcoin-Script chains with the same opcodes, and the hashlock is a single
 * SHA-256 of the raw secret — exactly what `OP_SHA256` computes on either chain and
 * exactly what the SOV runtime's `HtlcClaim` verifies (`sha256(preimage) == hashlock`).
 * What differs per chain is only the ENVELOPE: address encoding, sighash algorithm,
 * transaction format, and fee policy — those live in `zcash/htlc.ts` / `bitcoin/htlc.ts`.
 *
 * The redeem script:
 *
 *   OP_IF
 *     OP_SHA256 <hashlock> OP_EQUALVERIFY
 *     OP_DUP OP_HASH160 <claimantPubkeyHash>
 *   OP_ELSE
 *     <timeoutHeight> OP_CHECKLOCKTIMEVERIFY OP_DROP
 *     OP_DUP OP_HASH160 <refundPubkeyHash>
 *   OP_ENDIF
 *   OP_EQUALVERIFY
 *   OP_CHECKSIG
 *
 * Spends:
 *   claim  scriptSig = <sig> <pubkey> <preimage> OP_1 <redeemScript>
 *   refund scriptSig = <sig> <pubkey> OP_0        <redeemScript>
 */
import * as utxolib from '@bitgo/utxo-lib';
import { sha256 } from '@noble/hashes/sha256';

const { opcodes, script: bscript, crypto: bcrypto } = utxolib;

/** `Transaction.SIGHASH_ALL` — we always commit to every input and output. */
export const SIGHASH_ALL = 0x01;

/**
 * Sequence for a CLTV-spending input. `OP_CHECKLOCKTIMEVERIFY` is a no-op unless the
 * input's sequence is below 0xffffffff (BIP-65), so a final-sequence input would make
 * the refund path unspendable. We use the same value for both paths for uniformity.
 */
export const SEQUENCE_CLTV = 0xfffffffe;

export interface HtlcTerms {
  /** 32-byte SHA-256 digest of the secret. Identical on both chains. */
  hashlock: Buffer;
  /** Compressed (33-byte) pubkey that may spend via the preimage path. */
  claimantPubkey: Buffer;
  /** Compressed (33-byte) pubkey that may reclaim after the timeout. */
  refundPubkey: Buffer;
  /** Absolute block height (on the HTLC's own chain) at/after which refund opens. */
  timeoutHeight: number;
}

export function assertTerms(t: HtlcTerms): void {
  if (t.hashlock.length !== 32) {
    throw new Error(`hashlock must be 32 bytes (SHA-256), got ${t.hashlock.length}`);
  }
  for (const [name, pk] of [
    ['claimantPubkey', t.claimantPubkey],
    ['refundPubkey', t.refundPubkey],
  ] as const) {
    if (pk.length !== 33 || (pk[0] !== 0x02 && pk[0] !== 0x03)) {
      throw new Error(`${name} must be a 33-byte compressed pubkey`);
    }
  }
  if (!Number.isInteger(t.timeoutHeight) || t.timeoutHeight <= 0) {
    throw new Error(`timeoutHeight must be a positive integer height, got ${t.timeoutHeight}`);
  }
  // CLTV compares against nLockTime, whose semantics flip at 500e6 (height vs unix time).
  // A height at/above that would be interpreted as a timestamp — never what we mean.
  if (t.timeoutHeight >= 500_000_000) {
    throw new Error(`timeoutHeight ${t.timeoutHeight} would be read as a unix timestamp, not a height`);
  }
}

/** HASH160 (RIPEMD160∘SHA256) of a pubkey — what the script compares against. */
export function pubkeyHash(pubkey: Buffer): Buffer {
  return bcrypto.hash160(pubkey);
}

/** Single SHA-256 — the hashlock primitive, shared byte-for-byte with the SOV chain. */
export function hashlockOf(preimage: Buffer): Buffer {
  return Buffer.from(sha256(preimage));
}

/** Build the HTLC redeem script for `terms`. Identical bytes on every UTXO chain. */
export function htlcRedeemScript(terms: HtlcTerms): Buffer {
  assertTerms(terms);
  return bscript.compile([
    opcodes.OP_IF,
    opcodes.OP_SHA256,
    terms.hashlock,
    opcodes.OP_EQUALVERIFY,
    opcodes.OP_DUP,
    opcodes.OP_HASH160,
    pubkeyHash(terms.claimantPubkey),
    opcodes.OP_ELSE,
    bscript.number.encode(terms.timeoutHeight),
    opcodes.OP_CHECKLOCKTIMEVERIFY,
    opcodes.OP_DROP,
    opcodes.OP_DUP,
    opcodes.OP_HASH160,
    pubkeyHash(terms.refundPubkey),
    opcodes.OP_ENDIF,
    opcodes.OP_EQUALVERIFY,
    opcodes.OP_CHECKSIG,
  ]);
}

/** The scriptPubKey of the HTLC output: OP_HASH160 <scriptHash> OP_EQUAL. */
export function htlcP2shOutputScript(terms: HtlcTerms): Buffer {
  return bscript.compile([
    opcodes.OP_HASH160,
    bcrypto.hash160(htlcRedeemScript(terms)),
    opcodes.OP_EQUAL,
  ]);
}

/** Something that can sign a 32-byte sighash — an ECPair, or a remote signer. */
export interface Signer {
  publicKey: Buffer;
  sign(hash: Buffer): Buffer;
}

/**
 * Recover the preimage from a claim transaction's scriptSig.
 *
 * This is how the desk finishes its side: it watches for the counterparty's claim, reads
 * the secret straight off the chain, and uses it on the other chain. The claim scriptSig
 * is `<sig> <pubkey> <preimage> OP_1 <redeemScript>`, so the preimage is the third push;
 * we verify it against the expected hashlock rather than trusting position alone.
 */
export function parsePreimageFromScriptSig(
  scriptSig: Buffer,
  expectedHashlock: Buffer,
): Buffer | null {
  let chunks: Array<Buffer | number> | null;
  try {
    chunks = bscript.decompile(scriptSig);
  } catch {
    return null;
  }
  if (!chunks) return null;
  for (const chunk of chunks) {
    if (Buffer.isBuffer(chunk) && hashlockOf(chunk).equals(expectedHashlock)) {
      return chunk;
    }
  }
  return null;
}
