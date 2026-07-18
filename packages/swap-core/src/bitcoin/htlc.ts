/**
 * Bitcoin P2SH HTLC — the BTC leg of an XUS↔BTC atomic swap.
 *
 * The redeem script is the SHARED one from `../htlc-script.ts`, byte-identical to the
 * Zcash leg — same OP_SHA256 hashlock, same CLTV refund path, same scriptSig shapes.
 * This module supplies only Bitcoin's envelope: base58 P2SH address encoding (version
 * 0x05, `3…`), the ORIGINAL legacy sighash (these are pre-segwit P2SH spends), and a
 * market fee passed in by the caller instead of Zcash's flat ZIP-317 convention.
 *
 * Legacy (non-segwit) P2SH is chosen deliberately: it is the exact analogue of the
 * proven Zcash construction, standard, relayable everywhere, and spendable with the
 * same hand-built scriptSig — one construction to audit on both chains.
 */
import * as utxolib from '@bitgo/utxo-lib';
import {
  SIGHASH_ALL,
  SEQUENCE_CLTV,
  htlcRedeemScript,
  htlcP2shOutputScript,
  hashlockOf,
  type HtlcTerms,
  type Signer,
} from '../htlc-script.js';
import { btcUtxoNetwork, type BitcoinNet } from './network.js';

const { opcodes, script: bscript, crypto: bcrypto, address: baddress } = utxolib;

/** The minimal legacy-transaction surface we drive (see zcash/htlc.ts for the pattern). */
interface BtcTx {
  hashForSignature(inIndex: number, prevOutScript: Buffer, hashType: number): Buffer;
  setInputScript(index: number, script: Buffer): void;
  toBuffer(): Buffer;
  getId(): string;
  ins: Array<{ script: Buffer; sequence: number }>;
  locktime: number;
}
interface BtcTxBuilder {
  setVersion(v: number): void;
  setLockTime(v: number): void;
  addInput(txid: string, vout: number, sequence?: number): number;
  addOutput(script: Buffer, value: number): number;
  buildIncomplete(): BtcTx;
}

function btcBuilder(network: unknown): BtcTxBuilder {
  return utxolib.bitgo.createTransactionBuilderForNetwork(
    network as Parameters<typeof utxolib.bitgo.createTransactionBuilderForNetwork>[0],
  ) as unknown as BtcTxBuilder;
}

/** CLTV requires transaction version >= 1; 2 is today's standard. */
const BTC_TX_VERSION = 2;

/**
 * The P2SH address the user funds. Everything about the swap's BTC leg is committed to
 * by this one string, so it is safe to publish and independently recomputable by the
 * counterparty from the same terms.
 */
export function btcHtlcAddress(terms: HtlcTerms, net: BitcoinNet): string {
  const network = btcUtxoNetwork(net);
  const scriptHash = bcrypto.hash160(htlcRedeemScript(terms));
  return baddress.toBase58Check(scriptHash, network.scriptHash, network);
}

/** The scriptPubKey of the HTLC output: OP_HASH160 <scriptHash> OP_EQUAL. */
export function btcHtlcOutputScript(terms: HtlcTerms, _net: BitcoinNet): Buffer {
  return htlcP2shOutputScript(terms);
}

/** A UTXO sitting at the HTLC address. `valueZat` = satoshi (shared field name — the
 * chain adapters report every UTXO chain's base unit under one name). */
export interface BtcHtlcUtxo {
  txid: string;
  vout: number;
  valueZat: number;
}

export interface BtcSpendOptions {
  terms: HtlcTerms;
  utxo: BtcHtlcUtxo;
  /** Bitcoin address receiving the swept funds. */
  destination: string;
  net: BitcoinNet;
  signer: Signer;
  /** Fee in satoshi — compute from a live rate with `btcSpendFee()`. Bitcoin fees are a
   * market, so unlike the ZEC leg there is no safe flat default; the caller must decide. */
  feeSat: number;
}

interface BuiltBtcSpend {
  /** Raw transaction hex, ready to broadcast. */
  hex: string;
  txid: string;
  feeSat: number;
  valueSat: number;
}

