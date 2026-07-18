/**
 * The desk-side swap state machine (ZEC→XUS, market maker = responder).
 *
 * Pure logic: given the swap's committed terms and a fresh snapshot of both chains, it
 * returns the ONE action the coordinator should take next. No I/O, no clocks, no
 * randomness — so every safety decision (when to commit XUS, when to sweep, when to
 * refund) is unit-testable against a fake chain, and a crashed coordinator recovers by
 * re-observing and re-deciding rather than replaying side effects.
 *
 * The desk is the RESPONDER: it only commits its seeded XUS AFTER the user's ZEC is
 * locked and confirmed, and only if the timeout invariant still holds against live tips.
 * See `../protocol.ts` for why that ordering protects the inventory.
 */
import { assertSafeTimeouts, SwapSafetyError, type ChainClock } from '../protocol.js';

/** Which UTXO coin the user's leg is on. Absent on records persisted before BTC
 * support — read it as `terms.coin ?? 'ZEC'`. */
export type SwapCoin = 'ZEC' | 'BTC';

/** Everything committed when the swap is created — the terms both legs are built from.
 *
 * NAMING NOTE: the `zec…`-prefixed fields predate BTC support and denote the USER'S
 * UTXO-COIN leg regardless of `coin` — for a BTC swap `zecHtlcAddress` holds the
 * Bitcoin P2SH address, `zecAmountZat` holds satoshi, `zecTimeoutHeight` a Bitcoin
 * height. Kept verbatim because they are persisted in every existing swap record;
 * the machine's logic is coin-agnostic either way. */
export interface SwapTerms {
  /** Opaque id for this swap (coordinator-assigned). */
  id: string;
  /** The user's UTXO coin. Absent = 'ZEC' (pre-BTC records). */
  coin?: SwapCoin;
  /** 32-byte SHA-256 hashlock, hex. The USER chose the secret; the desk only sees this. */
  hashlock: string;
  /** The P2SH address the user funds on Zcash. */
  zecHtlcAddress: string;
  /** Expected ZEC amount, zatoshi. */
  zecAmountZat: number;
  /** Absolute Zcash height at which the user may refund (initiator, LONG). */
  zecTimeoutHeight: number;
  /** The user's XUS account that receives the XUS. */
  xusRecipient: string;
  /** XUS the desk will lock, in grains. */
  xusAmountGrains: string;
  /** Absolute SOV height at which the desk may refund (responder, SHORT). */
  xusTimeoutHeight: number;
}

/** Persisted swap phase. */
export type SwapPhase =
  | 'awaiting_zec_lock' // shown the user the ZEC address; watching for funding
  | 'zec_confirmed' // user's ZEC HTLC funded + confirmed; ready to commit XUS
  | 'xus_locked' // desk locked XUS; waiting for the user to claim (reveal secret)
  | 'xus_claimed' // user claimed XUS → we learned the preimage; ready to sweep ZEC
  | 'zec_swept' // desk swept the ZEC — SUCCESS, terminal
  | 'refunding_xus' // user never claimed; desk is reclaiming its XUS
  | 'xus_refunded' // desk reclaimed XUS — terminal (user refunds their ZEC themselves)
  | 'aborted'; // pre-commit failure (e.g. user underfunded); no desk funds ever at risk

export interface SwapState {
  terms: SwapTerms;
  phase: SwapPhase;
  /** htlc_id of the desk's XUS lock, once locked. */
  deskXusHtlcId?: string;
  /** Preimage revealed by the user's claim, hex, once known. */
  preimage?: string;
  /** Zcash txid of the desk's sweep, once broadcast. */
  zecSweepTxid?: string;
  /** The user's ZEC HTLC funding output, captured when confirmed — the input the desk
   * sweeps. */
  zecFundingUtxo?: { txid: string; vout: number; valueZat: number };
  /** SOV height at which the desk locked its XUS — the lower bound for the preimage scan. */
  xusLockHeight?: number;
  /** Wall-clock (ms) the swap was created; for expiry/GC. */
  createdAt?: number;
  /** Human-readable note for terminal/aborted states. */
  note?: string;
}

/** A fresh snapshot of the world the machine decides against. */
export interface Observation {
  zec: ChainClock;
  sov: ChainClock;
  /** Confirmations of the user's ZEC HTLC funding, or null if not seen yet. */
  zecFunding: { valueZat: number; confirmations: number } | null;
  /** True once the desk's XUS HTLC escrow is present on-chain. */
  deskXusEscrowExists: boolean;
  /** The preimage the desk read off the user's XUS claim, if detected. */
  revealedPreimage: string | null;
}

