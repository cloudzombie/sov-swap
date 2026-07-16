import { useEffect, useState, useCallback } from "react";
import {
  newSecret,
  newZecRefundKey,
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
  const [quote, setQuote] = useState(null);
  const [amount, setAmount] = useState("0.05");
  const [active, setActive] = useState(() => loadActive());
  const [swap, setSwap] = useState(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const { price, hist } = usePrice(api);

  // Load the quote (and keep the rate/inventory fresh).
  useEffect(() => {
    let alive = true;
    const load = () => api.quote().then((q) => alive && setQuote(q)).catch(() => {});
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
    const t = setInterval(poll, 5000);
    return () => clearInterval(t);
  }, [active?.id, poll]);

  async function startSwap() {
    setErr(null);
    const zec = Number(amount);
    if (!quote || !(zec >= quote.minZec && zec <= quote.maxZec)) {
      setErr(`Enter an amount between ${quote?.minZec} and ${quote?.maxZec} ZEC.`);
      return;
    }
    setBusy(true);
    try {
      // Everything secret is minted here, in the browser.
      const { secretHex, hashlock } = newSecret();
      const { zecPrivHex, zecRefundPubkey } = newZecRefundKey();
      const xus = newXusWallet();
      const created = await api.createSwap({
        hashlock,
        zecRefundPubkey,
        xusRecipient: xus.account,
        zecAmountZat: Math.round(zec * ZAT),
      });
      const rec = {
        id: created.id,
        secretHex,
        zecPrivHex,
        zecRefundPubkey,
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
      await claimXus(api, {
        deskXusHtlcId: swap.deskXusHtlcId,
        secretHex: active.secretHex,
        xusSeedHex: active.xusSeedHex,
        account: active.account,
      });
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

  const xusOut = quote ? (Number(amount) || 0) * quote.rateXusPerZec : 0;

  return (
    <div className="shell">
      <header className="topbar">
        <a className="brand" href="/">
          <span className="mark">⚖</span> The Desk <small>· ZEC → XUS</small>
        </a>
        <div className="badges">
          {quote && <span className="badge net">mainnet</span>}
          <span className="badge">
            <span className="dot" /> live
          </span>
        </div>
      </header>

      <PriceTracker price={price} hist={hist} quote={quote} />

      <section className="rate">
        <div>
          <div className="lede">Trustless atomic swap — no bridge, no custodian</div>
          <div className="pair">
            <span className="big tick-zec">1 ZEC</span>
            <span className="arrow">→</span>
            <span className="big tick-xus">{quote ? quote.rateXusPerZec.toLocaleString() : "—"} XUS</span>
          </div>
        </div>
        <div className="inv">
          desk inventory
          <b>{quote ? `${quote.inventoryXus.toLocaleString()} XUS` : "—"}</b>
        </div>
      </section>

      {!active ? (
        <QuoteForm
          quote={quote}
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

function QuoteForm({ quote, amount, setAmount, xusOut, onStart, busy, err }) {
  return (
    <div className="card fade-in">
      <div className="card-h">
        <h2>New swap</h2>
        <span className="sub">you send ZEC, you receive XUS</span>
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
              <span className="unit tick-zec">ZEC</span>
            </div>
          </div>
          {quote && (
            <div className="hint">
              min {quote.minZec} · max {quote.maxZec} ZEC · desk pays out from{" "}
              <code>{shorten(quote.deskAccount, 6)}</code>
            </div>
          )}
        </div>

        <div className="field">
          <label>You receive</label>
          <div className="you-get">
            <span className="n">{xusOut.toLocaleString(undefined, { maximumFractionDigits: 8 })} XUS</span>
            <span className="l">at {quote ? quote.rateXusPerZec : "—"} XUS / ZEC</span>
          </div>
        </div>

        {err && <div className="callout bad" style={{ marginBottom: 14 }}>{err}</div>}

        <button className="btn btn-gold" onClick={onStart} disabled={busy || !quote}>
          {busy ? <span className="spin" /> : null}
          {busy ? "Preparing swap…" : "Start swap"}
        </button>
        <div className="hint" style={{ marginTop: 10 }}>
          A fresh secret, a ZEC refund key, and a new XUS wallet are generated in your browser. Nothing
          secret ever leaves this device.
        </div>
      </div>
    </div>
  );
}

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
        {settled ? (
          <SettledView swap={swap} active={active} />
        ) : aborted ? (
          <div className="callout bad">
            This swap was not matched: {swap.note || "terms could not be honored"}. No XUS was ever
            committed. If you already sent ZEC, reclaim it with your refund key after block{" "}
            <b className="mono">{swap.zecTimeoutHeight}</b> — recovery data is below.
          </div>
        ) : refunded ? (
          <div className="callout warn">
            The desk reclaimed its XUS (you didn't claim in time). Reclaim your ZEC with your refund key
            after block <b className="mono">{swap.zecTimeoutHeight}</b>.
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

  if (stage === "fund" && idx === 0) {
    return (
      <div className="detail">
        <p>
          Send exactly <b className="mono tick-zec">{zatToZec(swap.zecAmountZat)} ZEC</b> to this
          one-time escrow address. It's a hash-timelock contract — only the secret in your browser can
          release it to the desk, and only your refund key can return it to you.
        </p>
        <Data k="ZEC" v={swap.zecHtlcAddress} tone="steel" />
        <div className="safety">
          <span className="shield">🛡</span>
          <span>
            Fully refundable to you after Zcash block <b>{swap.zecTimeoutHeight}</b> if the swap doesn't
            complete. Waiting for your deposit to confirm…
          </span>
        </div>
      </div>
    );
  }

  if (stage === "match" && idx === 1) {
    return (
      <div className="detail">
        <p>
          Your ZEC is confirmed. The desk is locking <b className="mono tick-xus">{grainsToXus(swap.xusAmountGrains)} XUS</b>{" "}
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
          lets the desk take the ZEC. One click finishes both legs.
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

function SettledView({ swap, active }) {
  return (
    <div className="fade-in">
      <div className="rail">
        <span className="z">{zatToZec(swap.zecAmountZat)} ZEC</span>
        <span className="link" />
        <span className="x">{grainsToXus(swap.xusAmountGrains)} XUS</span>
      </div>
      <div className="callout good" style={{ marginTop: 12 }}>
        Done. Your XUS is in your new wallet — keep its seed (below) to spend it.
      </div>
      <Data k="XUS account" v={active.account} />
      {swap.zecSweepTxid && <Data k="ZEC sweep" v={swap.zecSweepTxid} tone="steel" />}
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
  return (
    <div className="keybox">
      <h4>⚠ RECOVERY DATA — SAVE BEFORE SENDING ZEC</h4>
      <p className="hint" style={{ marginTop: 0 }}>
        Keep this until the swap completes. Your XUS wallet seed receives the XUS; your ZEC refund key
        reclaims your ZEC if the swap fails.
      </p>
      <Data k="XUS seed" v={active.xusSeedHex} />
      <Data k="ZEC refund key" v={active.zecPrivHex} tone="steel" />
    </div>
  );
}
