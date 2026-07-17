/**
 * SOV/XUS HTLC leg — the XUS half of an XUS↔ZEC atomic swap.
 *
 * Unlike Zcash, SOV has native HTLC actions (`htlc_lock` / `htlc_claim` / `htlc_refund`),
 * so this is a thin, honest wrapper over `@sov/sdk`: build the action, sign it (default
 * hybrid Ed25519+ML-DSA-65), submit it, and read escrow state back over JSON-RPC.
 *
 * The one contract that makes it interoperate with the Zcash leg: the `hashlock` is the
 * SINGLE SHA-256 of the raw secret — the same 32 bytes the Zcash `OP_SHA256` path locks
 * against — and `htlc_claim.preimage` is the raw secret bytes, which the node verifies as
 * `sha256(preimage) == hashlock`.
 */
import {
  buildAndSign,
  toWireSignedTransaction,
  SovClient,
  type HybridKeypair,
} from '@sov/sdk';
import { sha256 } from '@noble/hashes/sha256';

/**
 * The desk signs with the chain's default HYBRID scheme (Ed25519 + ML-DSA-65) — the
 * post-quantum signature every real SOV account uses. `accountId()` lives on the hybrid
 * public key.
 */
type AnyKeypair = HybridKeypair;

/** The `htlc_id` on SOV is the tx-id of the `htlc_lock` transaction (0x-hex). */
export type HtlcId = string;

/** Escrow state as returned by `sov_getHtlc`. */
export interface SovHtlcState {
  locker: string;
  recipient: string;
  /** Amount in grains (1e-8 XUS). */
  amountGrains: bigint;
  /** 32-byte SHA-256 hashlock, hex (no 0x). */
  hashlock: string;
  timeoutHeight: number;
}

/** Result of submitting a SOV transaction. */
export interface SovSubmitResult {
  txId: string;
  accepted: boolean;
}

/** Hex (with or without 0x) → the raw byte array `htlc_claim.preimage` expects. */
function toPreimageBytes(preimage: Uint8Array): number[] {
  return Array.from(preimage);
}

function hex(buf: Uint8Array | Buffer): string {
  return Buffer.from(buf).toString('hex');
}

/**
 * Lock XUS into an HTLC for `recipient`, redeemable with the secret behind `hashlock`
 * until `timeoutHeight`, after which the locker may refund. Returns the submit result;
 * the `txId` IS the `htlc_id` used to claim/refund/query.
 *
 * On the desk this is the MARKET-MAKER's leg: it locks the seeded XUS the user will
 * claim. It is deliberately the shorter-timeout (responder) side of the swap — see
 * `protocol.ts` for why that protects the seeded inventory.
 */
export async function lockXus(
  client: SovClient,
  keypair: AnyKeypair,
  params: {
    recipient: string;
    amountGrains: bigint;
    hashlock: Uint8Array | Buffer;
    timeoutHeight: number;
    /** Explicit nonce; if omitted, fetched from the chain. Pass it when submitting several
     * txs from the same account in one tick so their nonces don't collide. */
    nonce?: number;
  },
): Promise<SovSubmitResult> {
  const hl = Buffer.from(params.hashlock);
  if (hl.length !== 32) throw new Error(`hashlock must be 32 bytes, got ${hl.length}`);
  if (!Number.isInteger(params.timeoutHeight) || params.timeoutHeight <= 0) {
    throw new Error(`timeoutHeight must be a positive height, got ${params.timeoutHeight}`);
  }
  const signer = keypair.publicKey.accountId();
  const nonce = params.nonce ?? (await client.getNonce(signer));
  const signed = buildAndSign({
    signer,
    keypair,
    nonce,
    action: {
      type: 'htlc_lock',
      recipient: params.recipient,
      // The chain's amount is a GrainString — grains as an INTEGER string (e.g.
      // "100000000" for 1 XUS), NOT a decimal. The SDK validates it with BigInt(), which
      // throws on a decimal like "1.00000000".
      amount: params.amountGrains.toString(),
      hashlock: hex(hl),
      timeout_height: params.timeoutHeight,
    },
  });
  const wire = toWireSignedTransaction(signed);
  // As of the SOV v0.1.86 node, `htlc_lock.hashlock` is a Hash — its JSON serde is HEX,
  // consistent with every other 32-byte field. The SDK already builds + Borsh-signs the
  // action from the hex string, so the wire form carries hex and the node accepts it
  // directly. (Pre-v0.1.86 nodes wanted a `[u8;32]` array here; that workaround is gone
  // now that the whole mainnet fleet is v0.1.86.)
  const res = await client.submitTransaction(wire);
  return { txId: res.txId ?? signed.id, accepted: res.accepted };
}

/**
 * Claim an XUS HTLC by revealing `preimage`. This publishes the secret on the SOV chain,
 * which is exactly how the counterparty learns it to finish the ZEC leg.
 *
 * On the desk this is the USER's action — it's how they receive their XUS — and it is
 * what arms the desk to sweep the user's ZEC.
 */
