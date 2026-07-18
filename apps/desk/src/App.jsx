import { useEffect, useState, useCallback } from "react";
import {
  newSecret,
  newRefundKey,
  coinTxUrl,
  newXusWallet,
  makeApi,
  claimXus,
  saveActive,
  loadActive,
  clearActive,
  zatToZec,
  grainsToXus,
  shorten,
  ZAT,
} from "./lib/swap.js";

// Empty → same-origin (production: the app and the /api coordinator are served from the
// same host). Dev passes VITE_COORDINATOR_URL=http://localhost:8790.
const COORD = import.meta.env.VITE_COORDINATOR_URL || "";
const REPO = "https://github.com/cloudzombie/sov";

// The lifecycle, in the order the spine renders. Maps the coordinator's phases to the four
// things a user actually experiences.
const STAGES = [
  { key: "fund", label: "Lock your ZEC" },
  { key: "match", label: "Desk locks XUS" },
  { key: "claim", label: "Claim your XUS" },
  { key: "settle", label: "Settled" },
];

function stageIndex(phase) {
  switch (phase) {
    case "awaiting_zec_lock":
      return 0;
    case "zec_confirmed":
      return 1;
    case "xus_locked":
      return 2;
    case "xus_claimed":
    case "zec_swept":
      return 3;
    default:
      return 0;
  }
}

// Live XUS reference price + rolling history, from the coordinator.
function usePrice(api) {
  const [price, setPrice] = useState(null);
  const [hist, setHist] = useState([]);
  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const [p, h] = await Promise.all([
          fetch(`${api.base}/api/price`).then((r) => (r.ok ? r.json() : null)),
          fetch(`${api.base}/api/price/history?points=288`).then((r) => (r.ok ? r.json() : { points: [] })),
        ]);
        if (!alive) return;
        if (p) setPrice(p);
        if (h?.points) setHist(h.points);
      } catch {
        /* keep last */
      }
    };
    load();
    const t = setInterval(load, 60_000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [api.base]);
  return { price, hist };
}

function Sparkline({ points, w = 132, h = 34 }) {
  if (!points || points.length < 2) return null;
  const ys = points.map((p) => p.xusUsd);
  const min = Math.min(...ys);
  const max = Math.max(...ys);
  const span = max - min || 1;
  const step = w / (points.length - 1);
  const path = points
    .map((p, i) => `${i === 0 ? "M" : "L"}${(i * step).toFixed(1)},${(h - 4 - ((p.xusUsd - min) / span) * (h - 8)).toFixed(1)}`)
    .join(" ");
  const last = points[points.length - 1];
  const lx = w;
  const ly = h - 4 - ((last.xusUsd - min) / span) * (h - 8);
  const up = ys[ys.length - 1] >= ys[0];
  const stroke = up ? "var(--good)" : "var(--bad)";
  return (
    <svg className="spark" width={w} height={h} viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" aria-hidden="true">
      <defs>
        <linearGradient id="sg" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={stroke} stopOpacity="0.22" />
          <stop offset="100%" stopColor={stroke} stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={`${path} L${w},${h} L0,${h} Z`} fill="url(#sg)" stroke="none" />
      <path d={path} fill="none" stroke={stroke} strokeWidth="1.6" strokeLinejoin="round" strokeLinecap="round" />
      <circle cx={lx - 1.5} cy={ly} r="2.2" fill={stroke} />
    </svg>
  );
}

function PriceTracker({ price, hist, quote }) {
  const usd = price?.xusUsd;
  const change =
    hist.length > 1 && hist[0].xusUsd ? ((hist[hist.length - 1].xusUsd - hist[0].xusUsd) / hist[0].xusUsd) * 100 : null;
  const up = change != null && change >= 0;
  const curve = quote?.curveK > 0;
  return (
    <section className="pricebar">
      <div className="pb-main">
        <div className="pb-label">XUS reference price</div>
        <div className="pb-value">
          <span className="pb-usd">{usd != null ? `$${usd.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 4 })}` : "—"}</span>
          {change != null && (
            <span className={`pb-change ${up ? "up" : "down"}`}>
              {up ? "▲" : "▼"} {Math.abs(change).toFixed(2)}%
            </span>
          )}
        </div>
        <div className="pb-basis">
          {price ? (
            <>
              ZEC <b className="mono tick-zec">${price.zecUsd.toLocaleString(undefined, { maximumFractionDigits: 2 })}</b> ÷{" "}
              <b className="mono tick-xus">{price.rateXusPerZec.toLocaleString(undefined, { maximumFractionDigits: 2 })}</b> desk rate
            </>
          ) : (
            "live from the desk's swap rate"
          )}
        </div>
        {curve && (
          <div className="pb-curve">
            ▲ rises with every completed swap{quote.soldXus > 0 ? ` · ${quote.soldXus.toLocaleString()} XUS sold` : ""}
          </div>
        )}
      </div>
      <div className="pb-spark">
        <Sparkline points={hist} />
        {hist.length > 1 && <div className="pb-span">{hist.length >= 288 ? "24h" : `${hist.length} pts`}</div>}
      </div>
    </section>
  );
}

