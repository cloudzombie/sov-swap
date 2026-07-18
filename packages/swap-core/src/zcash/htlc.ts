/**
 * Zcash transparent HTLC — the ZEC leg of an XUS↔ZEC atomic swap.
 *
 * A P2SH output whose redeem script has two mutually-exclusive spend paths:
 *
 *   claim  — anyone who knows the preimage of `hashlock` AND holds the claimant key
 *   refund — the funder, but only once the chain passes `timeoutHeight` (CLTV)
 *
 * The hashlock is a SINGLE SHA-256 of the raw secret, which is exactly what Zcash's
 * `OP_SHA256` computes and exactly what the SOV chain's `HtlcClaim` verifies
 * (`sha256(preimage) == hashlock`). That shared primitive — nothing else — is what
 * makes the two legs atomic: revealing the secret to take one side mathematically
 * publishes it for the other side to take too.
 *
 * Only TRANSPARENT ZEC can do this. Shielded (Sapling/Orchard) has no script and no
 * `OP_SHA256`, so it cannot participate in an HTLC swap.
 *
 * The redeem script:
 *
 *   OP_IF
 *     OP_SHA256 <hashlock> OP_EQUALVERIFY
 *     OP_DUP OP_HASH160 <claimantPubkeyHash>
 *   OP_ELSE
 *     <timeoutHeight> OP_CHECKLOCKTIMEVERIFY OP_DROP
 *     OP_DUP OP_HASH160 <refundPubkeyHash>
 *   OP_ENDIF
 *   OP_EQUALVERIFY
 *   OP_CHECKSIG
 *
 * Spends:
 *   claim  scriptSig = <sig> <pubkey> <preimage> OP_1 <redeemScript>
 *   refund scriptSig = <sig> <pubkey> OP_0        <redeemScript>
 */
import * as utxolib from '@bitgo/utxo-lib';
import {
  SIGHASH_ALL,
  SEQUENCE_CLTV,
  htlcRedeemScript,
  hashlockOf,
  pubkeyHash,
  parsePreimageFromScriptSig,
  type HtlcTerms,
  type Signer,
} from '../htlc-script.js';
import {
  branchIdAtHeight,
  DEFAULT_EXPIRY_DELTA,
  utxoNetwork,
  zip317Fee,
  type ZcashNet,
} from './network.js';

const { opcodes, script: bscript, crypto: bcrypto, address: baddress } = utxolib;

/**
 * The concrete Zcash builder/tx surface we use. `createTransactionBuilderForNetwork`
 * is typed as the generic base builder, but for a Zcash network it returns a
 * ZcashTransactionBuilder whose Sapling/NU setters (`setConsensusBranchId`,
 * `setVersionGroupId`, `setExpiryHeight`) and the ZIP-243/244 sighash
 * (`hashForSignatureByNetwork`) are exactly what an HTLC spend needs. We narrow to a
 * structural interface rather than reach for `any`.
 */
interface ZcashTx {
  hashForSignatureByNetwork(
    inIndex: number,
    prevOutScript: Buffer,
    value: number | bigint | undefined,
    hashType: number,
  ): Buffer;
  setInputScript(index: number, script: Buffer): void;
  toBuffer(): Buffer;
  getId(): string;
  ins: Array<{ script: Buffer; sequence: number }>;
  locktime: number;
}
interface ZcashTxBuilder {
  setVersion(v: number): void;
  setVersionGroupId(v: number): void;
  setConsensusBranchId(v: number): void;
  setExpiryHeight(v: number): void;
  setLockTime(v: number): void;
  addInput(txid: string, vout: number, sequence?: number): number;
  addOutput(script: Buffer, value: number): number;
  buildIncomplete(): ZcashTx;
}

function zcashBuilder(network: unknown): ZcashTxBuilder {
  return utxolib.bitgo.createTransactionBuilderForNetwork(
    network as Parameters<typeof utxolib.bitgo.createTransactionBuilderForNetwork>[0],
  ) as unknown as ZcashTxBuilder;
}

