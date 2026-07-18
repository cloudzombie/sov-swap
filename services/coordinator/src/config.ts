/**
 * Coordinator configuration, read once from the environment. Secrets (the desk's XUS seed
 * and ZEC key) live only in env / a .env the operator supplies — never in the repo, never
 * logged.
 */
import type { ZcashNet } from '@sov-swap/core';

export interface Config {
  net: ZcashNet;
  sovRpcUrl: string;
  sovMmSeedHex: string;
  zecMmWif: string;
  zecSweepAddress: string | null;
  /** Starting XUS (whole units) per 1 ZEC — the desk's base quote before the sales curve. */
  rateXusPerZec: number;
  /** Bonding-curve scale: XUS that must sell to HALVE the rate (i.e. double the XUS price).
   * 0 disables the curve (fixed rate). Smaller = the price climbs faster with sales. */
  curveK: number;
  minZec: number;
  maxZec: number;
  /** BTC leg — OPTIONAL. Absent BTC_MM_WIF = the desk quotes ZEC only. When set, a base
   * rate is REQUIRED (no invented default: BTC/XUS is the operator's price to state). */
  btcMmWif: string | null;
  btcSweepAddress: string | null;
  rateXusPerBtc: number | null;
  minBtc: number;
  maxBtc: number;
  /** Bounded auto-cross-rate: track RATE_XUS_PER_ZEC × market BTC/ZEC inside hard
   * bounds; stale feed = BTC quoting pauses (fail closed). Off = static rate. */
  autoCrossRate: boolean;
  btcRateFloor: number | null;
  btcRateCeil: number | null;
  btcRateMaxStepPct: number;
  btcRateStaleMin: number;
  blockchairApiKey: string | null;
  httpPort: number;
  dataDir: string;
}

function req(name: string): string {
  const v = process.env[name];
  if (!v || !v.trim()) throw new Error(`missing required env ${name}`);
  return v.trim();
}
function opt(name: string, dflt: string): string {
  const v = process.env[name];
  return v && v.trim() ? v.trim() : dflt;
}

export function loadConfig(): Config {
  const btcMmWif = process.env.BTC_MM_WIF?.trim() || null;
  const rateXusPerBtc = process.env.RATE_XUS_PER_BTC?.trim()
    ? Number(process.env.RATE_XUS_PER_BTC)
    : null;
  if (btcMmWif && (!rateXusPerBtc || !(rateXusPerBtc > 0))) {
    throw new Error('BTC_MM_WIF is set but RATE_XUS_PER_BTC is missing/invalid — refusing to quote BTC at a made-up rate');
  }
  const autoCrossRate = /^(1|true|yes)$/i.test(process.env.AUTO_CROSS_RATE?.trim() ?? '');
  // Hard bounds default to a generous corridor around the operator's stated rate — they
  // are the wall a poisoned feed cannot pass, not a day-to-day trading range.
  const btcRateFloor = process.env.BTC_RATE_FLOOR?.trim()
    ? Number(process.env.BTC_RATE_FLOOR)
    : rateXusPerBtc
      ? rateXusPerBtc * 0.5
      : null;
  const btcRateCeil = process.env.BTC_RATE_CEIL?.trim()
    ? Number(process.env.BTC_RATE_CEIL)
    : rateXusPerBtc
      ? rateXusPerBtc * 2
      : null;
  if (autoCrossRate) {
    if (!btcMmWif) throw new Error('AUTO_CROSS_RATE needs the BTC leg (BTC_MM_WIF) enabled');
    if (!(btcRateFloor! > 0) || !(btcRateCeil! > btcRateFloor!)) {
      throw new Error('AUTO_CROSS_RATE needs sane bounds: 0 < BTC_RATE_FLOOR < BTC_RATE_CEIL');
    }
  }
  return {
    autoCrossRate,
    btcRateFloor,
    btcRateCeil,
    btcRateMaxStepPct: Number(opt('BTC_RATE_MAX_STEP_PCT', '10')),
    btcRateStaleMin: Number(opt('BTC_RATE_STALE_MIN', '15')),
    btcMmWif,
    btcSweepAddress: process.env.BTC_SWEEP_ADDRESS?.trim() || null,
    rateXusPerBtc,
    minBtc: Number(opt('MIN_BTC', '0.0001')),
    maxBtc: Number(opt('MAX_BTC', '0.005')),
    net: 'mainnet',
    sovRpcUrl: req('SOV_RPC_URL'),
    sovMmSeedHex: req('SOV_MM_SEED_HEX'),
    zecMmWif: req('ZEC_MM_WIF'),
    zecSweepAddress: process.env.ZEC_SWEEP_ADDRESS?.trim() || null,
    rateXusPerZec: Number(opt('RATE_XUS_PER_ZEC', '100')),
    curveK: Number(opt('CURVE_K', '0')),
    minZec: Number(opt('MIN_ZEC', '0.001')),
    maxZec: Number(opt('MAX_ZEC', '1.0')),
    blockchairApiKey: process.env.BLOCKCHAIR_API_KEY?.trim() || null,
    httpPort: Number(opt('HTTP_PORT', '8790')),
    dataDir: opt('DATA_DIR', new URL('../data', import.meta.url).pathname),
  };
}

export const ZAT_PER_ZEC = 100_000_000;
export const GRAINS_PER_XUS = 100_000_000n;
