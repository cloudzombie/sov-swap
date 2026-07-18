/**
 * The market-maker desk — the trusted operator process that holds the seeded XUS and the
 * desk's ZEC key, turns the swap machine's decisions into real chain operations, and
 * observes both chains.
 *
 * Non-custodial toward the USER (the HTLC guarantees they can always refund), but the
 * desk's OWN inventory lives here, so every action is guarded: it only commits XUS after
 * the machine says it's safe, and it only ever sweeps ZEC it has the on-chain-revealed
 * secret for.
 */
import * as utxolib from '@bitgo/utxo-lib';
import { SovClient, HybridKeypair } from '@sov/sdk';
import {
  makeZcashChain,
  htlcAddress,
  htlcOutputScript,
  buildClaimTx,
  planTimeouts,
  lockXus,
  transferXus,
  claimXus as _claimXus, // (user-side; unused here but kept for parity)
  refundXus,
  getHtlc,
  findRevealedPreimage,
  decide,
  type ZcashChain,
  type HtlcTerms as ZecHtlcTerms,
  type SwapState,
  type SwapTerms,
  type Observation,
  type ChainClock,
} from '@sov-swap/core';
import type { Config } from './config.js';
import { ZAT_PER_ZEC, GRAINS_PER_XUS } from './config.js';
import type { SwapStore } from './store.js';

const { ECPair } = utxolib;

/** Wall-clock block times (seconds) used to translate timeouts to/from heights. */
const SOV_BLOCK_TIME_SEC = 60;
const ZEC_BLOCK_TIME_SEC = 75;

/** XUS the desk seeds a fresh recipient so it can pay the `htlc_claim` network fee. A new
 * 0-balance account cannot otherwise afford the claim (chicken-and-egg). Small desk
 * overhead; the recipient nets ~the quoted amount after the fee. */
const FEE_BOOTSTRAP_GRAINS = 5_000_000n; // 0.05 XUS

export interface CreateSwapRequest {
  /** 32-byte SHA-256 hashlock (hex) chosen by the user's browser. */
  hashlock: string;
  /** The user's Zcash refund pubkey (33-byte compressed, hex) — the key that can reclaim
   * the ZEC if the swap doesn't complete. */
  zecRefundPubkey: string;
  /** The user's XUS account id (64-hex) that receives the bought XUS. */
  xusRecipient: string;
  /** How much ZEC the user will lock, in zatoshi. */
  zecAmountZat: number;
}

export interface Quote {
  /** Current (curve-adjusted) XUS per ZEC. */
  rateXusPerZec: number;
  /** Base rate before the sales curve. */
  baseRate: number;
  /** XUS sold so far (drives the curve). */
  soldXus: number;
  /** Curve scale (XUS per halving); 0 = fixed rate. */
  curveK: number;
  minZec: number;
  maxZec: number;
  net: string;
}

export interface CurvePoint {
  /** Additional desk inventory purchased from the current state. */
  purchasedXus: number;
  /** Marginal exchange rate at this point on the curve. */
  xusPerZec: number;
  /** Marginal price of one XUS at this point. */
  zecPerXus: number;
  /** Total ZEC spent to reach this point along the continuous curve. */
  cumulativeZec: number;
}

export interface CurveProjection {
  points: CurvePoint[];
  inventoryXus: number;
  buyAllZec: number;
  currentZecPerXus: number;
  finalZecPerXus: number;
}

export class Desk {
  private readonly sov: SovClient;
  private readonly zec: ZcashChain;
  private readonly xusKey: HybridKeypair;
  private readonly zecKey: any;
  private readonly zecNetwork: any;
  private readonly zecSweepAddress: string;
  private ids = 0;

  constructor(
    private readonly cfg: Config,
    private readonly store: SwapStore,
  ) {
    this.sov = new SovClient({ endpoint: cfg.sovRpcUrl });
    this.zec = makeZcashChain(cfg.net, { apiKey: cfg.blockchairApiKey ?? undefined });
    this.xusKey = HybridKeypair.fromSeed(Buffer.from(cfg.sovMmSeedHex, 'hex'));
    this.zecNetwork = utxolib.networks.zcash;
    // The secp256k1 keypair is network-agnostic, but vanilla ECPair's typeforce rejects
    // Zcash's two-byte `pubKeyHash`. Zcash mainnet reuses Bitcoin's 0x80 WIF version,
    // so we decode/sign under the Bitcoin network
    // and use the real Zcash network only where it matters — address encoding and the
    // ZIP-243 sighash inside the tx builder.
    this.zecKey = ECPair.fromWIF(cfg.zecMmWif, utxolib.networks.bitcoin);
    this.zecSweepAddress =
      cfg.zecSweepAddress ??
      utxolib.address.toBase58Check(
        utxolib.crypto.hash160(Buffer.from(this.zecKey.publicKey)),
        this.zecNetwork.pubKeyHash,
        this.zecNetwork,
      );
  }

