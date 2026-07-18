/**
 * The market-maker desk — the trusted operator process that holds the seeded XUS and the
 * desk's coin keys, turns the swap machine's decisions into real chain operations, and
 * observes every chain.
 *
 * Non-custodial toward the USER (the HTLC guarantees they can always refund), but the
 * desk's OWN inventory lives here, so every action is guarded: it only commits XUS after
 * the machine says it's safe, and it only ever sweeps a coin it has the on-chain-revealed
 * secret for.
 *
 * COINS. The user's leg is a UTXO coin — ZEC always, BTC when the operator configures a
 * key + rate. Each coin is a self-contained `CoinLeg` (chain client, desk key, HTLC
 * builders, clock, confirmation policy, base rate); everything below is written against
 * the leg, so adding a coin means adding a leg, not another code path.
 */
import * as utxolib from '@bitgo/utxo-lib';
import { SovClient, HybridKeypair } from '@sov/sdk';
import {
  makeZcashChain,
  makeBitcoinChain,
  htlcAddress as zecHtlcAddressOf,
  buildClaimTx as buildZecClaimTx,
  btcHtlcAddress as btcHtlcAddressOf,
  buildBtcClaimTx,
  btcSpendFee,
  BTC_BLOCK_TIME_SEC,
  planTimeouts,
  lockXus,
  transferXus,
  refundXus,
  getHtlc,
  findRevealedPreimage,
  decide,
  type Utxo,
  type TxInput,
  type HtlcTerms,
  type SwapCoin,
  type SwapState,
  type SwapTerms,
  type Observation,
  type ChainClock,
} from '@sov-swap/core';
import type { Config } from './config.js';
import type { CrossRateService } from './crossrate.js';
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

/** Everything one user-side coin needs, in one place. */
interface CoinLeg {
  coin: SwapCoin;
  chain: {
    tipHeight(): Promise<number>;
    utxos(address: string): Promise<Utxo[]>;
    broadcast(rawHex: string): Promise<string>;
    txInputs(txid: string): Promise<TxInput[]>;
  };
  key: any; // secp256k1 ECPair (desk claimant key on this chain)
  sweepAddress: string;
  /** Starting XUS per 1 coin — this coin's base quote before the shared sales curve.
   * Returns null when the coin's pricing is UNAVAILABLE (e.g. a stale auto-cross-rate);
   * an unavailable coin is not quoted at all — fail closed, never quote stale. */
  baseRate: () => number | null;
  min: number;
  max: number;
  blockTimeSec: number;
  /** Confirmations of the user's funding before the desk commits XUS (re-org exposure). */
  minConfirmations: number;
  htlcAddress(terms: HtlcTerms): string;
  /** Build the desk's claim (sweep) of the user's HTLC using the revealed preimage. */
  buildClaim(args: {
    terms: HtlcTerms;
    utxo: { txid: string; vout: number; valueZat: number };
    preimage: Buffer;
  }): Promise<{ hex: string }>;
}

export interface CreateSwapRequest {
  /** 32-byte SHA-256 hashlock (hex) chosen by the user's browser. */
  hashlock: string;
  /** The user's refund pubkey on the coin chain (33-byte compressed, hex) — the key that
   * can reclaim the coin if the swap doesn't complete. */
  refundPubkey: string;
  /** The user's XUS account id (64-hex) that receives the bought XUS. */
  xusRecipient: string;
  /** How much of the coin the user will lock, in base units (zatoshi / satoshi). */
  amountBaseUnits: number;
  /** Which coin the user brings. Default ZEC. */
  coin?: SwapCoin;
}

export interface Quote {
  coin: SwapCoin;
  /** Current (curve-adjusted) XUS per coin. */
  rateXusPerZec: number;
  /** Base rate before the sales curve. */
  baseRate: number;
  /** XUS sold so far, ALL coins combined (drives the shared curve). */
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
  /** Total coin spent to reach this point along the continuous curve. */
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
  private readonly xusKey: HybridKeypair;
  private readonly legs = new Map<SwapCoin, CoinLeg>();
  private ids = 0;

