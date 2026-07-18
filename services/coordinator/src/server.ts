/**
 * Coordinator HTTP server + poll loop.
 *
 * Serves the small API the swap desk web app talks to, and on a timer drives every active
 * swap one step through the desk. Deliberately dependency-light (node:http) so it runs on
 * the faucet droplet with nothing to install.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { loadConfig } from './config.js';
import { SwapStore } from './store.js';
import { Desk } from './desk.js';
import { CrossRateService } from './crossrate.js';
import { PriceService } from './price.js';
import type { SwapCoin, SwapState } from '@sov-swap/core';

const cfg = loadConfig();
const store = new SwapStore(cfg.dataDir);
const crossRate =
  cfg.autoCrossRate && cfg.rateXusPerBtc
    ? new CrossRateService(
        cfg.rateXusPerZec,
        cfg.rateXusPerBtc,
        {
          floor: cfg.btcRateFloor!,
          ceil: cfg.btcRateCeil!,
          maxStepPct: cfg.btcRateMaxStepPct,
          staleAfterMs: cfg.btcRateStaleMin * 60_000,
        },
        cfg.dataDir,
      )
    : null;
const desk = new Desk(cfg, store, crossRate);
const price = new PriceService(() => desk.currentRate(), cfg.dataDir);

/** Public view of a swap — only what the browser needs, no internal bookkeeping. */
function publicView(s: SwapState) {
  return {
    id: s.terms.id,
    coin: s.terms.coin ?? 'ZEC',
    phase: s.phase,
    net: cfg.net,
    zecHtlcAddress: s.terms.zecHtlcAddress,
    zecAmountZat: s.terms.zecAmountZat,
    zecTimeoutHeight: s.terms.zecTimeoutHeight,
    xusRecipient: s.terms.xusRecipient,
    xusAmountGrains: s.terms.xusAmountGrains,
    xusTimeoutHeight: s.terms.xusTimeoutHeight,
    deskXusHtlcId: s.deskXusHtlcId ?? null,
    zecSweepTxid: s.zecSweepTxid ?? null,
    note: s.note ?? null,
    createdAt: s.createdAt ?? null,
  };
}

function send(res: ServerResponse, status: number, body: unknown): void {
  const json = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json',
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET, POST, OPTIONS',
    'access-control-allow-headers': 'content-type',
  });
  res.end(json);
}

async function readBody(req: IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > 64 * 1024) throw new Error('request body too large');
    chunks.push(c as Buffer);
  }
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
}

