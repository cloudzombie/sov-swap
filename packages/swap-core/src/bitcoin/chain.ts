/**
 * Bitcoin chain access via public Esplora REST infrastructure — no self-hosted node,
 * no API key, mirroring the Zcash leg's zero-cost posture.
 *
 * The desk needs five things from the Bitcoin chain and nothing more:
 *   1. the tip height          (to plan/verify CLTV timeouts)
 *   2. UTXOs at an address     (to see the user fund the HTLC, and to spend it)
 *   3. broadcast a raw tx      (to sweep the HTLC)
 *   4. a transaction's inputs  (to read a revealed preimage off a claim)
 *   5. a fee rate              (Bitcoin fees are a market — sized per spend)
 *
 * Esplora is the right primitive: mempool.space and blockstream.info both serve the
 * SAME API, giving genuine multi-provider failover with one adapter. Requests walk the
 * endpoint list in order; any endpoint answering keeps the desk alive.
 */
import type { Utxo, TxInput } from '../zcash/chain.js';
import type { BitcoinNet } from './network.js';

export interface BitcoinChain {
  readonly net: BitcoinNet;
  tipHeight(): Promise<number>;
  utxos(address: string): Promise<Utxo[]>;
  broadcast(rawHex: string): Promise<string>;
  txInputs(txid: string): Promise<TxInput[]>;
  /** Current recommended fee rate, sat/vB, for a spend we want confirmed soon. */
  feeRateSatVb(): Promise<number>;
}

export class BitcoinChainError extends Error {
  constructor(
    message: string,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'BitcoinChainError';
  }
}

export const DEFAULT_ESPLORA_ENDPOINTS = [
  'https://mempool.space/api',
  'https://blockstream.info/api',
];

/** Esplora adapter over one or more interchangeable endpoints. */
export class EsploraBitcoin implements BitcoinChain {
  readonly net: BitcoinNet;
  private readonly endpoints: string[];
  /** Tip cache: BTC blocks are ~600s, so a 60s cache costs at most a slightly-stale
   * confirmation count and keeps N pollers to ≤1 request/min per endpoint. */
  private tipCache: { h: number; ts: number } | null = null;
  private static readonly TIP_TTL_MS = 60_000;

  constructor(opts: { net: BitcoinNet; endpoints?: string[] }) {
    if (opts.net !== 'mainnet') {
      throw new BitcoinChainError('EsploraBitcoin supports mainnet only');
    }
    this.net = opts.net;
    this.endpoints = (opts.endpoints?.length ? opts.endpoints : DEFAULT_ESPLORA_ENDPOINTS).map(
      (e) => e.replace(/\/$/, ''),
    );
  }

  /** Try each endpoint in order; return the first success, throw the last failure. */
  private async attempt<T>(fn: (base: string) => Promise<T>): Promise<T> {
    let lastErr: unknown;
    for (const base of this.endpoints) {
      try {
        return await fn(base);
      } catch (e) {
        lastErr = e;
      }
    }
    throw lastErr instanceof Error
      ? lastErr
      : new BitcoinChainError('all Bitcoin endpoints failed', lastErr);
  }

  private async text(base: string, path: string, init?: RequestInit): Promise<string> {
    let res: Response;
    try {
      res = await fetch(`${base}${path}`, init);
    } catch (e) {
      throw new BitcoinChainError(`request to ${base}${path} failed`, e);
    }
    const body = await res.text();
    if (!res.ok) {
      throw new BitcoinChainError(`${base}${path} → HTTP ${res.status}: ${body.slice(0, 200)}`);
    }
    return body;
  }

  private async json(base: string, path: string): Promise<any> {
    const body = await this.text(base, path);
    try {
      return JSON.parse(body);
    } catch (e) {
      throw new BitcoinChainError(`${base}${path} returned non-JSON: ${body.slice(0, 200)}`, e);
    }
  }

  async tipHeight(): Promise<number> {
    const now = Date.now();
    if (this.tipCache && now - this.tipCache.ts < EsploraBitcoin.TIP_TTL_MS) {
      return this.tipCache.h;
    }
    try {
      const h = await this.attempt(async (b) => {
        const t = (await this.text(b, '/blocks/tip/height')).trim();
        const n = Number(t);
        if (!Number.isInteger(n) || n <= 0) {
          throw new BitcoinChainError(`bad tip height: ${t.slice(0, 40)}`);
        }
        return n;
      });
      this.tipCache = { h, ts: now };
      return h;
    } catch (e) {
      // On total provider failure fall back to the last good tip rather than failing a
      // quote; only surface an error if we've never had one.
      if (this.tipCache) return this.tipCache.h;
      throw e;
    }
  }

  async utxos(address: string): Promise<Utxo[]> {
    const [list, tip] = await Promise.all([
      this.attempt((b) => this.json(b, `/address/${address}/utxo`)),
      this.tipHeight(),
    ]);
    if (!Array.isArray(list)) return [];
    return list.map((u: any) => ({
      txid: u.txid,
      vout: u.vout,
      valueZat: u.value, // satoshi — the shared adapters' base-unit field
      confirmations: u.status?.confirmed
        ? Math.max(1, tip - (u.status.block_height ?? tip) + 1)
        : 0,
    }));
  }

  async broadcast(rawHex: string): Promise<string> {
    // Esplora returns the txid as a plain-text body.
    const txid = (
      await this.attempt((b) => this.text(b, '/tx', { method: 'POST', body: rawHex }))
    ).trim();
    if (!/^[0-9a-f]{64}$/.test(txid)) {
      throw new BitcoinChainError(`broadcast returned no txid: ${txid.slice(0, 200)}`);
    }
    return txid;
  }

  async txInputs(txid: string): Promise<TxInput[]> {
    const j = await this.attempt((b) => this.json(b, `/tx/${txid}`));
    if (!Array.isArray(j?.vin)) {
      throw new BitcoinChainError(`transaction ${txid} has no inputs in the response`);
    }
    return j.vin.map((vin: any) => ({ script: Buffer.from(vin?.scriptsig ?? '', 'hex') }));
  }

  async feeRateSatVb(): Promise<number> {
    return this.attempt(async (b) => {
      // mempool.space's recommended-fees endpoint, or Esplora's generic estimates on
      // providers that lack it (blockstream). Target: confirmed within ~3 blocks.
      try {
        const r = await this.json(b, '/v1/fees/recommended');
        if (Number.isFinite(r?.halfHourFee) && r.halfHourFee > 0) return r.halfHourFee;
      } catch {
        /* fall through to /fee-estimates */
      }
      const est = await this.json(b, '/fee-estimates');
      const rate = Number(est?.['3'] ?? est?.['6'] ?? est?.['2']);
      if (!Number.isFinite(rate) || rate <= 0) {
        throw new BitcoinChainError('no usable fee estimate from provider');
      }
      return rate;
    });
  }
}

/** Build the Bitcoin chain client (Esplora; mempool.space with blockstream failover). */
export function makeBitcoinChain(
  net: BitcoinNet,
  opts: { endpoints?: string[] } = {},
): BitcoinChain {
  return new EsploraBitcoin({ net, endpoints: opts.endpoints });
}