  constructor(
    private readonly cfg: Config,
    private readonly store: SwapStore,
    /** Present when AUTO_CROSS_RATE is on — drives the BTC leg's base rate. */
    private readonly crossRate: CrossRateService | null = null,
  ) {
    this.sov = new SovClient({ endpoint: cfg.sovRpcUrl });
    this.xusKey = HybridKeypair.fromSeed(Buffer.from(cfg.sovMmSeedHex, 'hex'));

    // ── ZEC leg (always on) ──────────────────────────────────────────────────
    const zecChain = makeZcashChain(cfg.net, { apiKey: cfg.blockchairApiKey ?? undefined });
    // The secp256k1 keypair is network-agnostic, but vanilla ECPair's typeforce rejects
    // Zcash's two-byte `pubKeyHash`. Zcash mainnet reuses Bitcoin's 0x80 WIF version, so
    // we decode/sign under the Bitcoin network and use the real Zcash network only where
    // it matters — address encoding and the ZIP-243 sighash inside the tx builder.
    const zecKey = ECPair.fromWIF(cfg.zecMmWif, utxolib.networks.bitcoin);
    const zecNetwork = utxolib.networks.zcash;
    this.legs.set('ZEC', {
      coin: 'ZEC',
      chain: zecChain,
      key: zecKey,
      sweepAddress:
        cfg.zecSweepAddress ??
        utxolib.address.toBase58Check(
          utxolib.crypto.hash160(Buffer.from(zecKey.publicKey)),
          zecNetwork.pubKeyHash,
          zecNetwork,
        ),
      baseRate: () => cfg.rateXusPerZec,
      min: cfg.minZec,
      max: cfg.maxZec,
      blockTimeSec: ZEC_BLOCK_TIME_SEC,
      minConfirmations: 3,
      htlcAddress: (t) => zecHtlcAddressOf(t, cfg.net),
      buildClaim: async ({ terms, utxo, preimage }) => {
        const tip = await zecChain.tipHeight();
        return buildZecClaimTx({
          terms,
          utxo,
          destination: this.legs.get('ZEC')!.sweepAddress,
          net: cfg.net,
          tipHeight: tip,
          signer: { publicKey: Buffer.from(zecKey.publicKey), sign: (h) => Buffer.from(zecKey.sign(h)) },
          preimage,
        });
      },
    });

    // ── BTC leg (operator-enabled) ───────────────────────────────────────────
    if (cfg.btcMmWif && cfg.rateXusPerBtc) {
      const btcChain = makeBitcoinChain('mainnet');
      const btcKey = ECPair.fromWIF(cfg.btcMmWif, utxolib.networks.bitcoin);
      this.legs.set('BTC', {
        coin: 'BTC',
        chain: btcChain,
        key: btcKey,
        sweepAddress:
          cfg.btcSweepAddress ??
          utxolib.address.toBase58Check(
            utxolib.crypto.hash160(Buffer.from(btcKey.publicKey)),
            utxolib.networks.bitcoin.pubKeyHash,
            utxolib.networks.bitcoin,
          ),
        baseRate: () => (this.crossRate ? this.crossRate.current() : cfg.rateXusPerBtc),
        min: cfg.minBtc,
        max: cfg.maxBtc,
        blockTimeSec: BTC_BLOCK_TIME_SEC,
        // BTC re-orgs are the shallowest of any chain; 2 confirmations (~20 min) is the
        // usual exchange bar for small amounts and keeps the swap humane to sit through.
        minConfirmations: 2,
        htlcAddress: (t) => btcHtlcAddressOf(t, 'mainnet'),
        buildClaim: async ({ terms, utxo, preimage }) => {
          const rate = await btcChain.feeRateSatVb();
          return buildBtcClaimTx({
            terms,
            utxo,
            destination: this.legs.get('BTC')!.sweepAddress,
            net: 'mainnet',
            signer: { publicKey: Buffer.from(btcKey.publicKey), sign: (h) => Buffer.from(btcKey.sign(h)) },
            preimage,
            feeSat: btcSpendFee('claim', rate),
          });
        },
      });
    }
  }

  /** The coins this desk is quoting RIGHT NOW (a coin with unavailable pricing —
   * e.g. a stale auto-cross-rate — drops out until pricing recovers). */
  coins(): SwapCoin[] {
    return [...this.legs.values()].filter((l) => l.baseRate() !== null).map((l) => l.coin);
  }

  private leg(coin: SwapCoin): CoinLeg {
    const l = this.legs.get(coin);
    if (!l) throw new Error(`${coin} swaps are not enabled on this desk`);
    return l;
  }