/** Zcash v4 (Sapling) transparent transaction — the format our HTLC spends use. */
const ZCASH_VERSION_SAPLING = 4;
const ZCASH_VERSION_GROUP_ID_SAPLING = 0x892f2085;

/**
 * The P2SH address funds are sent to. This is the string we show the user — everything
 * about the swap's ZEC leg is committed to by this one address, so it is safe to publish
 * and can be independently recomputed by the counterparty from the same terms.
 *
 * NOTE: we deliberately do NOT use bitcoinjs `payments.p2sh().address`. Zcash's base58
 * version prefixes are TWO bytes (mainnet P2SH 0x1cbd → `t3…`),
 * while upstream bitcoinjs writes a single version byte and throws on anything > 255.
 * `utxolib.address` is the Zcash-aware encoder that handles the wide prefix.
 */
export function htlcAddress(terms: HtlcTerms, net: ZcashNet): string {
  const network = utxoNetwork(net);
  const scriptHash = bcrypto.hash160(htlcRedeemScript(terms));
  return baddress.toBase58Check(scriptHash, network.scriptHash, network);
}

/** The scriptPubKey of the HTLC output: OP_HASH160 <scriptHash> OP_EQUAL. */
export function htlcOutputScript(terms: HtlcTerms, net: ZcashNet): Buffer {
  void net; // the P2SH output script is network-independent; the address encoding is not
  return bscript.compile([
    opcodes.OP_HASH160,
    bcrypto.hash160(htlcRedeemScript(terms)),
    opcodes.OP_EQUAL,
  ]);
}

/** A UTXO sitting at the HTLC address, as reported by a chain API. */
export interface HtlcUtxo {
  txid: string;
  vout: number;
  /** Value in zatoshi (1e-8 ZEC). */
  valueZat: number;
}

export interface SpendOptions {
  terms: HtlcTerms;
  utxo: HtlcUtxo;
  /** Transparent address receiving the swept funds. */
  destination: string;
  net: ZcashNet;
  /** Current chain tip — selects the consensus branch id and sets expiry. */
  tipHeight: number;
  signer: Signer;
  /** Override the fee (zatoshi). Defaults to the ZIP-317 conventional fee. */
  feeZat?: number;
  /** Override the expiry height. Defaults to tip + DEFAULT_EXPIRY_DELTA. */
  expiryHeight?: number;
}

interface BuiltSpend {
  /** Raw transaction hex, ready to broadcast. */
  hex: string;
  txid: string;
  feeZat: number;
  valueZat: number;
  consensusBranchId: number;
}

/**
 * Assemble an unsigned Zcash v4 transparent tx spending the HTLC utxo to `destination`.
 * The fee is deducted from the claimed value — which is what lets the desk operate with
 * zero pre-funded ZEC: a claim pays for its own broadcast out of the money it claims.
 */
function buildSpendSkeleton(o: SpendOptions, lockTime: number) {
  const network = utxoNetwork(o.net);
  const feeZat = o.feeZat ?? zip317Fee(1, 1);
  const valueZat = o.utxo.valueZat - feeZat;
  if (valueZat <= 0) {
    throw new Error(
      `HTLC utxo ${o.utxo.valueZat} zat does not cover the ${feeZat} zat fee — nothing to sweep`,
    );
  }
  const branchId = branchIdAtHeight(o.net, o.tipHeight);

  const txb = zcashBuilder(network);
  txb.setVersion(ZCASH_VERSION_SAPLING);
  txb.setVersionGroupId(ZCASH_VERSION_GROUP_ID_SAPLING);
  txb.setConsensusBranchId(branchId);
  txb.setExpiryHeight(o.expiryHeight ?? o.tipHeight + DEFAULT_EXPIRY_DELTA);
  txb.setLockTime(lockTime);
  txb.addInput(o.utxo.txid, o.utxo.vout, SEQUENCE_CLTV);
  txb.addOutput(baddress.toOutputScript(o.destination, network), valueZat);

  return { txb, feeZat, valueZat, branchId };
}