  /** The desk's XUS account id (where its inventory lives). */
  xusAccount(): string {
    return this.xusKey.publicKey.accountId();
  }

  /** The desk's Zcash claimant pubkey (baked into every HTLC so the desk can sweep). */
  private zecClaimantPubkey(): Buffer {
    return Buffer.from(this.zecKey.publicKey);
  }

  /** Total XUS the desk has SOLD (completed swaps) — the input to the price curve. */
  soldXus(): number {
    let grains = 0n;
    for (const s of this.store.all()) {
      if (s.phase === 'zec_swept') grains += BigInt(s.terms.xusAmountGrains);
    }
    return Number(grains / GRAINS_PER_XUS);
  }

  /**
   * The current rate (XUS per ZEC), which FALLS as XUS sells — so each XUS costs more ZEC,
   * i.e. the XUS price rises with demand. `rate = base / (1 + sold/K)`; `K` is the XUS that
   * must sell to halve the rate (double the price). `CURVE_K=0` disables it (fixed rate).
   */
  currentRate(): number {
    const base = this.cfg.rateXusPerZec;
    if (this.cfg.curveK <= 0) return base;
    return base / (1 + this.soldXus() / this.cfg.curveK);
  }

  quote(): Quote {
    return {
      rateXusPerZec: this.currentRate(),
      baseRate: this.cfg.rateXusPerZec,
      soldXus: this.soldXus(),
      curveK: this.cfg.curveK,
      minZec: this.cfg.minZec,
      maxZec: this.cfg.maxZec,
      net: this.cfg.net,
    };
  }

  /** Live XUS inventory available to sell, in whole XUS. */
  async inventoryXus(): Promise<number> {
    const bal = await this.sov.getBalance(this.xusAccount());
    return Number(BigInt(bal) / GRAINS_PER_XUS);
  }

  /**
   * Project the configured sales curve across the desk's LIVE wallet inventory.
   *
   * The swap engine sells at `base / (1 + sold/K)` XUS per ZEC. Treating purchases as
   * continuous gives dZEC/dXUS = (1 + sold/K) / base; integrating that marginal price
   * produces the exact area under the displayed curve and the ZEC required to exhaust
   * the wallet. Fixed-rate desks are the K=0 special case.
   */
  async curveProjection(pointCount = 41): Promise<CurveProjection> {
    const inventoryXus = await this.inventoryXus();
    const sold = this.soldXus();
    const base = this.cfg.rateXusPerZec;
    const k = this.cfg.curveK;
    const count = Math.max(2, Math.min(201, Math.floor(pointCount)));

    const marginalPrice = (purchased: number): number =>
      k > 0 ? (1 + (sold + purchased) / k) / base : 1 / base;
    const cumulativeCost = (purchased: number): number =>
      k > 0
        ? purchased / base + (sold * purchased + (purchased * purchased) / 2) / (k * base)
        : purchased / base;

    const points = Array.from({ length: count }, (_, i) => {
      const purchasedXus = inventoryXus * (i / (count - 1));
      const zecPerXus = marginalPrice(purchasedXus);
      return {
        purchasedXus,
        zecPerXus,
        xusPerZec: 1 / zecPerXus,
        cumulativeZec: cumulativeCost(purchasedXus),
      };
    });

    return {
      points,
      inventoryXus,
      buyAllZec: cumulativeCost(inventoryXus),
      currentZecPerXus: marginalPrice(0),
      finalZecPerXus: marginalPrice(inventoryXus),
    };
  }