function fmt(value, digits = 6) {
  return Number(value).toLocaleString(undefined, { maximumFractionDigits: digits });
}

function BondingCurve({ quote }) {
  const c = quote?.coin ?? "ZEC";
  const points = quote?.points || [];
  const [selected, setSelected] = useState(0);
  if (!quote || points.length < 2) return null;

  const w = 560;
  const h = 220;
  const pad = { l: 58, r: 16, t: 18, b: 40 };
  const plotW = w - pad.l - pad.r;
  const plotH = h - pad.t - pad.b;
  const maxX = Math.max(quote.inventoryXus, 1);
  const prices = points.map((p) => p.zecPerXus);
  const minY = Math.min(...prices);
  const maxY = Math.max(...prices);
  const ySpan = maxY - minY || Math.max(maxY * 0.1, 1e-8);
  const x = (v) => pad.l + (v / maxX) * plotW;
  const y = (v) => pad.t + plotH - ((v - minY) / ySpan) * plotH;
  const path = points.map((p, i) => `${i ? "L" : "M"}${x(p.purchasedXus).toFixed(2)},${y(p.zecPerXus).toFixed(2)}`).join(" ");
  const chosen = points[Math.min(points.length - 1, Math.round((selected / 100) * (points.length - 1)))];
  const cx = x(chosen.purchasedXus);
  const cy = y(chosen.zecPerXus);

  return (
    <section className="curve-card" aria-labelledby="curve-title">
      <div className="curve-head">
        <div>
          <div className="eyebrow">Live desk inventory curve</div>
          <h2 id="curve-title">XUS price in {c}</h2>
        </div>
        <div className="buyout">
          <span>{c} to buy all {fmt(quote.inventoryXus, 2)} XUS</span>
          <b>{fmt(quote.buyAllZec, 8)} {c}</b>
        </div>
      </div>
      <div className="curve-chart">
        <svg viewBox={`0 0 ${w} ${h}`} role="img" aria-label={`Bonding curve from ${fmt(quote.currentZecPerXus, 8)} to ${fmt(quote.finalZecPerXus, 8)} ${c} per XUS`}>
          <defs>
            <linearGradient id="curve-fill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="var(--gold)" stopOpacity=".28" />
              <stop offset="100%" stopColor="var(--gold)" stopOpacity=".015" />
            </linearGradient>
          </defs>
          {[0, 0.5, 1].map((t) => {
            const gy = pad.t + plotH * t;
            return <line key={t} x1={pad.l} x2={w - pad.r} y1={gy} y2={gy} className="curve-grid" />;
          })}
          <path d={`${path} L${x(maxX)},${pad.t + plotH} L${pad.l},${pad.t + plotH} Z`} fill="url(#curve-fill)" />
          <path d={path} className="curve-line" />
          <line x1={cx} x2={cx} y1={cy} y2={pad.t + plotH} className="curve-guide" />
          <circle cx={cx} cy={cy} r="5" className="curve-dot" />
          <text x={pad.l - 8} y={pad.t + 4} className="axis-y" textAnchor="end">{fmt(maxY, 8)}</text>
          <text x={pad.l - 8} y={pad.t + plotH + 4} className="axis-y" textAnchor="end">{fmt(minY, 8)}</text>
          <text x={pad.l} y={h - 10} className="axis-x">0 XUS</text>
          <text x={w - pad.r} y={h - 10} className="axis-x" textAnchor="end">{fmt(quote.inventoryXus, 2)} XUS bought</text>
        </svg>
      </div>
      <input
        className="curve-scrub"
        type="range"
        min="0"
        max="100"
        value={selected}
        onChange={(e) => setSelected(Number(e.target.value))}
        aria-label="Inspect the bonding curve"
      />
      <div className="curve-readout" aria-live="polite">
        <div><span>Inventory bought</span><b>{fmt(chosen.purchasedXus, 2)} XUS</b></div>
        <div><span>Marginal price</span><b>{fmt(chosen.zecPerXus, 8)} {c} / XUS</b></div>
        <div><span>Rate there</span><b>{fmt(chosen.xusPerZec, 4)} XUS / {c}</b></div>
        <div><span>Cumulative cost</span><b>{fmt(chosen.cumulativeZec, 8)} {c}</b></div>
      </div>
      <p className="curve-note">
        Computed from the desk’s configured sales curve and live on-chain wallet balance. The total is
        the area under the marginal-price curve; network fees are not included.
      </p>
    </section>
  );
}