  /** This coin's live base rate; throws rather than price from nothing. */
  private baseRateOf(coin: SwapCoin): number {
    const r = this.leg(coin).baseRate();
    if (r === null) throw new Error(`${coin} pricing is unavailable (stale cross-rate) — quoting is paused`);
    return r;
  }

  private legOf(s: SwapState): CoinLeg {
    return this.leg(s.terms.coin ?? 'ZEC');
  }

  /** The desk's XUS account id (where its inventory lives). */
  xusAccount(): string {
    return this.xusKey.publicKey.accountId();
  }

  /** Total XUS the desk has SOLD (completed swaps, all coins) — the input to the price
   * curve. One shared curve: the price of the inventory rises with demand no matter which
   * coin paid for it. */
  soldXus(): number {
    let grains = 0n;
    for (const s of this.store.all()) {
      if (s.phase === 'zec_swept') grains += BigInt(s.terms.xusAmountGrains);
    }
    return Number(grains / GRAINS_PER_XUS);
  }

  /**
   * The current rate (XUS per coin), which FALLS as XUS sells — so each XUS costs more,
   * i.e. the XUS price rises with demand. `rate = base / (1 + sold/K)`; `K` is the XUS
   * that must sell to halve the rate (double the price). `CURVE_K=0` disables it.
   */
  currentRate(coin: SwapCoin = 'ZEC'): number {
    const base = this.baseRateOf(coin);
    if (this.cfg.curveK <= 0) return base;
    return base / (1 + this.soldXus() / this.cfg.curveK);
  }

  /**
   * XUS delivered for `amountIn` of `coin`, walking the marginal price along the sales
   * curve — the exact inverse of `curveProjection`'s cumulative cost, so a swap pays out
   * precisely what the displayed bonding curve says that coin buys. Solving
   * `z = p/base + (sold·p + p²/2)/(k·base)` for p gives the closed form below.
   * K=0 (fixed rate) stays linear.
   */
  xusFor(amountIn: number, coin: SwapCoin = 'ZEC'): number {
    const base = this.baseRateOf(coin);
    const k = this.cfg.curveK;
    if (k <= 0) return amountIn * base;
    const b = 1 + this.soldXus() / k;
    return k * (Math.sqrt(b * b + (2 * amountIn * base) / k) - b);
  }

  quote(coin: SwapCoin = 'ZEC'): Quote {
    const leg = this.leg(coin);
    return {
      coin,
      rateXusPerZec: this.currentRate(coin),
      baseRate: this.baseRateOf(coin),
      soldXus: this.soldXus(),
      curveK: this.cfg.curveK,
      minZec: leg.min,
      maxZec: leg.max,
      net: this.cfg.net,
    };
  }

  /** Live XUS inventory available to sell, in whole XUS. */
  async inventoryXus(): Promise<number> {
    const bal = await this.sov.getBalance(this.xusAccount());
    return Number(BigInt(bal) / GRAINS_PER_XUS);
  }