  /**
   * Create a swap: compute terms + timeouts, derive the ZEC HTLC address the user funds,
   * persist, and return what the browser needs. No desk funds are committed here — that
   * only happens once the user's ZEC is confirmed.
   */
  async createSwap(reqBody: CreateSwapRequest): Promise<SwapState> {
    const zecAmountZat = Math.round(reqBody.zecAmountZat);
    const zecAmt = zecAmountZat / ZAT_PER_ZEC;
    if (zecAmt < this.cfg.minZec || zecAmt > this.cfg.maxZec) {
      throw new Error(`amount ${zecAmt} ZEC out of bounds [${this.cfg.minZec}, ${this.cfg.maxZec}]`);
    }
    // Lock the CURRENT curve-adjusted rate into this swap's terms.
    const rate = this.currentRate();
    const xusOut = zecAmt * rate;
    const xusAmountGrains = (BigInt(Math.round(xusOut * 1e8)) * GRAINS_PER_XUS) / 100_000_000n;

    // Inventory check: don't quote a swap we can't fill.
    const inv = await this.inventoryXus();
    if (xusOut > inv) throw new Error(`insufficient desk inventory: need ${xusOut} XUS, have ${inv}`);

    const [zecTip, sovTip] = await Promise.all([this.zec.tipHeight(), this.sov.getHeight()]);
    const zecClock: ChainClock = { tip: zecTip, blockTimeSec: ZEC_BLOCK_TIME_SEC };
    const sovClock: ChainClock = { tip: sovTip, blockTimeSec: SOV_BLOCK_TIME_SEC };
    const timeouts = planTimeouts({ zec: zecClock, sov: sovClock });

    const zecTerms: ZecHtlcTerms = {
      hashlock: Buffer.from(reqBody.hashlock, 'hex'),
      claimantPubkey: this.zecClaimantPubkey(),
      refundPubkey: Buffer.from(reqBody.zecRefundPubkey, 'hex'),
      timeoutHeight: timeouts.zecTimeoutHeight,
    };
    const zecHtlcAddress = htlcAddress(zecTerms, this.cfg.net);

    const id = `swap_${Date.now().toString(36)}_${(this.ids++).toString(36)}`;
    const terms: SwapTerms = {
      id,
      hashlock: reqBody.hashlock.toLowerCase(),
      zecHtlcAddress,
      zecAmountZat,
      zecTimeoutHeight: timeouts.zecTimeoutHeight,
      xusRecipient: reqBody.xusRecipient,
      xusAmountGrains: xusAmountGrains.toString(),
      xusTimeoutHeight: timeouts.xusTimeoutHeight,
    };
    const state: SwapState = { terms, phase: 'awaiting_zec_lock', createdAt: Date.now() };
    // Stash the user's ZEC refund pubkey so a redeem script can be rebuilt for the sweep.
    (state as any).zecRefundPubkey = reqBody.zecRefundPubkey;
    this.store.put(state);
    return state;
  }

  /** Snapshot both chains for the machine's decision. */
  private async observe(s: SwapState): Promise<Observation> {
    const [zecTip, sovTip] = await Promise.all([this.zec.tipHeight(), this.sov.getHeight()]);
    const zec: ChainClock = { tip: zecTip, blockTimeSec: ZEC_BLOCK_TIME_SEC };
    const sov: ChainClock = { tip: sovTip, blockTimeSec: SOV_BLOCK_TIME_SEC };

    // ZEC funding at the HTLC address (largest utxo >= expected).
    let zecFunding: Observation['zecFunding'] = null;
    if (['awaiting_zec_lock', 'zec_confirmed'].includes(s.phase) || !s.zecFundingUtxo) {
      const utxos = await this.zec.utxos(s.terms.zecHtlcAddress);
      const best = utxos.sort((a, b) => b.valueZat - a.valueZat)[0];
      if (best) {
        zecFunding = { valueZat: best.valueZat, confirmations: best.confirmations };
        if (best.confirmations > 0 && !s.zecFundingUtxo) {
          s.zecFundingUtxo = { txid: best.txid, vout: best.vout, valueZat: best.valueZat };
        }
      }
    } else if (s.zecFundingUtxo) {
      zecFunding = { valueZat: s.zecFundingUtxo.valueZat, confirmations: 999 };
    }

    // Desk's XUS escrow + preimage reveal.
    let deskXusEscrowExists = false;
    let revealedPreimage: string | null = s.preimage ?? null;
    if (s.deskXusHtlcId) {
      const esc = await getHtlc(this.sov, s.deskXusHtlcId);
      deskXusEscrowExists = esc !== null;
      if (!deskXusEscrowExists && !revealedPreimage && s.xusLockHeight) {
        const pre = await findRevealedPreimage(this.sov, {
          htlcId: s.deskXusHtlcId,
          expectedHashlock: s.terms.hashlock,
          fromHeight: s.xusLockHeight,
          toHeight: sovTip,
        });
        if (pre) revealedPreimage = Buffer.from(pre).toString('hex');
      }
    }
    return { zec, sov, zecFunding, deskXusEscrowExists, revealedPreimage };
  }