function TradeTape({ trades }) {
  return (
    <section className="tape-card" aria-labelledby="tape-title">
      <div className="tape-head">
        <div>
          <div className="eyebrow">On-chain proof</div>
          <h2 id="tape-title">Verified swap transactions</h2>
        </div>
        <span className="verified-pill"><span className="dot" /> {trades.length} completed</span>
      </div>
      {trades.length ? (
        <div className="tape-scroll">
          <div className="tape-grid tape-labels">
            <span>Coin transactions</span>
            <span>XUS transaction</span>
            <span>Price paid</span>
          </div>
          {trades.map((trade) => {
            const c = trade.coin ?? "ZEC";
            return (
              <article className="tape-grid trade-row" key={trade.id}>
                <div className="tx-col">
                  <a href={coinTxUrl(c, trade.zecFundingTxid)} target="_blank" rel="noreferrer">
                    <small>fund</small> {shorten(trade.zecFundingTxid, 7)}
                  </a>
                  <a href={coinTxUrl(c, trade.zecSweepTxid)} target="_blank" rel="noreferrer">
                    <small>sweep</small> {shorten(trade.zecSweepTxid, 7)}
                  </a>
                  <b>{fmt(trade.zecAmount, 8)} {c}</b>
                </div>
                <div className="tx-col">
                  <a href={`https://sovxus.org/#/tx/${trade.xusLockTxid}`} target="_blank" rel="noreferrer">
                    <small>HTLC</small> {shorten(trade.xusLockTxid, 7)}
                  </a>
                  <b>{fmt(trade.xusAmount, 8)} XUS</b>
                </div>
                <div className="paid-col">
                  <b>{fmt(trade.xusPerZec, 6)} XUS / {c}</b>
                  <span>{fmt(trade.zecPerXus, 8)} {c} / XUS</span>
                </div>
              </article>
            );
          })}
        </div>
      ) : (
        <div className="tape-empty">Completed swaps will appear here after both on-chain legs settle.</div>
      )}
    </section>
  );
}

function Copy({ text }) {
  const [ok, setOk] = useState(false);
  return (
    <button
      className="copy"
      onClick={() => {
        navigator.clipboard?.writeText(text);
        setOk(true);
        setTimeout(() => setOk(false), 1100);
      }}
    >
      {ok ? "copied" : "copy"}
    </button>
  );
}

function Data({ k, v, tone, copy = true }) {
  return (
    <div className={`data ${tone || ""}`}>
      {k && <span className="k">{k}</span>}
      <span>{v}</span>
      {copy && <Copy text={v} />}
    </div>
  );
}