export async function claimXus(
  client: SovClient,
  keypair: AnyKeypair,
  params: { htlcId: HtlcId; preimage: Uint8Array },
): Promise<SovSubmitResult> {
  const signer = keypair.publicKey.accountId();
  const nonce = await client.getNonce(signer);
  const signed = buildAndSign({
    signer,
    keypair,
    nonce,
    action: {
      type: 'htlc_claim',
      htlc_id: params.htlcId,
      preimage: toPreimageBytes(params.preimage),
    },
  });
  const res = await client.submitTransaction(toWireSignedTransaction(signed));
  return { txId: res.txId ?? signed.id, accepted: res.accepted };
}

/** Refund an XUS HTLC back to its locker, valid only once the chain passes its timeout. */
export async function refundXus(
  client: SovClient,
  keypair: AnyKeypair,
  params: { htlcId: HtlcId },
): Promise<SovSubmitResult> {
  const signer = keypair.publicKey.accountId();
  const nonce = await client.getNonce(signer);
  const signed = buildAndSign({
    signer,
    keypair,
    nonce,
    action: { type: 'htlc_refund', htlc_id: params.htlcId },
  });
  const res = await client.submitTransaction(toWireSignedTransaction(signed));
  return { txId: res.txId ?? signed.id, accepted: res.accepted };
}

/** Raw `sov_getHtlc` response shape (camelCase per the node's JSON). */
interface RawHtlc {
  locker: string;
  recipient: string;
  amount: string;
  hashlock: string;
  timeoutHeight: number;
}

/**
 * Read an HTLC's escrow state, or `null` if it doesn't exist / was already
 * settled (claimed or refunded). The desk polls this to observe its own lock and to
 * detect the user's claim (the escrow vanishes once claimed).
 */
export async function getHtlc(client: SovClient, htlcId: HtlcId): Promise<SovHtlcState | null> {
  const raw = await client.call<RawHtlc | null>('sov_getHtlc', { hash: htlcId });
  if (!raw) return null;
  return {
    locker: raw.locker,
    recipient: raw.recipient,
    amountGrains: BigInt(raw.amount),
    hashlock: raw.hashlock.replace(/^0x/, ''),
    timeoutHeight: raw.timeoutHeight,
  };
}

/**
 * Send a plain XUS transfer. Used to **bootstrap the recipient's claim fee**: a fresh
 * (0-balance) account cannot pay the network fee an `htlc_claim` costs, so the desk seeds
 * it a small amount before/with locking. Returns the submit result.
 */
export async function transferXus(
  client: SovClient,
  keypair: AnyKeypair,
  params: { to: string; amountGrains: bigint; nonce?: number },
): Promise<SovSubmitResult> {
  const signer = keypair.publicKey.accountId();
  const nonce = params.nonce ?? (await client.getNonce(signer));
  const signed = buildAndSign({
    signer,
    keypair,
    nonce,
    action: { type: 'transfer', to: params.to, amount: params.amountGrains.toString() },
  });
  const res = await client.submitTransaction(toWireSignedTransaction(signed));
  return { txId: res.txId ?? signed.id, accepted: res.accepted };
}

/** Current SOV chain height — used to set/relate timeouts. */
export async function sovHeight(client: SovClient): Promise<number> {
  return client.getHeight();
}

/**
 * Scan SOV blocks in `[fromHeight, toHeight]` for the `htlc_claim` that settled `htlcId`,
 * and return its revealed preimage (hex) — verified to actually hash to `expectedHashlock`
 * so a malformed/decoy claim can't spoof it.
 *
 * This is how the desk learns the secret the TRUSTLESS way: when the user claims their
 * XUS, the preimage is published in that transaction. The desk reads it straight off the
 * chain (not from the user's cooperation) and uses it to sweep the ZEC — so even a user
 * who claims and vanishes cannot strand the desk's counter-leg.
 */
export async function findRevealedPreimage(
  client: SovClient,
  params: { htlcId: HtlcId; expectedHashlock: string; fromHeight: number; toHeight: number },
): Promise<Uint8Array | null> {
  const want = params.expectedHashlock.replace(/^0x/, '').toLowerCase();
  const wantId = params.htlcId.toLowerCase();
  for (let h = params.fromHeight; h <= params.toHeight; h++) {
    const block = await client.getBlockByHeight(h);
    if (!block) continue;
    for (const stx of block.transactions) {
      const action = stx.transaction.action;
      if (action.type !== 'htlc_claim') continue;
      if (action.htlc_id.replace(/^0x/, '').toLowerCase() !== wantId.replace(/^0x/, '')) continue;
      const preimage = Uint8Array.from(action.preimage as ArrayLike<number>);
      if (hex(sha256(preimage)) === want) return preimage;
    }
  }
  return null;
}