/**
 * Sign the single P2SH input and attach `scriptSig`, then serialize.
 *
 * We build the scriptSig by hand rather than using the standard P2SH input builder: an
 * HTLC is a non-standard spend path, and the library's templating would not know to push
 * the preimage or the branch selector.
 */
function finalize(
  txb: ReturnType<typeof buildSpendSkeleton>['txb'],
  o: SpendOptions,
  redeemScript: Buffer,
  branchSelector: number,
  extraWitness: Buffer[],
  meta: { feeZat: number; valueZat: number; branchId: number },
): BuiltSpend {
  // buildIncomplete() gives us the tx object to sighash against without requiring the
  // builder to understand our custom input script.
  const tx = txb.buildIncomplete();
  const sighash = tx.hashForSignatureByNetwork(0, redeemScript, o.utxo.valueZat, SIGHASH_ALL);
  const signature = bscript.signature.encode(o.signer.sign(sighash), SIGHASH_ALL);

  const scriptSig = bscript.compile([
    signature,
    o.signer.publicKey,
    ...extraWitness,
    branchSelector,
    redeemScript,
  ]);
  tx.setInputScript(0, scriptSig);

  return {
    hex: tx.toBuffer().toString('hex'),
    txid: tx.getId(),
    feeZat: meta.feeZat,
    valueZat: meta.valueZat,
    consensusBranchId: meta.branchId,
  };
}

/**
 * Build the CLAIM spend: reveals `preimage` on the Zcash chain, which is precisely how
 * the counterparty learns the secret to finish the other leg. Requires the claimant key.
 */
export function buildClaimTx(o: SpendOptions & { preimage: Buffer }): BuiltSpend {
  const redeemScript = htlcRedeemScript(o.terms);
  if (!hashlockOf(o.preimage).equals(o.terms.hashlock)) {
    throw new Error('preimage does not hash to this HTLC’s hashlock — refusing to build a claim');
  }
  if (!o.signer.publicKey.equals(o.terms.claimantPubkey)) {
    throw new Error('signer is not the claimant for this HTLC');
  }
  // The claim path is not timelocked, so nLockTime is free; 0 keeps it spendable now.
  const { txb, feeZat, valueZat, branchId } = buildSpendSkeleton(o, 0);
  return finalize(txb, o, redeemScript, opcodes.OP_1, [o.preimage], { feeZat, valueZat, branchId });
}

/**
 * Build the REFUND spend: only valid once the chain height reaches `timeoutHeight`.
 * `nLockTime` must be at/after the timeout for OP_CHECKLOCKTIMEVERIFY to pass, and the
 * network will not relay the tx until the tip actually reaches it.
 */
export function buildRefundTx(o: SpendOptions): BuiltSpend {
  const redeemScript = htlcRedeemScript(o.terms);
  if (!o.signer.publicKey.equals(o.terms.refundPubkey)) {
    throw new Error('signer is not the refund party for this HTLC');
  }
  if (o.tipHeight < o.terms.timeoutHeight) {
    throw new Error(
      `HTLC has not timed out: tip ${o.tipHeight} < timeout ${o.terms.timeoutHeight}`,
    );
  }
  const { txb, feeZat, valueZat, branchId } = buildSpendSkeleton(o, o.terms.timeoutHeight);
  return finalize(txb, o, redeemScript, opcodes.OP_0, [], { feeZat, valueZat, branchId });
}

// Re-export the shared script surface under this module's historical names.
export { htlcRedeemScript, hashlockOf, pubkeyHash, parsePreimageFromScriptSig };
export type { HtlcTerms, Signer };