export default function App() {
  const api = makeApi(COORD);
  const [coin, setCoin] = useState("ZEC");
  const [quote, setQuote] = useState(null);
  const [amount, setAmount] = useState("0.05");
  const [active, setActive] = useState(() => loadActive());
  const [swap, setSwap] = useState(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const [trades, setTrades] = useState([]);
  const { price, hist } = usePrice(api);

  // Load the quote for the selected coin (and keep the rate/inventory fresh).
  useEffect(() => {
    let alive = true;
    setQuote(null); // never show one coin's numbers under another coin's tab
    const load = () => api.quote(coin).then((q) => alive && setQuote(q)).catch(() => {});
    load();
    const t = setInterval(load, 20_000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [coin]); // eslint-disable-line

  useEffect(() => {
    let alive = true;
    const load = () => api.trades().then((rows) => alive && setTrades(rows)).catch(() => {});
    load();
    const t = setInterval(load, 20_000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []); // eslint-disable-line

  // Poll the active swap's on-chain status.
  const poll = useCallback(async () => {
    if (!active?.id) return;
    const s = await api.getSwap(active.id).catch(() => null);
    if (s) setSwap(s);
  }, [active?.id]); // eslint-disable-line

  useEffect(() => {
    if (!active?.id) return;
    poll();
    const t = setInterval(poll, active?.claimTxid ? 2500 : 5000);
    return () => clearInterval(t);
  }, [active?.id, active?.claimTxid, poll]);

  async function startSwap() {
    setErr(null);
    const amt = Number(amount);
    if (!quote || !(amt >= quote.minZec && amt <= quote.maxZec)) {
      setErr(`Enter an amount between ${quote?.minZec} and ${quote?.maxZec} ${coin}.`);
      return;
    }
    setBusy(true);
    try {
      // Everything secret is minted here, in the browser.
      const { secretHex, hashlock } = newSecret();
      const { refundPrivHex, refundPubkey } = newRefundKey();
      const xus = newXusWallet();
      const created = await api.createSwap({
        hashlock,
        refundPubkey,
        xusRecipient: xus.account,
        amountBaseUnits: Math.round(amt * ZAT),
        coin,
      });
      const rec = {
        id: created.id,
        coin,
        secretHex,
        refundPrivHex,
        refundPubkey,
        xusSeedHex: xus.xusSeedHex,
        account: xus.account,
      };
      saveActive(rec);
      setActive(rec);
      setSwap(created);
    } catch (e) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  }

  async function doClaim() {
    setErr(null);
    setBusy(true);
    try {
      const txid = await claimXus(api, {
        deskXusHtlcId: swap.deskXusHtlcId,
        secretHex: active.secretHex,
        xusSeedHex: active.xusSeedHex,
        account: active.account,
      });
      // The moment the chain accepted the broadcast: stamp it, persist it (survives
      // reloads), and let the claim heartbeat take over the ticket.
      const rec = { ...active, claimTxid: String(txid), claimAt: Date.now() };
      saveActive(rec);
      setActive(rec);
      await poll();
    } catch (e) {
      setErr(`Claim failed: ${e.message}`);
    } finally {
      setBusy(false);
    }
  }

  function reset() {
    clearActive();
    setActive(null);
    setSwap(null);
    setErr(null);
  }

  // XUS received for the entered ZEC, walking up the bonding curve — the same
  // closed-form inverse of the curve's cumulative cost that the desk locks into
  // the swap terms, so this preview matches the chart and the payout exactly.
  const zecIn = Number(amount) || 0;
  const xusOut = quote
    ? quote.curveK > 0
      ? quote.curveK *
        (Math.sqrt((1 + quote.soldXus / quote.curveK) ** 2 + (2 * zecIn * quote.baseRate) / quote.curveK) -
          (1 + quote.soldXus / quote.curveK))
      : zecIn * quote.baseRate
    : 0;

  return (
    <div className="shell">
      <header className="topbar">
        <a className="brand" href="/">
          <span className="mark">⚖</span> The Desk <small>· {coin} → XUS</small>
        </a>
        <div className="badges">
          {quote && <span className="badge net">mainnet</span>}
          <span className="badge">
            <span className="dot" /> live
          </span>
        </div>
      </header>

      <PriceTracker price={price} hist={hist} quote={quote} />

      <div className="coin-tabs" role="tablist" aria-label="Coin you pay with">
        {(quote?.coins ?? ["ZEC"]).map((c) => (
          <button
            key={c}
            role="tab"
            aria-selected={coin === c}
            className={`coin-tab ${coin === c ? "on" : ""}`}
            onClick={() => {
              if (c !== coin) setCoin(c);
            }}
          >
            {c} → XUS
          </button>
        ))}
      </div>

      <section className="rate">
        <div>
          <div className="lede">Trustless atomic swap — no bridge, no custodian</div>
          <div className="pair">
            <span className="big tick-zec">1 {coin}</span>
            <span className="arrow">→</span>
            <span className="big tick-xus">{quote ? quote.rateXusPerZec.toLocaleString() : "—"} XUS</span>
          </div>
        </div>
        <div className="inv">
          desk inventory
          <b>{quote ? `${quote.inventoryXus.toLocaleString()} XUS` : "—"}</b>
        </div>
      </section>

      <BondingCurve quote={quote} />

      {!active ? (
        <QuoteForm
          quote={quote}
          coin={coin}
          amount={amount}
          setAmount={setAmount}
          xusOut={xusOut}
          onStart={startSwap}
          busy={busy}
          err={err}
        />
      ) : (
        <Ticket
          swap={swap}
          active={active}
          onClaim={doClaim}
          onReset={reset}
          busy={busy}
          err={err}
        />
      )}

      <TradeTape trades={trades} />

      <footer className="foot">
        <div>
          One 32-byte secret locks both chains. Reveal it to take one leg, and you've published it to
          take the other — atomic by construction.
        </div>
        <div style={{ marginTop: 8 }}>
          <a href={REPO} target="_blank" rel="noreferrer">
            source
          </a>{" "}
          · <a href="https://sovxus.org" target="_blank" rel="noreferrer">explorer</a> ·{" "}
          <a href="https://sovxus.com" target="_blank" rel="noreferrer">sovereign</a>
        </div>
      </footer>
    </div>
  );
}

function QuoteForm({ quote, coin, amount, setAmount, xusOut, onStart, busy, err }) {
  return (
    <div className="card fade-in">
      <div className="card-h">
        <h2>New swap</h2>
        <span className="sub">you send {coin}, you receive XUS</span>
      </div>
      <div className="card-b">
        <div className="field">
          <label>You send</label>
          <div className="amt-row">
            <div className="amt-in">
              <input
                inputMode="decimal"
                value={amount}
                onChange={(e) => setAmount(e.target.value.replace(/[^0-9.]/g, ""))}
                placeholder="0.00"
              />
              <span className="unit tick-zec">{coin}</span>
            </div>
          </div>
          {quote && (
            <div className="hint">
              min {quote.minZec} · max {quote.maxZec} {coin} · desk pays out from{" "}
              <code>{shorten(quote.deskAccount, 6)}</code>
            </div>
          )}
        </div>

        <div className="field">
          <label>You receive</label>
          <div className="you-get">
            <span className="n">{xusOut.toLocaleString(undefined, { maximumFractionDigits: 8 })} XUS</span>
            <span className="l">
              at {quote ? fmt(Number(amount) > 0 ? xusOut / Number(amount) : quote.rateXusPerZec, 6) : "—"} XUS / {coin}
            </span>
          </div>
        </div>

        {err && <div className="callout bad" style={{ marginBottom: 14 }}>{err}</div>}

        <button className="btn btn-gold" onClick={onStart} disabled={busy || !quote}>
          {busy ? <span className="spin" /> : null}
          {busy ? "Preparing swap…" : "Start swap"}
        </button>
        <div className="hint" style={{ marginTop: 10 }}>
          A fresh secret, a {coin} refund key, and a new XUS wallet are generated in your browser.
          Nothing secret ever leaves this device.
        </div>
      </div>
    </div>
  );
}

const swept = (swap) => swap?.phase === "zec_swept";

function Ticket({ swap, active, onClaim, onReset, busy, err }) {
  const phase = swap?.phase || "awaiting_zec_lock";
  const idx = stageIndex(phase);
  const aborted = phase === "aborted";
  const refunded = phase === "xus_refunded" || phase === "refunding_xus";
  const settled = phase === "zec_swept" || phase === "xus_claimed";

  // On reload the saved swap's live status hasn't been fetched yet. Render a light loading
  // state (with recovery data) instead of dereferencing a null `swap` and crashing.
  if (!swap) {
    return (
      <div className="card fade-in">
        <div className="card-h">
          <h2>Swap in progress</h2>
          <span className="sub mono">{shorten(active.id, 6)}</span>
        </div>
        <div className="card-b">
          <p style={{ color: "var(--muted)", fontSize: 13, margin: 0 }}>
            <span className="spin gold" /> Loading swap status…
          </p>
          <Recovery active={active} swap={null} />
          <button className="btn btn-ghost" style={{ marginTop: 16 }} onClick={onReset}>
            Abandon this swap
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="card fade-in">
      <div className="card-h">
        <h2>{settled ? "Swap complete" : aborted || refunded ? "Swap ended" : "Swap in progress"}</h2>
        <span className="sub mono">{shorten(active.id, 6)}</span>
      </div>
      <div className="card-b">
        {active.claimTxid ? (
          <>
            <ClaimProgress api={makeApi(COORD)} swap={swap} active={active} />
            {swept(swap) && <SettledView swap={swap} active={active} />}
          </>
        ) : settled ? (
          <SettledView swap={swap} active={active} />
        ) : aborted ? (
          <div className="callout bad">
            This swap was not matched: {swap.note || "terms could not be honored"}. No XUS was ever
            committed. If you already sent {swap.coin ?? "ZEC"}, reclaim it with your refund key after block{" "}
            <b className="mono">{swap.zecTimeoutHeight}</b> — recovery data is below.
          </div>
        ) : refunded ? (
          <div className="callout warn">
            The desk reclaimed its XUS (you didn't claim in time). Reclaim your {swap.coin ?? "ZEC"} with your
            refund key after block <b className="mono">{swap.zecTimeoutHeight}</b>.
          </div>
        ) : (
          <ol className="spine">
            {STAGES.map((st, i) => (
              <li key={st.key} className={`step ${i < idx ? "done" : i === idx ? "active" : "pending"}`}>
                <span className="node">{i < idx ? "✓" : i + 1}</span>
                <h3>{st.label}</h3>
                <StepBody stage={st.key} idx={idx} i={i} swap={swap} active={active} onClaim={onClaim} busy={busy} />
              </li>
            ))}
          </ol>
        )}

        {err && <div className="callout bad" style={{ marginTop: 14 }}>{err}</div>}

        {!settled && <Recovery active={active} swap={swap} />}

        <button className="btn btn-ghost" style={{ marginTop: 16 }} onClick={onReset}>
          {settled ? "Start another swap" : "Abandon this swap"}
        </button>
      </div>
    </div>
  );
}

function StepBody({ stage, idx, i, swap, active, onClaim, busy }) {
  if (i > idx) return null; // future step: header only
  const c = swap.coin ?? active?.coin ?? "ZEC";
  const chainName = c === "BTC" ? "Bitcoin" : "Zcash";

  if (stage === "fund" && idx === 0) {
    return (
      <div className="detail">
        <p>
          Send exactly <b className="mono tick-zec">{zatToZec(swap.zecAmountZat)} {c}</b> to this
          one-time escrow address. It's a hash-timelock contract — only the secret in your browser can
          release it to the desk, and only your refund key can return it to you.
        </p>
        <Data k={c} v={swap.zecHtlcAddress} tone="steel" />
        <div className="safety">
          <span className="shield">🛡</span>
          <span>
            Fully refundable to you after {chainName} block <b>{swap.zecTimeoutHeight}</b> if the swap
            doesn't complete. Waiting for your deposit to confirm…
          </span>
        </div>
      </div>
    );
  }

  if (stage === "match" && idx === 1) {
    return (
      <div className="detail">
        <p>
          Your {c} is confirmed. The desk is locking <b className="mono tick-xus">{grainsToXus(swap.xusAmountGrains)} XUS</b>{" "}
          into a matching contract for you on Sovereign…
        </p>
      </div>
    );
  }

  if (stage === "claim" && idx === 2) {
    return (
      <div className="detail">
        <p>
          The desk has locked your XUS. Claim it now — this reveals your secret, which simultaneously
          lets the desk take the {c}. One click finishes both legs.
        </p>
        <Data k="XUS HTLC" v={swap.deskXusHtlcId} copy />
        <button className="btn btn-gold" style={{ marginTop: 12 }} onClick={onClaim} disabled={busy}>
          {busy ? <span className="spin" /> : "⚡"} Claim {grainsToXus(swap.xusAmountGrains)} XUS
        </button>
      </div>
    );
  }

  return null;
}

/**
 * The claim heartbeat — live, unambiguous feedback from the instant the claim tx is
 * broadcast until the swap is fully settled. Three verifiable stages, each flipping
 * green on REAL on-chain evidence: (1) the claim txid the chain accepted, (2) the XUS
 * balance actually landing in the user's new wallet (polled every 2.5s straight from
 * the chain through the desk's RPC tunnel), (3) the desk's sweep tx on the coin chain.
 */
function ClaimProgress({ api, swap, active }) {
  const [balanceGrains, setBalanceGrains] = useState(null);
  const [nowTs, setNowTs] = useState(Date.now());
  const expectGrains = BigInt(swap.xusAmountGrains ?? 0);
  const arrived = balanceGrains !== null && BigInt(balanceGrains) >= expectGrains;
  const swept = swap.phase === "zec_swept" && !!swap.zecSweepTxid;
  const c = swap.coin ?? active?.coin ?? "ZEC";

  useEffect(() => {
    let alive = true;
    const client = api.sovClient();
    const tick = () =>
      client.getBalance(active.account).then((b) => alive && setBalanceGrains(b)).catch(() => {});
    tick();
    const t = setInterval(tick, 2500);
    const clock = setInterval(() => setNowTs(Date.now()), 1000);
    return () => {
      alive = false;
      clearInterval(t);
      clearInterval(clock);
    };
  }, [active.account]); // eslint-disable-line

  const secs = Math.max(0, Math.floor((nowTs - (active.claimAt ?? nowTs)) / 1000));
  const steps = [
    {
      key: "broadcast",
      done: true,
      label: "Claim broadcast — accepted by the chain",
      body: (
        <a href={`https://sovxus.org/#/tx/${active.claimTxid}`} target="_blank" rel="noreferrer" className="mono">
          {shorten(active.claimTxid, 8)} ↗
        </a>
      ),
    },
    {
      key: "arrive",
      done: arrived,
      label: arrived
        ? `${grainsToXus(swap.xusAmountGrains)} XUS is in your wallet`
        : "XUS landing in your wallet…",
      body: (
        <span className="mono">
          {balanceGrains !== null ? `balance ${grainsToXus(balanceGrains)} XUS` : "reading balance…"}
        </span>
      ),
    },
    {
      key: "sweep",
      done: swept,
      label: swept
        ? `Desk swept the ${c} — swap complete`
        : `Desk sweeping the ${c} with your revealed secret…`,
      body: swept ? (
        <a href={coinTxUrl(c, swap.zecSweepTxid)} target="_blank" rel="noreferrer" className="mono">
          {shorten(swap.zecSweepTxid, 8)} ↗
        </a>
      ) : null,
    },
  ];
  const activeIdx = steps.findIndex((st) => !st.done);

  return (
    <div className="claim-hb" role="status" aria-live="polite">
      <div className="hb-head">
        <span className="hb-beat" aria-hidden="true" />
        <b>{swept ? "Settled" : "Settling"}</b>
        <span className="hb-clock mono">{Math.floor(secs / 60)}:{String(secs % 60).padStart(2, "0")}</span>
      </div>
      {steps.map((st, i) => (
        <div key={st.key} className={`hb-step ${st.done ? "done" : i === activeIdx ? "live" : "pending"}`}>
          <span className="hb-node">{st.done ? "✓" : i === activeIdx ? <span className="hb-pulse" /> : "·"}</span>
          <div>
            <div className="hb-label">{st.label}</div>
            {st.body && <div className="hb-body">{st.body}</div>}
          </div>
        </div>
      ))}
    </div>
  );
}

function SettledView({ swap, active }) {
  const c = swap.coin ?? active?.coin ?? "ZEC";
  return (
    <div className="fade-in">
      <div className="rail">
        <span className="z">{zatToZec(swap.zecAmountZat)} {c}</span>
        <span className="link" />
        <span className="x">{grainsToXus(swap.xusAmountGrains)} XUS</span>
      </div>
      <div className="callout good" style={{ marginTop: 12 }}>
        Done. Your XUS is in your new wallet — keep its seed (below) to spend it.
      </div>
      <Data k="XUS account" v={active.account} />
      {swap.zecSweepTxid && <Data k={`${c} sweep`} v={swap.zecSweepTxid} tone="steel" />}
      <div className="keybox">
        <h4>⚠ SAVE YOUR XUS WALLET SEED</h4>
        <p className="hint" style={{ marginTop: 0 }}>
          This is the only key to the XUS you just bought. Store it somewhere safe — losing it loses the
          funds.
        </p>
        <Data k="seed" v={active.xusSeedHex} />
      </div>
    </div>
  );
}

function Recovery({ active, swap }) {
  const c = swap?.coin ?? active?.coin ?? "ZEC";
  // Pre-BTC records saved the refund key under zecPrivHex.
  const refundKey = active.refundPrivHex ?? active.zecPrivHex;
  return (
    <div className="keybox">
      <h4>⚠ RECOVERY DATA — SAVE BEFORE SENDING {c}</h4>
      <p className="hint" style={{ marginTop: 0 }}>
        Keep this until the swap completes. Your XUS wallet seed receives the XUS; your {c} refund key
        reclaims your {c} if the swap fails.
      </p>
      <Data k="XUS seed" v={active.xusSeedHex} />
      <Data k={`${c} refund key`} v={refundKey} tone="steel" />
    </div>
  );
}
