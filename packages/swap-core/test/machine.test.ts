/**
 * Tests for the desk-side swap state machine. Every transition that governs when the desk
 * commits, sweeps, or refunds its seeded XUS is pinned here — a wrong decision is a fund
 * loss, so this is exercised harder than any UI.
 */
import { describe, it, expect } from 'vitest';
import {
  decide,
  DEFAULT_MIN_ZEC_CONFIRMATIONS,
  type Observation,
  type SwapState,
  type SwapTerms,
} from '../src/swap/machine.js';
import type { ChainClock } from '../src/protocol.js';

const zec: ChainClock = { tip: 3_400_000, blockTimeSec: 75 };
const sov: ChainClock = { tip: 6_200, blockTimeSec: 60 };

const terms: SwapTerms = {
  id: 'swap-1',
  hashlock: 'ab'.repeat(32),
  zecHtlcAddress: 't3ExampleHtlcAddress',
  zecAmountZat: 10_000_000, // 0.1 ZEC
  // ZEC (initiator) expires ~12h out; XUS (responder) ~6h out — safe by construction.
  zecTimeoutHeight: zec.tip + Math.ceil((12 * 3600) / zec.blockTimeSec),
  xusRecipient: 'cd'.repeat(32),
  xusAmountGrains: '250000000',
  xusTimeoutHeight: sov.tip + Math.ceil((6 * 3600) / sov.blockTimeSec),
};

function state(phase: SwapState['phase'], over: Partial<SwapState> = {}): SwapState {
  return { terms, phase, ...over };
}
function obs(over: Partial<Observation> = {}): Observation {
  return {
    zec,
    sov,
    zecFunding: null,
    deskXusEscrowExists: false,
    revealedPreimage: null,
    ...over,
  };
}

describe('awaiting_zec_lock', () => {
  it('waits while the user has not funded', () => {
    expect(decide(state('awaiting_zec_lock'), obs())).toEqual({ kind: 'wait' });
  });

  it('waits while funding is under the confirmation threshold', () => {
    const o = obs({ zecFunding: { valueZat: terms.zecAmountZat, confirmations: DEFAULT_MIN_ZEC_CONFIRMATIONS - 1 } });
    expect(decide(state('awaiting_zec_lock'), o)).toEqual({ kind: 'wait' });
  });

  it('ABORTS on underfunding — before any XUS is exposed', () => {
    const o = obs({ zecFunding: { valueZat: terms.zecAmountZat - 1, confirmations: 10 } });
    const a = decide(state('awaiting_zec_lock'), o);
    expect(a.kind).toBe('abort');
  });

  it('locks XUS once funding is confirmed and terms are safe', () => {
    const o = obs({ zecFunding: { valueZat: terms.zecAmountZat, confirmations: DEFAULT_MIN_ZEC_CONFIRMATIONS } });
    expect(decide(state('awaiting_zec_lock'), o)).toEqual({ kind: 'lock_xus' });
  });

  it('accepts overfunding (>= expected) and locks', () => {
    const o = obs({ zecFunding: { valueZat: terms.zecAmountZat + 5, confirmations: 5 } });
    expect(decide(state('awaiting_zec_lock'), o)).toEqual({ kind: 'lock_xus' });
  });
});

describe('committing XUS re-checks safety against LIVE tips', () => {
  it('REFUSES to lock if the safety margin no longer holds', () => {
    // The ZEC chain has raced ahead, collapsing the user's refund window down toward (or
    // below) the desk's XUS window — the exact condition that would let the user claim XUS
    // and still refund ZEC. The desk must NOT commit XUS here.
    const racedZec: ChainClock = { ...zec, tip: terms.zecTimeoutHeight - Math.ceil(3600 / zec.blockTimeSec) }; // ZEC only ~1h left
    const o = obs({
      zec: racedZec,
      zecFunding: { valueZat: terms.zecAmountZat, confirmations: 5 },
    });
    const a = decide(state('awaiting_zec_lock'), o);
    expect(a.kind).toBe('abort');
    if (a.kind === 'abort') expect(a.reason).toMatch(/no longer safe/);
  });

  it('is idempotent — does not re-lock if the escrow already exists', () => {
    const o = obs({
      deskXusEscrowExists: true,
      zecFunding: { valueZat: terms.zecAmountZat, confirmations: 5 },
    });
    expect(decide(state('zec_confirmed'), o)).toEqual({ kind: 'wait' });
  });
});

describe('xus_locked', () => {
  it('waits while the user has not yet claimed', () => {
    expect(decide(state('xus_locked', { deskXusHtlcId: 'x' }), obs({ deskXusEscrowExists: true }))).toEqual({
      kind: 'wait',
    });
  });

  it('sweeps ZEC the moment the user reveals the preimage', () => {
    const o = obs({ deskXusEscrowExists: false, revealedPreimage: 'ab'.repeat(32) });
    expect(decide(state('xus_locked', { deskXusHtlcId: 'x' }), o)).toEqual({ kind: 'sweep_zec' });
  });

  it('refunds the XUS once its timeout passes with no claim', () => {
    const lateSov: ChainClock = { ...sov, tip: terms.xusTimeoutHeight + 1 };
    const o = obs({ sov: lateSov, deskXusEscrowExists: true });
    expect(decide(state('xus_locked', { deskXusHtlcId: 'x' }), o)).toEqual({ kind: 'refund_xus' });
  });

  it('prefers sweeping over refunding if the secret is out, even past the XUS timeout', () => {
    // If the user revealed, the desk should ALWAYS take the ZEC — never walk away from
    // money it has the secret for.
    const lateSov: ChainClock = { ...sov, tip: terms.xusTimeoutHeight + 1 };
    const o = obs({ sov: lateSov, deskXusEscrowExists: true, revealedPreimage: 'ab'.repeat(32) });
    expect(decide(state('xus_locked', { deskXusHtlcId: 'x' }), o)).toEqual({ kind: 'sweep_zec' });
  });
});

describe('terminal + recovery phases', () => {
  it('xus_claimed → sweep, or done if already swept', () => {
    expect(decide(state('xus_claimed', { preimage: 'ab'.repeat(32) }), obs())).toEqual({ kind: 'sweep_zec' });
    expect(decide(state('xus_claimed', { preimage: 'ab'.repeat(32), zecSweepTxid: 't' }), obs())).toEqual({
      kind: 'done',
    });
  });

  it('refunding_xus retries until the escrow is gone', () => {
    expect(decide(state('refunding_xus'), obs({ deskXusEscrowExists: true }))).toEqual({ kind: 'refund_xus' });
    expect(decide(state('refunding_xus'), obs({ deskXusEscrowExists: false }))).toEqual({ kind: 'done' });
  });

  it('all terminal phases are done', () => {
    for (const p of ['zec_swept', 'xus_refunded', 'aborted'] as const) {
      expect(decide(state(p), obs())).toEqual({ kind: 'done' });
    }
  });
});