  /** Advance one swap by one step. Returns the (possibly-updated) state. */
  async step(s: SwapState): Promise<SwapState> {
    const obs = await this.observe(s);
    if (obs.revealedPreimage && !s.preimage) s.preimage = obs.revealedPreimage;
    const action = decide(s, obs);

    switch (action.kind) {
      case 'wait':
      case 'done':
        break;

      case 'abort':
        s.phase = 'aborted';
        s.note = action.reason;
        break;

      case 'lock_xus': {
        const deskAcct = this.xusKey.publicKey.accountId();
        const nonce = await this.sov.getNonce(deskAcct);
        // Seed the recipient's claim fee FIRST (nonce N) — a fresh 0-balance account can't
        // pay the htlc_claim fee — then lock the XUS (nonce N+1) in the same tick.
        await transferXus(this.sov, this.xusKey, {
          to: s.terms.xusRecipient,
          amountGrains: FEE_BOOTSTRAP_GRAINS,
          nonce,
        });
        const res = await lockXus(this.sov, this.xusKey, {
          recipient: s.terms.xusRecipient,
          amountGrains: BigInt(s.terms.xusAmountGrains),
          hashlock: Buffer.from(s.terms.hashlock, 'hex'),
          timeoutHeight: s.terms.xusTimeoutHeight,
          nonce: nonce + 1,
        });
        s.deskXusHtlcId = res.txId;
        s.xusLockHeight = obs.sov.tip;
        s.phase = 'xus_locked';
        break;
      }

      case 'sweep_zec': {
        s.phase = 'xus_claimed';
        const swept = await this.sweepZec(s);
        if (swept) {
          s.zecSweepTxid = swept;
          s.phase = 'zec_swept';
        }
        break;
      }

      case 'refund_xus': {
        if (s.phase !== 'refunding_xus') s.phase = 'refunding_xus';
        if (s.deskXusHtlcId) {
          try {
            await refundXus(this.sov, this.xusKey, { htlcId: s.deskXusHtlcId });
          } catch {
            /* retried next tick; the escrow-gone check terminates it */
          }
        }
        if (!obs.deskXusEscrowExists) s.phase = 'xus_refunded';
        break;
      }
    }
    this.store.put(s);
    return s;
  }

  /** Build + broadcast the ZEC sweep using the revealed preimage and the desk's key. */
  private async sweepZec(s: SwapState): Promise<string | null> {
    if (!s.preimage || !s.zecFundingUtxo) return null;
    const zecTip = await this.zec.tipHeight();
    const zecTerms: ZecHtlcTerms = {
      hashlock: Buffer.from(s.terms.hashlock, 'hex'),
      claimantPubkey: this.zecClaimantPubkey(),
      refundPubkey: Buffer.from((s as any).zecRefundPubkey, 'hex'),
      timeoutHeight: s.terms.zecTimeoutHeight,
    };
    // Confirm the funding utxo really sits at our HTLC output before spending it.
    void htlcOutputScript(zecTerms, this.cfg.net);
    const built = buildClaimTx({
      terms: zecTerms,
      utxo: s.zecFundingUtxo,
      destination: this.zecSweepAddress,
      net: this.cfg.net,
      tipHeight: zecTip,
      signer: {
        publicKey: this.zecClaimantPubkey(),
        sign: (h: Buffer) => Buffer.from(this.zecKey.sign(h)),
      },
      preimage: Buffer.from(s.preimage, 'hex'),
    });
    return this.zec.broadcast(built.hex);
  }

  /** Drive every active swap one step. Called on a timer by the server. */
  async tick(): Promise<void> {
    for (const s of this.store.active()) {
      try {
        await this.step(s);
      } catch (e) {
        // Never let one swap's transient error stop the others; log and retry next tick.
        console.error(`[desk] swap ${s.terms.id} step error:`, (e as Error).message);
      }
    }
  }
}
