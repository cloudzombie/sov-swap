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
import { Desk, type CreateSwapRequest } from './desk.js';
import { PriceService } from './price.js';
import type { SwapState } from '@sov-swap/core';

const cfg = loadConfig();
const store = new SwapStore(cfg.dataDir);
const desk = new Desk(cfg, store);
const price = new PriceService(() => desk.currentRate(), cfg.dataDir);

/** Public view of a swap — only what the browser needs, no internal bookkeeping. */
function publicView(s: SwapState) {
  return {
    id: s.terms.id,
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
      const [q, inv] = [desk.quote(), await desk.inventoryXus()];
      return send(res, 200, { ...q, deskAccount: desk.xusAccount(), inventoryXus: inv });
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
      const body = (await readBody(req)) as CreateSwapRequest;
      for (const f of ['hashlock', 'zecRefundPubkey', 'xusRecipient', 'zecAmountZat'] as const) {
        if (body[f] === undefined) return send(res, 400, { error: `missing field ${f}` });
      }
      const s = await desk.createSwap(body);
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
  console.log(`[coordinator] rate ${cfg.rateXusPerZec} XUS / ZEC, bounds ${cfg.minZec}–${cfg.maxZec} ZEC`);
  void pollLoop();
});