  /**
   * Project the configured sales curve across the desk's LIVE wallet inventory, priced
   * in `coin`. The engine sells at `base / (1 + sold/K)` XUS per coin; integrating the
   * marginal price gives the exact area under the displayed curve and the coin required
   * to exhaust the wallet. Fixed-rate desks are the K=0 special case.
   */
  async curveProjection(pointCount = 41, coin: SwapCoin = 'ZEC'): Promise<CurveProjection> {
    const inventoryXus = await this.inventoryXus();
    const sold = this.soldXus();
    const base = this.baseRateOf(coin);
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
   * Create a swap: compute terms + timeouts, derive the coin HTLC address the user funds,
   * persist, and return what the browser needs. No desk funds are committed here — that
   * only happens once the user's coin is confirmed.
   */
  async createSwap(reqBody: CreateSwapRequest): Promise<SwapState> {
    const coin: SwapCoin = reqBody.coin ?? 'ZEC';
    const leg = this.leg(coin);
    const amountBaseUnits = Math.round(reqBody.amountBaseUnits);
    const amt = amountBaseUnits / ZAT_PER_ZEC; // both coins are 1e8 base units
    if (amt < leg.min || amt > leg.max) {
      throw new Error(`amount ${amt} ${coin} out of bounds [${leg.min}, ${leg.max}]`);
    }
    // Lock the curve-integrated payout into this swap's terms: the XUS this coin buys
    // walking up the bonding curve, matching the displayed curve exactly.
    const xusOut = this.xusFor(amt, coin);
    const xusAmountGrains = (BigInt(Math.round(xusOut * 1e8)) * GRAINS_PER_XUS) / 100_000_000n;

    // Inventory check: don't quote a swap we can't fill.
    const inv = await this.inventoryXus();
    if (xusOut > inv) throw new Error(`insufficient desk inventory: need ${xusOut} XUS, have ${inv}`);

    const [coinTip, sovTip] = await Promise.all([leg.chain.tipHeight(), this.sov.getHeight()]);
    const coinClock: ChainClock = { tip: coinTip, blockTimeSec: leg.blockTimeSec };
    const sovClock: ChainClock = { tip: sovTip, blockTimeSec: SOV_BLOCK_TIME_SEC };
    // planTimeouts' `zec` slot is the user's UTXO-coin leg (see SwapTerms naming note).
    const timeouts = planTimeouts({ zec: coinClock, sov: sovClock });

    const htlcTerms: HtlcTerms = {
      hashlock: Buffer.from(reqBody.hashlock, 'hex'),
      claimantPubkey: Buffer.from(leg.key.publicKey),
      refundPubkey: Buffer.from(reqBody.refundPubkey, 'hex'),
      timeoutHeight: timeouts.zecTimeoutHeight,
    };
    const htlcAddr = leg.htlcAddress(htlcTerms);

    const id = `swap_${Date.now().toString(36)}_${(this.ids++).toString(36)}`;
    const terms: SwapTerms = {
      id,
      coin,
      hashlock: reqBody.hashlock.toLowerCase(),
      zecHtlcAddress: htlcAddr,
      zecAmountZat: amountBaseUnits,
      zecTimeoutHeight: timeouts.zecTimeoutHeight,
      xusRecipient: reqBody.xusRecipient,
      xusAmountGrains: xusAmountGrains.toString(),
      xusTimeoutHeight: timeouts.xusTimeoutHeight,
    };
    const state: SwapState = { terms, phase: 'awaiting_zec_lock', createdAt: Date.now() };
    // Stash the user's refund pubkey so a redeem script can be rebuilt for the sweep.
    (state as any).zecRefundPubkey = reqBody.refundPubkey;
    this.store.put(state);
    return state;
  }

  /** Snapshot the coin chain + SOV for the machine's decision. */
  private async observe(s: SwapState): Promise<Observation> {
    const leg = this.legOf(s);
    const [coinTip, sovTip] = await Promise.all([leg.chain.tipHeight(), this.sov.getHeight()]);
    const zec: ChainClock = { tip: coinTip, blockTimeSec: leg.blockTimeSec };
    const sov: ChainClock = { tip: sovTip, blockTimeSec: SOV_BLOCK_TIME_SEC };

    // Coin funding at the HTLC address (largest utxo >= expected).
    let zecFunding: Observation['zecFunding'] = null;
    if (['awaiting_zec_lock', 'zec_confirmed'].includes(s.phase) || !s.zecFundingUtxo) {
      const utxos = await leg.chain.utxos(s.terms.zecHtlcAddress);
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
    const leg = this.legOf(s);
    const obs = await this.observe(s);
    if (obs.revealedPreimage && !s.preimage) s.preimage = obs.revealedPreimage;
    const action = decide(s, obs, { minZecConfirmations: leg.minConfirmations });

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
        const swept = await this.sweepCoin(s);
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

  /** Build + broadcast the coin sweep using the revealed preimage and the desk's key. */
  private async sweepCoin(s: SwapState): Promise<string | null> {
    if (!s.preimage || !s.zecFundingUtxo) return null;
    const leg = this.legOf(s);
    const terms: HtlcTerms = {
      hashlock: Buffer.from(s.terms.hashlock, 'hex'),
      claimantPubkey: Buffer.from(leg.key.publicKey),
      refundPubkey: Buffer.from((s as any).zecRefundPubkey, 'hex'),
      timeoutHeight: s.terms.zecTimeoutHeight,
    };
    const built = await leg.buildClaim({
      terms,
      utxo: s.zecFundingUtxo,
      preimage: Buffer.from(s.preimage, 'hex'),
    });
    return leg.chain.broadcast(built.hex);
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