/** The next action for the coordinator to perform. `wait` means do nothing this tick. */
export type Action =
  | { kind: 'wait' }
  | { kind: 'lock_xus' } // commit the seeded XUS (responder leg)
  | { kind: 'sweep_zec' } // claim the user's ZEC using the revealed preimage
  | { kind: 'refund_xus' } // reclaim the desk's XUS after its timeout
  | { kind: 'abort'; reason: string }
  | { kind: 'done' }; // terminal, nothing more to do

/** Minimum confirmations of the user's ZEC funding before the desk commits XUS. On the
 * responder leg this is the desk's exposure gate: fewer confirmations = more re-org risk
 * on the money it is about to match. Zcash re-orgs are shallow; a small number suffices,
 * and it is configurable per deployment. */
export const DEFAULT_MIN_ZEC_CONFIRMATIONS = 3;

export interface DecideOptions {
  minZecConfirmations?: number;
}

/**
 * Decide the next action. Deterministic and side-effect free. The coordinator applies the
 * action, updates the persisted phase, and calls again next tick. Crash-safe: because the
 * decision is a pure function of persisted terms + live chain state, re-running it after a
 * restart yields the same action (and the underlying chain ops are idempotent — locking is
 * guarded by `deskXusEscrowExists`, sweeping by the escrow already being claimed).
 */
export function decide(state: SwapState, obs: Observation, opts: DecideOptions = {}): Action {
  const minConf = opts.minZecConfirmations ?? DEFAULT_MIN_ZEC_CONFIRMATIONS;

  switch (state.phase) {
    case 'awaiting_zec_lock': {
      if (!obs.zecFunding) return { kind: 'wait' };
      // The user must fund at least the agreed amount. Underfunding aborts BEFORE the desk
      // risks any XUS; the user reclaims their ZEC via the HTLC refund path after timeout.
      if (obs.zecFunding.valueZat < state.terms.zecAmountZat) {
        return {
          kind: 'abort',
          reason: `underfunded: ZEC HTLC holds ${obs.zecFunding.valueZat} zat, expected ${state.terms.zecAmountZat}`,
        };
      }
      if (obs.zecFunding.confirmations < minConf) return { kind: 'wait' };
      return decideAtZecConfirmed(state, obs);
    }

    case 'zec_confirmed':
      return decideAtZecConfirmed(state, obs);

    case 'xus_locked': {
      // The happy path: the user claims XUS, revealing the secret; we sweep the ZEC.
      if (obs.revealedPreimage) return { kind: 'sweep_zec' };
      // The user hasn't claimed and our XUS timeout has arrived → reclaim the XUS. Safe:
      // the ZEC timeout is strictly later (the invariant), so the user can still refund
      // their ZEC; nobody is cheated, the swap simply didn't happen.
      if (obs.sov.tip >= state.terms.xusTimeoutHeight && obs.deskXusEscrowExists) {
        return { kind: 'refund_xus' };
      }
      return { kind: 'wait' };
    }

    case 'xus_claimed':
      // We know the secret; sweep the ZEC (idempotent — re-sweep is rejected once spent).
      if (state.zecSweepTxid) return { kind: 'done' };
      return { kind: 'sweep_zec' };

    case 'refunding_xus':
      return obs.deskXusEscrowExists ? { kind: 'refund_xus' } : { kind: 'done' };

    case 'zec_swept':
    case 'xus_refunded':
    case 'aborted':
      return { kind: 'done' };
  }
}

/** Shared logic for the moment the user's ZEC is confirmed: re-check safety against LIVE
 * tips, then commit XUS — unless we already have (idempotency). */
function decideAtZecConfirmed(state: SwapState, obs: Observation): Action {
  // If the escrow already exists, we've locked; move on to watching for the claim.
  if (obs.deskXusEscrowExists || state.deskXusHtlcId) {
    if (obs.revealedPreimage) return { kind: 'sweep_zec' };
    return { kind: 'wait' };
  }
  // RE-VERIFY the invariant against live tips before committing a single grain. Time has
  // passed since the swap was quoted; a chain could have stalled or sped up. If the margin
  // no longer holds, we do NOT lock — the user refunds their ZEC and no XUS is exposed.
  try {
    assertSafeTimeouts(
      { zecTimeoutHeight: state.terms.zecTimeoutHeight, xusTimeoutHeight: state.terms.xusTimeoutHeight },
      obs.zec,
      obs.sov,
    );
  } catch (e) {
    if (e instanceof SwapSafetyError) {
      return { kind: 'abort', reason: `timeouts no longer safe to match: ${e.message}` };
    }
    throw e;
  }
  return { kind: 'lock_xus' };
}
