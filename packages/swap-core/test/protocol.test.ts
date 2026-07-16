/**
 * Tests for the swap protocol's safety invariant — the rule that separates a swap from a
 * theft. These are the most important tests in the package: a false "safe" here means the
 * desk locks real XUS against terms that let the user take both legs.
 */
import { describe, it, expect } from 'vitest';
import {
  assertSafeTimeouts,
  planTimeouts,
  secondsUntilHeight,
  heightAfterSeconds,
  SwapSafetyError,
  DEFAULT_ZEC_TIMEOUT_SEC,
  DEFAULT_XUS_TIMEOUT_SEC,
  MIN_SAFETY_MARGIN_SEC,
  type ChainClock,
} from '../src/protocol.js';

// Realistic clocks: SOV ~60s blocks, Zcash ~75s blocks.
const sov: ChainClock = { tip: 6_200, blockTimeSec: 60 };
const zec: ChainClock = { tip: 3_400_000, blockTimeSec: 75 };

describe('height <-> wall-clock', () => {
  it('round-trips through each chain’s block time', () => {
    const h = heightAfterSeconds(sov, 3600); // 1h at 60s/block = 60 blocks
    expect(h).toBe(6_260);
    expect(secondsUntilHeight(sov, h)).toBe(3600);
  });

  it('reports a past height as negative time', () => {
    expect(secondsUntilHeight(zec, zec.tip - 100)).toBeLessThan(0);
  });
});

describe('planTimeouts', () => {
  it('produces safe terms from the defaults', () => {
    const t = planTimeouts({ zec, sov });
    // ZEC (initiator) deadline must be comfortably later than XUS (responder).
    const zecDeadline = secondsUntilHeight(zec, t.zecTimeoutHeight);
    const xusDeadline = secondsUntilHeight(sov, t.xusTimeoutHeight);
    expect(zecDeadline).toBeGreaterThan(xusDeadline + MIN_SAFETY_MARGIN_SEC);
    // Sanity vs the intended budget.
    expect(zecDeadline).toBeGreaterThanOrEqual(DEFAULT_ZEC_TIMEOUT_SEC - zec.blockTimeSec);
    expect(xusDeadline).toBeGreaterThanOrEqual(DEFAULT_XUS_TIMEOUT_SEC - sov.blockTimeSec);
  });

  it('refuses to emit terms where XUS would outlast ZEC (the theft setup)', () => {
    // Inverting the budget — XUS longer than ZEC — is exactly the unsafe case.
    expect(() =>
      planTimeouts({ zec, sov, zecTimeoutSec: 3 * 3600, xusTimeoutSec: 12 * 3600 }),
    ).toThrow(SwapSafetyError);
  });
});

describe('assertSafeTimeouts — the anti-theft guard', () => {
  it('passes when ZEC expires well after XUS', () => {
    const timeouts = {
      zecTimeoutHeight: heightAfterSeconds(zec, 12 * 3600),
      xusTimeoutHeight: heightAfterSeconds(sov, 6 * 3600),
    };
    expect(() => assertSafeTimeouts(timeouts, zec, sov)).not.toThrow();
  });

  it('REJECTS when ZEC expires before XUS — user could claim XUS and refund ZEC', () => {
    const timeouts = {
      zecTimeoutHeight: heightAfterSeconds(zec, 4 * 3600), // initiator SHORTER — inverted
      xusTimeoutHeight: heightAfterSeconds(sov, 6 * 3600),
    };
    expect(() => assertSafeTimeouts(timeouts, zec, sov)).toThrow(/unsafe timeouts/);
  });

  it('REJECTS when the gap is positive but below the safety margin', () => {
    // ZEC only 30 min after XUS — not enough for the MM to sweep ZEC post-reveal.
    const timeouts = {
      xusTimeoutHeight: heightAfterSeconds(sov, 6 * 3600),
      zecTimeoutHeight: heightAfterSeconds(zec, 6 * 3600 + 30 * 60),
    };
    expect(() => assertSafeTimeouts(timeouts, zec, sov)).toThrow(/at least .* after XUS/);
  });

  it('accepts a gap exactly at the margin, rejects just under it', () => {
    const xusHeight = heightAfterSeconds(sov, 6 * 3600);
    const xusDeadline = secondsUntilHeight(sov, xusHeight);
    const atMargin = {
      xusTimeoutHeight: xusHeight,
      zecTimeoutHeight: heightAfterSeconds(zec, xusDeadline + MIN_SAFETY_MARGIN_SEC + zec.blockTimeSec),
    };
    expect(() => assertSafeTimeouts(atMargin, zec, sov)).not.toThrow();

    const underMargin = {
      xusTimeoutHeight: xusHeight,
      zecTimeoutHeight: heightAfterSeconds(zec, xusDeadline + MIN_SAFETY_MARGIN_SEC - 10 * 60),
    };
    expect(() => assertSafeTimeouts(underMargin, zec, sov)).toThrow(SwapSafetyError);
  });

  it('REJECTS an already-expired XUS timeout (refundable on creation)', () => {
    const timeouts = {
      xusTimeoutHeight: sov.tip - 10, // already past
      zecTimeoutHeight: heightAfterSeconds(zec, 12 * 3600),
    };
    expect(() => assertSafeTimeouts(timeouts, zec, sov)).toThrow(/already in the past/);
  });

  it('REJECTS an already-expired ZEC timeout (user could refund immediately)', () => {
    const timeouts = {
      xusTimeoutHeight: heightAfterSeconds(sov, 6 * 3600),
      zecTimeoutHeight: zec.tip - 10,
    };
    expect(() => assertSafeTimeouts(timeouts, zec, sov)).toThrow(/ZEC timeout is already in the past/);
  });

  it('accounts for DIFFERENT block times — the invariant is wall-clock, not raw height', () => {
    // Same raw block delta on both chains is NOT the same wall-clock duration.
    // 300 SOV blocks = 5h; 300 ZEC blocks = 6.25h. The guard must reason in seconds.
    const timeouts = {
      xusTimeoutHeight: sov.tip + 300, // 5h
      zecTimeoutHeight: zec.tip + 300, // 6.25h
    };
    // Gap is 1.25h < 2h margin ⇒ must reject, even though ZEC height delta == SOV.
    expect(() => assertSafeTimeouts(timeouts, zec, sov)).toThrow(SwapSafetyError);
  });
});
