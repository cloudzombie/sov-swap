/**
 * The bounded cross-rate clamp — the whole oracle-safety argument, exercised as pure
 * logic. If any of these fail, a poisoned or glitched price feed could reprice the desk.
 */
import { describe, expect, it } from 'vitest';
import { evaluateUpdate, isStale, type CrossRateBounds, type CrossRateState } from '../src/crossrate.js';

const b: CrossRateBounds = { floor: 6000, ceil: 24000, maxStepPct: 10, staleAfterMs: 15 * 60_000 };
const state: CrossRateState = { rate: 12000, ts: 1_000_000 };
const now = 1_060_000;

describe('sanity clamp', () => {
  it('rejects garbage candidates outright', () => {
    for (const c of [NaN, Infinity, -Infinity, 0, -5]) {
      const ev = evaluateUpdate(state, c, now, b);
      expect(ev.accepted).toBe(false);
    }
  });
});

describe('deviation bound', () => {
  it('accepts a move inside the bound', () => {
    const ev = evaluateUpdate(state, 12_900, now, b); // +7.5%
    expect(ev.accepted).toBe(true);
    if (ev.accepted) expect(ev.state.rate).toBe(12_900);
  });

  it('REJECTS a jump beyond the bound — it does not partially apply', () => {
    const ev = evaluateUpdate(state, 15_000, now, b); // +25%
    expect(ev.accepted).toBe(false);
    if (!ev.accepted) expect(ev.reason).toMatch(/deviation/);
  });

  it('a flash-crash print is rejected the same way', () => {
    expect(evaluateUpdate(state, 4000, now, b).accepted).toBe(false);
  });

  it('walking the rate 10% at a time is possible only INSIDE the hard bounds', () => {
    // Simulate an attacker feeding max-step moves upward: the ceiling pins them.
    let s = { ...state };
    for (let i = 0; i < 50; i++) {
      const ev = evaluateUpdate(s, s.rate * 1.0999, now + i, b);
      expect(ev.accepted).toBe(true);
      if (ev.accepted) s = ev.state;
    }
    expect(s.rate).toBeLessThanOrEqual(b.ceil);
    expect(s.rate).toBe(b.ceil);
  });
});

describe('hard floor/ceiling', () => {
  it('pins an in-step candidate that crosses the ceiling', () => {
    const nearCeil: CrossRateState = { rate: 23_000, ts: now };
    const ev = evaluateUpdate(nearCeil, 24_800, now, b); // +7.8%, above ceil
    expect(ev.accepted).toBe(true);
    if (ev.accepted) {
      expect(ev.state.rate).toBe(b.ceil);
      expect(ev.pinned).toBe(true);
    }
  });

  it('pins at the floor symmetrically', () => {
    const nearFloor: CrossRateState = { rate: 6_300, ts: now };
    const ev = evaluateUpdate(nearFloor, 5_800, now, b); // −7.9%, below floor
    expect(ev.accepted).toBe(true);
    if (ev.accepted) expect(ev.state.rate).toBe(b.floor);
  });
});

describe('staleness (fail closed)', () => {
  it('fresh inside the window, stale beyond it', () => {
    expect(isStale(state, state.ts + b.staleAfterMs, b)).toBe(false);
    expect(isStale(state, state.ts + b.staleAfterMs + 1, b)).toBe(true);
  });
});
