/**
 * The atomic-swap protocol: roles, timeouts, and the one invariant that makes this a
 * swap instead of a theft.
 *
 * ── The invariant ────────────────────────────────────────────────────────────────────
 * A hash-timelock swap is safe only if the party who reveals the secret FIRST has the
 * LATER refund deadline. Whoever reveals is racing their counterparty's claim against
 * their own refund; if their refund opens too early they can claim one leg AND reclaim
 * the other. So:
 *
 *   the INITIATOR (locks first, claims the responder's leg → reveals the secret)
 *   must have a LONGER timeout than the RESPONDER (locks second, claims last).
 *
 * ── This desk (ZEC→XUS) ──────────────────────────────────────────────────────────────
 * The user brings ZEC and wants XUS; the market maker holds XUS and wants ZEC.
 *
 *   user  = INITIATOR  → locks ZEC first, LONG timeout, reveals the secret to take XUS
 *   MM    = RESPONDER  → locks XUS second, SHORT timeout, sweeps ZEC after the reveal
 *
 * The MM is the responder on purpose: its seeded XUS is the leg we most want to protect,
 * and the responder both locks last (only after the user has already committed ZEC) and
 * recovers fastest (shorter timeout) if the user walks away. The user carries the "free
 * option," which is fine — the user is the one who wants the trade.
 *
 * Therefore, concretely: **the ZEC HTLC must expire LATER (in wall-clock) than the XUS
 * HTLC, by a safety margin** big enough for the MM to observe the user's reveal and land
 * its ZEC sweep. Timeouts live in each chain's own block height, so we compare them in
 * WALL-CLOCK seconds, never raw height numbers.
 */

/** Which direction the desk is quoting. Only ZEC→XUS is live; the enum keeps the reverse
 * honest for when it lands (it flips who is initiator/responder). */
export type SwapDirection = 'zec_to_xus';

export interface ChainClock {
  /** Current chain tip height. */
  tip: number;
  /** Mean seconds per block on this chain. */
  blockTimeSec: number;
}

/** How many seconds from now until `height` is reached, per a chain's clock. Negative if
 * the height is already in the past. */
export function secondsUntilHeight(clock: ChainClock, height: number): number {
  return (height - clock.tip) * clock.blockTimeSec;
}

/** The block height a chain reaches `seconds` from now. */
export function heightAfterSeconds(clock: ChainClock, seconds: number): number {
  return clock.tip + Math.ceil(seconds / clock.blockTimeSec);
}

/**
 * Default timeout budget for a swap, in seconds. The responder (XUS) window is short so
 * seeded inventory frees quickly if the user never claims; the initiator (ZEC) window is
 * twice that, leaving a full responder-window of margin for the MM to sweep after the
 * reveal.
 */
export const DEFAULT_XUS_TIMEOUT_SEC = 6 * 3600; // responder, short
export const DEFAULT_ZEC_TIMEOUT_SEC = 12 * 3600; // initiator, long

/**
 * Minimum wall-clock gap required between the (later) ZEC deadline and the (earlier) XUS
 * deadline. After the user reveals the secret — which they must do before the XUS
 * timeout — the MM has at least this long to get its ZEC sweep confirmed before the user
 * could refund the ZEC. Sized for public-API latency plus a few Zcash confirmations, with
 * headroom.
 */
export const MIN_SAFETY_MARGIN_SEC = 2 * 3600;

export interface SwapTimeouts {
  /** Absolute Zcash height at which the user may refund their ZEC (initiator, long). */
  zecTimeoutHeight: number;
  /** Absolute SOV height at which the MM may refund its XUS (responder, short). */
  xusTimeoutHeight: number;
}

export interface TimeoutInputs {
  zec: ChainClock;
  sov: ChainClock;
  zecTimeoutSec?: number;
  xusTimeoutSec?: number;
}

/**
 * Choose both timeout heights from the wall-clock budget and each chain's clock. The
 * result is guaranteed to satisfy {@link assertSafeTimeouts}; if the caller's budget
 * can't (e.g. someone sets the XUS window longer than the ZEC window), this throws rather
 * than emit unsafe terms.
 */
export function planTimeouts(input: TimeoutInputs): SwapTimeouts {
  const zecSec = input.zecTimeoutSec ?? DEFAULT_ZEC_TIMEOUT_SEC;
  const xusSec = input.xusTimeoutSec ?? DEFAULT_XUS_TIMEOUT_SEC;
  const timeouts: SwapTimeouts = {
    zecTimeoutHeight: heightAfterSeconds(input.zec, zecSec),
    xusTimeoutHeight: heightAfterSeconds(input.sov, xusSec),
  };
  assertSafeTimeouts(timeouts, input.zec, input.sov);
  return timeouts;
}

/**
 * THE guard. Throws unless the ZEC (initiator) deadline is at least MIN_SAFETY_MARGIN_SEC
 * later than the XUS (responder) deadline, in wall-clock time. Call this immediately
 * before the MARKET MAKER locks its XUS — with the ZEC HTLC's ACTUAL on-chain timeout and
 * live tips — so the seeded inventory is never committed against unsafe terms, no matter
 * how the ZEC timeout was chosen or how the two chains' clocks drift.
 */
export function assertSafeTimeouts(
  timeouts: SwapTimeouts,
  zec: ChainClock,
  sov: ChainClock,
): void {
  const zecDeadlineSec = secondsUntilHeight(zec, timeouts.zecTimeoutHeight);
  const xusDeadlineSec = secondsUntilHeight(sov, timeouts.xusTimeoutHeight);

  if (xusDeadlineSec <= 0) {
    throw new SwapSafetyError(
      `XUS timeout is already in the past (${xusDeadlineSec | 0}s) — the escrow would be refundable on creation`,
    );
  }
  if (zecDeadlineSec <= 0) {
    throw new SwapSafetyError(
      `ZEC timeout is already in the past (${zecDeadlineSec | 0}s) — the user could refund immediately`,
    );
  }
  const gap = zecDeadlineSec - xusDeadlineSec;
  if (gap < MIN_SAFETY_MARGIN_SEC) {
    throw new SwapSafetyError(
      `unsafe timeouts: ZEC (initiator) must expire at least ${MIN_SAFETY_MARGIN_SEC}s after XUS ` +
        `(responder), but the gap is only ${Math.round(gap)}s ` +
        `(ZEC in ${Math.round(zecDeadlineSec)}s, XUS in ${Math.round(xusDeadlineSec)}s). ` +
        `Revealing the secret near the XUS deadline could otherwise let the user claim XUS AND refund ZEC.`,
    );
  }
}

/** Raised when swap terms would not be atomic. Never swallow this — it means funds are at
 * risk. */
export class SwapSafetyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SwapSafetyError';
  }
}
