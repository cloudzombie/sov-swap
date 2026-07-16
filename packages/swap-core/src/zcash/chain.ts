/**
 * Zcash chain access via public REST infrastructure — no self-hosted node.
 *
 * The desk needs four things from the Zcash chain and nothing more:
 *   1. the tip height          (to pick the consensus branch id + set expiry)
 *   2. UTXOs at an address     (to see the user fund the HTLC, and to spend it)
 *   3. broadcast a raw tx      (to sweep the HTLC)
 *   4. a transaction's inputs  (to read a revealed preimage off a claim)
 *
 * All four are behind one `ZcashChain` interface so the coordinator can be driven by a
 * fake in tests without touching the network. Production access is mainnet-only through
 * Blockchair.
 */
import * as utxolib from '@bitgo/utxo-lib';
import type { ZcashNet } from './network.js';

/** An unspent output at an address. */
export interface Utxo {
  txid: string;
  vout: number;
  valueZat: number;
  /** Confirmations; 0 = still in the mempool. */
  confirmations: number;
}

/** A decoded transaction input (we only need the scriptSig, to read a preimage). */
export interface TxInput {
  /** scriptSig bytes. */
  script: Buffer;
}

export interface ZcashChain {
  readonly net: ZcashNet;
  /** Current chain tip height. */
  tipHeight(): Promise<number>;
  /** Unspent outputs at `address` (P2SH HTLC or a plain t-address). */
  utxos(address: string): Promise<Utxo[]>;
  /** Broadcast a raw transaction; resolves to its txid. */
  broadcast(rawHex: string): Promise<string>;
  /** The inputs of `txid`, for reading a revealed preimage from a claim scriptSig. */
  txInputs(txid: string): Promise<TxInput[]>;
}

export class ZcashChainError extends Error {
  constructor(
    message: string,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'ZcashChainError';
  }
}

async function getJson(url: string, init?: RequestInit): Promise<any> {
  let res: Response;
  try {
    res = await fetch(url, init);
  } catch (e) {
    throw new ZcashChainError(`request to ${url} failed`, e);
  }
  const text = await res.text();
  if (!res.ok) {
    throw new ZcashChainError(`${url} → HTTP ${res.status}: ${text.slice(0, 200)}`);
  }
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new ZcashChainError(`${url} returned non-JSON: ${text.slice(0, 200)}`, e);
  }
}

/**
 * Blockchair Zcash REST adapter — the researched primary for MAINNET watch/broadcast:
 * one provider covers UTXOs, confirmations, raw-tx fetch (for preimage parsing) and
 * push. Free tier ~30 req/min; pass an `apiKey` for commercial headroom.
 *
 * Docs: https://blockchair.com/api/docs
 */
export class BlockchairZcash implements ZcashChain {
  readonly net: ZcashNet;
  private readonly base: string;
  private readonly apiKey?: string;
  /** Cache the tip so repeated quotes/ticks don't hammer the provider (a keyless
   * Blockchair IP is blacklisted at ~30 req/min). ZEC blocks are ~75s, so a ~45s cache
   * costs at most one stale block and turns N callers into ≤1 request/45s. */
  private tipCache: { h: number; ts: number } | null = null;
  private static readonly TIP_TTL_MS = 45_000;

  constructor(opts: { net: ZcashNet; apiKey?: string; baseUrl?: string }) {
    if (opts.net !== 'mainnet') {
      throw new ZcashChainError('BlockchairZcash supports mainnet only');
    }
    this.net = opts.net;
    this.base = opts.baseUrl ?? 'https://api.blockchair.com/zcash';
    this.apiKey = opts.apiKey;
  }

  private key(sep: '?' | '&' = '?'): string {
    return this.apiKey ? `${sep}key=${this.apiKey}` : '';
  }

  async tipHeight(): Promise<number> {
    const now = Date.now();
    if (this.tipCache && now - this.tipCache.ts < BlockchairZcash.TIP_TTL_MS) {
      return this.tipCache.h;
    }
    let j: any;
    try {
      j = await getJson(`${this.base}/stats${this.key()}`);
    } catch (e) {
      // On a provider throttle (HTTP 430) fall back to the last good tip rather than
      // failing the whole quote; only surface an error if we've never had one.
      if (this.tipCache) return this.tipCache.h;
      const msg = String((e as Error).message);
      if (msg.includes('430') || /blacklist|API resources/i.test(msg)) {
        throw new ZcashChainError(
          'Zcash chain data is rate-limited by the provider. Set a BLOCKCHAIR_API_KEY, or retry shortly.',
        );
      }
      throw e;
    }
    const h = j?.data?.best_block_height;
    if (typeof h !== 'number') throw new ZcashChainError('blockchair stats missing best_block_height');
    this.tipCache = { h, ts: now };
    return h;
  }

  async utxos(address: string): Promise<Utxo[]> {
    const j = await getJson(`${this.base}/dashboards/address/${address}${this.key()}`);
    const entry = j?.data?.[address];
    const utxoList = entry?.utxo;
    const tip: number = j?.context?.state ?? (await this.tipHeight());
    if (!Array.isArray(utxoList)) return [];
    return utxoList.map((u: any) => ({
      txid: u.transaction_hash,
      vout: u.index,
      valueZat: u.value,
      // Blockchair reports the block the utxo was created in; confirmations = tip - block + 1.
      confirmations: u.block_id > 0 ? Math.max(0, tip - u.block_id + 1) : 0,
    }));
  }

  async broadcast(rawHex: string): Promise<string> {
    const j = await getJson(`${this.base}/push/transaction${this.key()}`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: `data=${rawHex}`,
    });
    const txid = j?.data?.transaction_hash;
    if (!txid) throw new ZcashChainError(`broadcast returned no txid: ${JSON.stringify(j).slice(0, 200)}`);
    return txid;
  }

  async txInputs(txid: string): Promise<TxInput[]> {
    const j = await getJson(`${this.base}/raw/transaction/${txid}${this.key()}`);
    const raw = j?.data?.[txid]?.raw_transaction ?? j?.data?.[txid]?.decoded_raw_transaction;
    // Prefer the decoded vin scriptSig hex; fall back to nothing if unavailable.
    const decoded = j?.data?.[txid]?.decoded_raw_transaction;
    if (decoded?.vin) {
      return decoded.vin.map((vin: any) => ({
        script: Buffer.from(vin?.scriptSig?.hex ?? '', 'hex'),
      }));
    }
    if (typeof raw === 'string') {
      // As a fallback, parse the raw tx ourselves via the Zcash tx decoder.
      return parseInputsFromRawHex(raw, this.net);
    }
    throw new ZcashChainError(`raw transaction ${txid} not found`);
  }
}

/** Decode a raw Zcash tx hex and return its input scripts (fallback path). */
function parseInputsFromRawHex(rawHex: string, _net: ZcashNet): TxInput[] {
  const tx = utxolib.bitgo.createTransactionFromBuffer(Buffer.from(rawHex, 'hex'), utxolib.networks.zcash, {
    amountType: 'number',
  });
  return tx.ins.map((i: any) => ({ script: i.script as Buffer }));
}

/** Build the right chain client for a network. */
export function makeZcashChain(net: ZcashNet, opts: { apiKey?: string; baseUrl?: string } = {}): ZcashChain {
  return new BlockchairZcash({ net, apiKey: opts.apiKey, baseUrl: opts.baseUrl });
}
