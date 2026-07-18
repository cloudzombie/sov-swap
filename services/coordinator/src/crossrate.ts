/**
 * Bounded auto-cross-rate for the BTC leg.
 *
 * The desk's ZEC rate is the ANCHOR — the operator's hand-set definition of what XUS
 * costs. The BTC base rate tracks it through the live market ratio:
 *
 *     RATE_XUS_PER_BTC = RATE_XUS_PER_ZEC × (BTC/USD ÷ ZEC/USD)
 *
 * so both legs always price XUS identically and the cross-leg arbitrage window stays
 * closed as markets move.
 *
 * An unbounded feed would be an oracle attack surface, so every update is clamped:
 *
 *   1. sanity      — non-finite / non-positive candidates are rejected outright
 *   2. deviation   — a candidate more than `maxStepPct` away from the last accepted
 *                    rate is REJECTED (not partially applied — pinning to last±step
 *                    would let a poisoned feed walk the rate out one step at a time)
 *   3. floor/ceil  — accepted candidates are PINNED into the operator's hard bounds,
 *                    the wall a slow-poisoning attack cannot pass
 *   4. staleness   — if no update has been accepted within `staleAfterMs`, the rate
 *                    is unusable and the desk STOPS QUOTING BTC. Fail closed.
 *
 * Every accept/reject is logged so the operator can audit what the desk priced and why.
 */
import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

export interface CrossRateBounds {
  /** Hard minimum XUS/BTC the desk will ever quote. */
  floor: number;
  /** Hard maximum XUS/BTC the desk will ever quote. */
  ceil: number;
  /** Max % move (vs the last accepted rate) a single update may make. */
  maxStepPct: number;
  /** How long the last accepted rate stays quotable without a fresh accept. */
  staleAfterMs: number;
}

export interface CrossRateState {
  /** Last accepted XUS/BTC rate (already pinned into bounds). */
  rate: number;
  /** Unix ms of the last accept. */
  ts: number;
}

export type Evaluation =
  | { accepted: true; state: CrossRateState; pinned: boolean }
  | { accepted: false; reason: string };

/** Pure clamp logic — the whole safety argument lives here, testable without I/O. */
export function evaluateUpdate(
  state: CrossRateState,
  candidate: number,
  now: number,
  b: CrossRateBounds,
): Evaluation {
  if (!Number.isFinite(candidate) || candidate <= 0) {
    return { accepted: false, reason: `non-finite/non-positive candidate ${candidate}` };
  }
  const stepPct = (Math.abs(candidate - state.rate) / state.rate) * 100;
  if (stepPct > b.maxStepPct) {
    return {
      accepted: false,
      reason: `deviation ${stepPct.toFixed(1)}% exceeds the ${b.maxStepPct}% bound (last ${state.rate}, candidate ${candidate.toFixed(2)})`,
    };
  }
  const pinnedRate = Math.min(Math.max(candidate, b.floor), b.ceil);
  return {
    accepted: true,
    state: { rate: pinnedRate, ts: now },
    pinned: pinnedRate !== candidate,
  };
}

/** Whether `state` is too old to quote from. */
export function isStale(state: CrossRateState, now: number, b: CrossRateBounds): boolean {
  return now - state.ts > b.staleAfterMs;
}

const COINGECKO =
  'https://api.coingecko.com/api/v3/simple/price?ids=bitcoin,zcash&vs_currencies=usd';
const FETCH_CACHE_MS = 60_000; // one market fetch a minute is plenty

export class CrossRateService {
  private state: CrossRateState;
  private lastFetch = 0;
  private readonly file: string;

  constructor(
    /** The anchor: the desk's hand-set XUS per ZEC. */
    private readonly rateXusPerZec: number,
    /** The operator's configured XUS/BTC — the boot anchor before the first fetch. */
    anchorRate: number,
    private readonly bounds: CrossRateBounds,
    dataDir: string,
  ) {
    this.file = join(dataDir, 'cross-rate.json');
    let persisted: CrossRateState | null = null;
    if (existsSync(this.file)) {
      try {
        const j = JSON.parse(readFileSync(this.file, 'utf8'));
        if (Number.isFinite(j?.rate) && j.rate > 0 && Number.isFinite(j?.ts)) persisted = j;
      } catch {
        /* fall through to the anchor */
      }
    }
    // A persisted rate carries its own timestamp (may already be stale — fail closed
    // until a fresh accept). With nothing persisted, the operator's configured anchor
    // gets one staleness window from boot: they stated it deliberately, and the very
    // first successful fetch replaces it.
    this.state = persisted ?? { rate: anchorRate, ts: Date.now() };
  }

  /** Fetch the market ratio and evaluate one bounded update. Called on the poll timer. */
  async update(): Promise<void> {
    const now = Date.now();
    if (now - this.lastFetch < FETCH_CACHE_MS) return;
    this.lastFetch = now;
    let btcUsd: number, zecUsd: number;
    try {
      const r = await fetch(COINGECKO, { headers: { accept: 'application/json' } });
      const j: any = await r.json();
      btcUsd = j?.bitcoin?.usd;
      zecUsd = j?.zcash?.usd;
    } catch (e) {
      console.error('[cross-rate] fetch failed:', (e as Error).message);
      return; // staleness clock keeps running — fail closed
    }
    if (!(btcUsd! > 0) || !(zecUsd! > 0)) {
      console.error('[cross-rate] feed returned unusable prices', { btcUsd: btcUsd!, zecUsd: zecUsd! });
      return;
    }
    const candidate = this.rateXusPerZec * (btcUsd! / zecUsd!);
    const ev = evaluateUpdate(this.state, candidate, now, this.bounds);
    if (!ev.accepted) {
      console.error(`[cross-rate] REJECTED update: ${ev.reason}`);
      return;
    }
    if (ev.pinned) {
      console.log(
        `[cross-rate] candidate ${candidate.toFixed(2)} pinned into [${this.bounds.floor}, ${this.bounds.ceil}] → ${ev.state.rate}`,
      );
    }
    if (Math.abs(ev.state.rate - this.state.rate) / this.state.rate > 0.001) {
      console.log(`[cross-rate] ${this.state.rate.toFixed(2)} → ${ev.state.rate.toFixed(2)} XUS/BTC`);
    }
    this.state = ev.state;
    try {
      writeFileSync(this.file, JSON.stringify(this.state));
    } catch {
      /* non-fatal: the rate still applies this run */
    }
  }

  /** The quotable XUS/BTC rate, or null when stale (BTC quoting must pause). */
  current(): number | null {
    return isStale(this.state, Date.now(), this.bounds) ? null : this.state.rate;
  }
}