/** Assemble the unsigned legacy tx spending the HTLC utxo to `destination`. The fee is
 * deducted from the claimed value — a claim pays for its own broadcast. */
function buildBtcSkeleton(o: BtcSpendOptions, lockTime: number) {
  if (!Number.isInteger(o.feeSat) || o.feeSat <= 0) {
    throw new Error(`feeSat must be a positive integer satoshi amount, got ${o.feeSat}`);
  }
  const network = btcUtxoNetwork(o.net);
  const valueSat = o.utxo.valueZat - o.feeSat;
  if (valueSat <= 0) {
    throw new Error(
      `HTLC utxo ${o.utxo.valueZat} sat does not cover the ${o.feeSat} sat fee — nothing to sweep`,
    );
  }
  const txb = btcBuilder(network);
  txb.setVersion(BTC_TX_VERSION);
  txb.setLockTime(lockTime);
  txb.addInput(o.utxo.txid, o.utxo.vout, SEQUENCE_CLTV);
  txb.addOutput(baddress.toOutputScript(o.destination, network), valueSat);
  return { txb, valueSat };
}

/** Sign the single P2SH input with the ORIGINAL legacy sighash and attach the hand-built
 * scriptSig (the library's P2SH templating cannot know to push a preimage or selector). */
function finalizeBtc(
  txb: BtcTxBuilder,
  o: BtcSpendOptions,
  redeemScript: Buffer,
  branchSelector: number,
  extraWitness: Buffer[],
  valueSat: number,
): BuiltBtcSpend {
  const tx = txb.buildIncomplete();
  const sighash = tx.hashForSignature(0, redeemScript, SIGHASH_ALL);
  const signature = bscript.signature.encode(o.signer.sign(sighash), SIGHASH_ALL);
  const scriptSig = bscript.compile([
    signature,
    o.signer.publicKey,
    ...extraWitness,
    branchSelector,
    redeemScript,
  ]);
  tx.setInputScript(0, scriptSig);
  return { hex: tx.toBuffer().toString('hex'), txid: tx.getId(), feeSat: o.feeSat, valueSat };
}

/**
 * Build the CLAIM spend: reveals `preimage` on the Bitcoin chain — which is precisely how
 * the counterparty learns the secret to finish the other leg. Requires the claimant key.
 */
export function buildBtcClaimTx(o: BtcSpendOptions & { preimage: Buffer }): BuiltBtcSpend {
  const redeemScript = htlcRedeemScript(o.terms);
  if (!hashlockOf(o.preimage).equals(o.terms.hashlock)) {
    throw new Error('preimage does not hash to this HTLC’s hashlock — refusing to build a claim');
  }
  if (!o.signer.publicKey.equals(o.terms.claimantPubkey)) {
    throw new Error('signer is not the claimant for this HTLC');
  }
  // The claim path is not timelocked, so nLockTime is free; 0 keeps it spendable now.
  const { txb, valueSat } = buildBtcSkeleton(o, 0);
  return finalizeBtc(txb, o, redeemScript, opcodes.OP_1, [o.preimage], valueSat);
}

/**
 * Build the REFUND spend: only valid once the chain height reaches `timeoutHeight`.
 * `nLockTime` must be at/after the timeout for OP_CHECKLOCKTIMEVERIFY to pass, and the
 * network will not relay the tx until the tip actually reaches it.
 */
export function buildBtcRefundTx(o: BtcSpendOptions & { tipHeight: number }): BuiltBtcSpend {
  const redeemScript = htlcRedeemScript(o.terms);
  if (!o.signer.publicKey.equals(o.terms.refundPubkey)) {
    throw new Error('signer is not the refund party for this HTLC');
  }
  if (o.tipHeight < o.terms.timeoutHeight) {
    throw new Error(
      `HTLC has not timed out: tip ${o.tipHeight} < timeout ${o.terms.timeoutHeight}`,
    );
  }
  const { txb, valueSat } = buildBtcSkeleton(o, o.terms.timeoutHeight);
  return finalizeBtc(txb, o, redeemScript, opcodes.OP_0, [], valueSat);
}
