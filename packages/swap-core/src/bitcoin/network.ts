/**
 * Bitcoin network + fee configuration for the BTC leg of an XUS↔BTC atomic swap.
 *
 * Bitcoin is the SIMPLE case next to Zcash: no consensus branch ids, no expiry
 * heights, no version groups — a legacy pre-segwit transaction spending a P2SH
 * output is exactly the same format it has been since 2012, and stays valid across
 * soft forks. The only live parameter is the FEE RATE, which unlike Zcash's flat
 * ZIP-317 convention is a market: we take sat/vB from the chain provider at spend
 * time and budget by transaction size.
 */
import * as utxolib from '@bitgo/utxo-lib';

export type BitcoinNet = 'mainnet';

/** The bitgo network object for a given net. */
export function btcUtxoNetwork(_net: BitcoinNet) {
  return utxolib.networks.bitcoin;
}

/** Mean seconds per Bitcoin block — the clock used to plan swap timeouts. */
export const BTC_BLOCK_TIME_SEC = 600;

/**
 * Size budgets (vbytes) for our one-input-one-output P2SH spends, measured from the
 * actual scriptSig shapes with worst-case DER signatures:
 *   claim  = <sig 72> <pub 33> <preimage 32> OP_1 <redeem ~93>  → ~347 vB total
 *   refund = <sig 72> <pub 33> OP_0 <redeem ~93>                → ~313 vB total
 * We round up — overpaying a few vbytes is noise; underpaying strands the sweep.
 */
export const CLAIM_TX_VBYTES = 350;
export const REFUND_TX_VBYTES = 320;

/**
 * Fee floor, satoshi. Below ~1 sat/vB nothing relays; a hard floor also guards
 * against a provider returning a zero/garbage fee rate.
 */
export const MIN_FEE_SAT = 500;

/** Fee ceiling, sat/vB — refuse absurd provider readings rather than burn the leg. */
export const MAX_FEE_RATE_SAT_VB = 500;

/** Fee (satoshi) for a claim/refund spend at `satPerVb`, bounded by floor + ceiling. */
export function btcSpendFee(kind: 'claim' | 'refund', satPerVb: number): number {
  if (!Number.isFinite(satPerVb) || satPerVb <= 0) return MIN_FEE_SAT;
  const rate = Math.min(satPerVb, MAX_FEE_RATE_SAT_VB);
  const vbytes = kind === 'claim' ? CLAIM_TX_VBYTES : REFUND_TX_VBYTES;
  return Math.max(MIN_FEE_SAT, Math.ceil(rate * vbytes));
}
