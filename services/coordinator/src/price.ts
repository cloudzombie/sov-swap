/**
 * XUS reference price.
 *
 * XUS has no exchange order book, but the desk *will* trade ZEC↔XUS trustlessly at a
 * fixed rate, so a defensible price falls straight out of that rate anchored to ZEC's
 * live USD market price:
 *
 *     1 ZEC = RATE_XUS_PER_ZEC  XUS   (the desk's standing quote)
 *  ⇒  1 XUS = ZEC_USD / RATE_XUS_PER_ZEC  USD
 *
 * This is a one-sided market-maker quote, not an exchange mid — labelled as such — but it
 * is a real number the desk honors, not a fabrication. ZEC/USD comes from CoinGecko,
 * cached so we never hammer it, and a rolling history is persisted for a sparkline.
 */
import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const COINGECKO = 'https://api.coingecko.com/api/v3/simple/price?ids=zcash&vs_currencies=usd';
const CACHE_MS = 60_000; // don't fetch ZEC/USD more than once a minute
const SAMPLE_MS = 5 * 60_000; // record one history point every 5 minutes
const MAX_POINTS = 2016; // ~1 week at 5-minute spacing

export interface PriceNow {
  /** ZEC price in USD (market). */
  zecUsd: number;
  /** The desk's standing rate (XUS per ZEC). */
  rateXusPerZec: number;
  /** Derived XUS price in USD. */
  xusUsd: number;
  /** Unix ms of the underlying ZEC quote. */
  ts: number;
  source: string;
}

interface Sample {
  ts: number;
  zecUsd: number;
  xusUsd: number;
}

export class PriceService {
  private zecUsd: number | null = null;
  private zecTs = 0;
  private history: Sample[] = [];
  private readonly file: string;
  private lastSample = 0;

  constructor(
    /** The live (curve-adjusted) rate — read fresh each time so the price rises with sales. */
    private readonly rateFn: () => number,
    dataDir: string,
  ) {
    this.file = join(dataDir, 'price-history.json');
    if (existsSync(this.file)) {
      try {
        this.history = JSON.parse(readFileSync(this.file, 'utf8'));
      } catch {
        this.history = [];
      }
    }
  }

  /** Fetch ZEC/USD, honoring the cache. Returns null if never successfully fetched. */
  private async zec(): Promise<number | null> {
    const now = Date.now();
    if (this.zecUsd !== null && now - this.zecTs < CACHE_MS) return this.zecUsd;
    try {
      const r = await fetch(COINGECKO, { headers: { accept: 'application/json' } });
      const j: any = await r.json();
      const px = j?.zcash?.usd;
      if (typeof px === 'number' && px > 0) {
        this.zecUsd = px;
        this.zecTs = now;
      }
    } catch {
      /* keep the last good value */
    }
    return this.zecUsd;
  }

  /** The current XUS reference price, or null if ZEC/USD is not yet available. */
  async now(): Promise<PriceNow | null> {
    const zecUsd = await this.zec();
    if (zecUsd === null) return null;
    const rate = this.rateFn();
    return {
      zecUsd,
      rateXusPerZec: rate,
      xusUsd: zecUsd / rate,
      ts: this.zecTs,
      source: 'coingecko:zcash',
    };
  }

  /** Record a history point if the sample interval has elapsed. Called on the poll timer. */
  async maybeSample(): Promise<void> {
    const now = Date.now();
    if (now - this.lastSample < SAMPLE_MS) return;
    const p = await this.now();
    if (!p) return;
    this.lastSample = now;
    this.history.push({ ts: p.ts, zecUsd: p.zecUsd, xusUsd: p.xusUsd });
    if (this.history.length > MAX_POINTS) this.history = this.history.slice(-MAX_POINTS);
    try {
      writeFileSync(this.file, JSON.stringify(this.history));
    } catch {
      /* non-fatal */
    }
  }

  /** The last `points` history samples (default all), oldest→newest. */
  historyPoints(points?: number): Sample[] {
    return points ? this.history.slice(-points) : this.history;
  }
}
