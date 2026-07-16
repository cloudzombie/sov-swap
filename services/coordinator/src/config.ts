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
  /** XUS (whole units) paid out per 1 ZEC received — the desk's quoted price. */
  rateXusPerZec: number;
  minZec: number;
  maxZec: number;
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
  return {
    net: 'mainnet',
    sovRpcUrl: req('SOV_RPC_URL'),
    sovMmSeedHex: req('SOV_MM_SEED_HEX'),
    zecMmWif: req('ZEC_MM_WIF'),
    zecSweepAddress: process.env.ZEC_SWEEP_ADDRESS?.trim() || null,
    rateXusPerZec: Number(opt('RATE_XUS_PER_ZEC', '100')),
    minZec: Number(opt('MIN_ZEC', '0.001')),
    maxZec: Number(opt('MAX_ZEC', '1.0')),
    blockchairApiKey: process.env.BLOCKCHAIR_API_KEY?.trim() || null,
    httpPort: Number(opt('HTTP_PORT', '8790')),
    dataDir: opt('DATA_DIR', new URL('../data', import.meta.url).pathname),
  };
}

export const ZAT_PER_ZEC = 100_000_000;
export const GRAINS_PER_XUS = 100_000_000n;