/** The validated ?coin= query param, or null when absent. Throws on unknown coins. */
function coinParam(url: URL): SwapCoin | null {
  const c = url.searchParams.get('coin');
  if (!c) return null;
  const up = c.toUpperCase() as SwapCoin;
  if (!desk.coins().includes(up)) throw new Error(`unknown coin ${c}`);
  return up;
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
  try {
    if (req.method === 'OPTIONS') return send(res, 204, {});

    if (req.method === 'GET' && url.pathname === '/api/health') {
      return send(res, 200, { ok: true, net: cfg.net });
    }

    // SOV JSON-RPC passthrough. The web app is https (Vercel) and the relay RPC is
    // plain http, so a browser can't call the node directly (mixed content). This relays
    // the browser's own SIGNED transaction / read calls to the node — it can't forge
    // anything (the tx is already signed) and exposes no desk secret.
    if (req.method === 'POST' && url.pathname === '/api/sov') {
      const body = await readBody(req);
      const upstream = await fetch(cfg.sovRpcUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      return send(res, upstream.status, await upstream.json());
    }

    if (req.method === 'GET' && url.pathname === '/api/quote') {
      const coin = coinParam(url) ?? 'ZEC';
      const q = desk.quote(coin);
      const curve = await desk.curveProjection(41, coin);
      return send(res, 200, { ...q, deskAccount: desk.xusAccount(), ...curve, coins: desk.coins() });
    }

    // The live bonding curve across every XUS currently held by the desk.
    if (req.method === 'GET' && url.pathname === '/api/curve') {
      const n = Number(url.searchParams.get('points')) || 81;
      return send(res, 200, await desk.curveProjection(n, coinParam(url) ?? 'ZEC'));
    }

    // Public tape: successful swaps only. These records exist only after the ZEC funding
    // output was confirmed, the XUS HTLC was observed/claimed on SOV, and the desk's ZEC
    // sweep was accepted for broadcast. Failed, pending, and refunded attempts never leak
    // into the tape.
    if (req.method === 'GET' && url.pathname === '/api/trades') {
      const trades = store
        .all()
        .filter(
          (s) =>
            s.phase === 'zec_swept' &&
            s.zecFundingUtxo?.txid &&
            s.zecSweepTxid &&
            s.deskXusHtlcId,
        )
        .map((s) => {
          const zecAmount = s.terms.zecAmountZat / 100_000_000;
          const xusAmount = Number(BigInt(s.terms.xusAmountGrains)) / 100_000_000;
          return {
            id: s.terms.id,
            coin: s.terms.coin ?? 'ZEC',
            createdAt: s.createdAt ?? null,
            zecAmount,
            xusAmount,
            xusPerZec: xusAmount / zecAmount,
            zecPerXus: zecAmount / xusAmount,
            zecFundingTxid: s.zecFundingUtxo!.txid,
            zecSweepTxid: s.zecSweepTxid,
            xusLockTxid: s.deskXusHtlcId,
          };
        });
      return send(res, 200, { trades });
    }

    // Live XUS reference price (ZEC/USD ÷ the desk rate).
    if (req.method === 'GET' && url.pathname === '/api/price') {
      const p = await price.now();
      if (!p) return send(res, 503, { error: 'price source unavailable' });
      return send(res, 200, p);
    }

    // Rolling price history for a sparkline/chart.
    if (req.method === 'GET' && url.pathname === '/api/price/history') {
      const n = Number(url.searchParams.get('points')) || undefined;
      return send(res, 200, { points: price.historyPoints(n), rateXusPerZec: desk.currentRate() });
    }

    if (req.method === 'POST' && url.pathname === '/api/swap') {
      const body = await readBody(req);
      // Field aliases: the pre-BTC client sent zec-named fields; accept both forms.
      const reqBody = {
        hashlock: body.hashlock,
        refundPubkey: body.refundPubkey ?? body.zecRefundPubkey,
        xusRecipient: body.xusRecipient,
        amountBaseUnits: body.amountBaseUnits ?? body.zecAmountZat,
        coin: (body.coin ?? 'ZEC') as SwapCoin,
      };
      for (const f of ['hashlock', 'refundPubkey', 'xusRecipient', 'amountBaseUnits'] as const) {
        if (reqBody[f] === undefined) return send(res, 400, { error: `missing field ${f}` });
      }
      if (!desk.coins().includes(reqBody.coin)) {
        return send(res, 400, { error: `coin ${reqBody.coin} not enabled on this desk` });
      }
      const s = await desk.createSwap(reqBody);
      return send(res, 201, publicView(s));
    }

    const m = url.pathname.match(/^\/api\/swap\/([\w-]+)$/);
    if (req.method === 'GET' && m) {
      const s = store.get(m[1]);
      if (!s) return send(res, 404, { error: 'swap not found' });
      return send(res, 200, publicView(s));
    }

    return send(res, 404, { error: 'not found' });
  } catch (e) {
    return send(res, 400, { error: (e as Error).message });
  }
});

const POLL_MS = 15_000;
async function pollLoop(): Promise<void> {
  for (;;) {
    try {
      await crossRate?.update();
      await desk.tick();
      await price.maybeSample();
    } catch (e) {
      console.error('[poll] tick error:', (e as Error).message);
    }
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
}

server.listen(cfg.httpPort, () => {
  console.log(`[coordinator] ${cfg.net} desk listening on :${cfg.httpPort}`);
  console.log(`[coordinator] XUS inventory account ${desk.xusAccount()}`);
  for (const coin of desk.coins()) {
    const q = desk.quote(coin);
    console.log(`[coordinator] ${coin}: base ${q.baseRate} XUS / ${coin}, bounds ${q.minZec}–${q.maxZec} ${coin}`);
  }
  void pollLoop();
});
