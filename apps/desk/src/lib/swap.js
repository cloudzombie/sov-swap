/**
 * Browser-side swap logic: the crypto the USER owns, plus the thin clients for the desk
 * API and the SOV chain.
 *
 * Everything secret is generated and kept HERE, in the user's browser — the desk never
 * sees the preimage until the user reveals it on-chain by claiming their XUS. What the
 * user must not lose (the secret, their XUS wallet seed, their ZEC refund key) is
 * persisted to localStorage and surfaced as recovery data, because losing it mid-swap is
 * the one way a user can be hurt.
 */
import { Buffer } from "buffer";
import { sha256 } from "@noble/hashes/sha256";
import { bytesToHex, hexToBytes, randomBytes } from "@noble/hashes/utils";
import * as secp from "@noble/secp256k1";
import { HybridKeypair, buildAndSign, toWireSignedTransaction, SovClient } from "@sov/sdk";

if (typeof globalThis.Buffer === "undefined") globalThis.Buffer = Buffer;

const LS_KEY = "sov-swap.active";

/** A fresh 32-byte secret and its SHA-256 hashlock (the value both chains lock against). */
export function newSecret() {
  const secret = randomBytes(32);
  return { secretHex: bytesToHex(secret), hashlock: bytesToHex(sha256(secret)) };
}

/** A fresh Zcash refund keypair — the key that can reclaim the ZEC if the swap fails.
 * Only the compressed pubkey goes to the desk; the private key stays with the user. */
export function newZecRefundKey() {
  const priv = secp.utils.randomPrivateKey();
  const pub = secp.getPublicKey(priv, true); // compressed
  return { zecPrivHex: bytesToHex(priv), zecRefundPubkey: bytesToHex(pub) };
}

/** A fresh XUS wallet (hybrid PQ). We mint the 32-byte seed ourselves so it is always
 * reconstructable — this is where the bought XUS lands and the key that claims it, so the
 * user must be able to keep and restore it. */
export function newXusWallet() {
  const seed = randomBytes(32);
  const kp = HybridKeypair.fromSeed(seed);
  return { xusSeedHex: bytesToHex(seed), account: kp.publicKey.accountId() };
}

/** Rebuild an XUS keypair from a saved seed. */
export function xusFromSeed(seedHex) {
  return HybridKeypair.fromSeed(hexToBytes(seedHex));
}

// ── desk API ───────────────────────────────────────────────────────────────
export function makeApi(base) {
  const b = base.replace(/\/$/, "");
  return {
    base: b,
    async quote() {
      return (await fetch(`${b}/api/quote`)).json();
    },
    async trades() {
      const r = await fetch(`${b}/api/trades`);
      return r.ok ? (await r.json()).trades ?? [] : [];
    },
    async createSwap(body) {
      const r = await fetch(`${b}/api/swap`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || "createSwap failed");
      return j;
    },
    async getSwap(id) {
      const r = await fetch(`${b}/api/swap/${id}`);
      if (!r.ok) return null;
      return r.json();
    },
    /** A SovClient that tunnels JSON-RPC through the coordinator's https passthrough. */
    sovClient() {
      return new SovClient({ endpoint: `${b}/api/sov` });
    },
  };
}

/**
 * Claim the XUS the desk locked, by revealing the secret. This is the user's single action
 * — it delivers their XUS AND publishes the preimage the desk needs to take the ZEC. Signed
 * with the user's own XUS key, in this browser.
 */
export async function claimXus(api, { deskXusHtlcId, secretHex, xusSeedHex, account }) {
  const client = api.sovClient();
  const kp = xusFromSeed(xusSeedHex);
  const nonce = await client.getNonce(account);
  const signed = buildAndSign({
    signer: account,
    keypair: kp,
    nonce,
    action: { type: "htlc_claim", htlc_id: deskXusHtlcId, preimage: Array.from(hexToBytes(secretHex)) },
  });
  return client.submitTransaction(toWireSignedTransaction(signed));
}

// ── local persistence of the in-flight swap (keys included — never leaves the browser) ──
export function saveActive(state) {
  localStorage.setItem(LS_KEY, JSON.stringify(state));
}
export function loadActive() {
  try {
    return JSON.parse(localStorage.getItem(LS_KEY) || "null");
  } catch {
    return null;
  }
}
export function clearActive() {
  localStorage.removeItem(LS_KEY);
}

// ── formatting helpers ───────────────────────────────────────────────────────
export const ZAT = 100_000_000;
export const GRAINS = 100_000_000n;
export function zatToZec(z) {
  return (z / ZAT).toLocaleString(undefined, { maximumFractionDigits: 8 });
}
export function grainsToXus(g) {
  return (Number(BigInt(g) / 1_000_000n) / 100).toLocaleString(undefined, { maximumFractionDigits: 8 });
}
export function shorten(s, n = 8) {
  return s && s.length > n * 2 ? `${s.slice(0, n)}…${s.slice(-n)}` : s;
}
