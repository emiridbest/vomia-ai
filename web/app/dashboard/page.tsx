"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";

interface TradeRow {
  time: string;
  strategy: string;
  pair: string;
  amountIn: string;
  status: string;
  txHash: string | null;
  netEdgeBps: number | null;
}

interface ProfileState {
  minProfitBps: number;
  maxSlippageBps: number;
  maxTradesPerDay: number;
}

export default function Dashboard() {
  const [trades, setTrades] = useState<TradeRow[]>([]);
  const [feedNote, setFeedNote] = useState<string | null>(null);
  const [profile, setProfile] = useState<ProfileState>({ minProfitBps: 15, maxSlippageBps: 100, maxTradesPerDay: 50 });
  const [warnings, setWarnings] = useState<string[]>([]);
  const [saveState, setSaveState] = useState<"idle" | "review" | "saved">("idle");

  const loadTrades = useCallback(async () => {
    try {
      const res = await fetch("/api/trades?limit=40");
      const data = await res.json();
      setTrades(data.trades ?? []);
      setFeedNote(data.note ?? null);
    } catch {
      setFeedNote("Feed unreachable.");
    }
  }, []);

  useEffect(() => {
    loadTrades();
    const t = setInterval(loadTrades, 20_000);
    return () => clearInterval(t);
  }, [loadTrades]);

  async function submitProfile(acknowledge: boolean) {
    // web3AuthSub is wired in once the Web3Auth provider is mounted around
    // this page — for the demo flow this uses a placeholder identity so the
    // review/pushback path is fully exercisable without login.
    const res = await fetch("/api/risk-profile", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        web3AuthSub: "demo-user",
        profile: { ...profile, enabledStrategies: ["rebalance"] },
        acknowledgeWarnings: acknowledge,
      }),
    });
    const data = await res.json();
    if (data.review?.warnings?.length && !data.saved) {
      setWarnings(data.review.warnings);
      setSaveState("review");
    } else {
      setWarnings(data.review?.warnings ?? []);
      setSaveState("saved");
    }
  }

  return (
    <div className="container">
      <nav className="topbar">
        <Link href="/" className="wordmark">VO<span>MIA</span></Link>
        <div className="topnav">
          <Link href="/">Home</Link>
          <Link href="/chat">Agent chat</Link>
        </div>
        <span className="badge-live">CELO · AGENT LIVE</span>
      </nav>

      <section>
        <p className="eyebrow">/ Your agent</p>
        <h2 className="section-title">One rule, running. Every decision below is provable.</h2>

        <div className="dash-grid">
          <div className="card" id="feed">
            <h3>Live feed — including the trades it declined</h3>
            {feedNote && <p style={{ color: "var(--cream-dim)", fontSize: "0.85rem" }}>{feedNote}</p>}
            <table className="feed-table">
              <thead>
                <tr>
                  <th>Time</th><th>Pair</th><th>Edge</th><th>Status</th><th>Proof</th>
                </tr>
              </thead>
              <tbody>
                {trades.length === 0 && (
                  <tr><td colSpan={5} style={{ color: "var(--cream-dim)" }}>
                    No actions yet — the worker logs every scan tick here once it&rsquo;s running (npm run worker).
                  </td></tr>
                )}
                {trades.map((t, i) => (
                  <tr key={i}>
                    <td>{new Date(t.time).toLocaleTimeString()}</td>
                    <td>{t.pair}</td>
                    <td>{t.netEdgeBps !== null ? `${t.netEdgeBps}bps` : "—"}</td>
                    <td className={`status-${t.status}`}>{t.status.toUpperCase()}</td>
                    <td>
                      {t.txHash ? (
                        <a className="txlink" href={`https://celoscan.io/tx/${t.txHash}`} target="_blank" rel="noreferrer">
                          {t.txHash.slice(0, 10)}…
                        </a>
                      ) : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="card">
            <h3>Risk profile — the agent will push back</h3>
            <div className="field-row">
              <label htmlFor="minProfit">Min profit (bps)</label>
              <input id="minProfit" type="number" value={profile.minProfitBps}
                onChange={(e) => setProfile({ ...profile, minProfitBps: Number(e.target.value) })} />
            </div>
            <div className="field-row">
              <label htmlFor="maxSlip">Max slippage (bps)</label>
              <input id="maxSlip" type="number" value={profile.maxSlippageBps}
                onChange={(e) => setProfile({ ...profile, maxSlippageBps: Number(e.target.value) })} />
            </div>
            <div className="field-row">
              <label htmlFor="maxTrades">Max trades / day</label>
              <input id="maxTrades" type="number" value={profile.maxTradesPerDay}
                onChange={(e) => setProfile({ ...profile, maxTradesPerDay: Number(e.target.value) })} />
            </div>

            {warnings.length > 0 && (
              <div className="warnings" role="alert">
                {warnings.map((w, i) => <p key={i}>{w}</p>)}
              </div>
            )}

            <div style={{ marginTop: 18, display: "flex", gap: 10 }}>
              <button className="btn btn-primary" onClick={() => submitProfile(false)}>
                {saveState === "saved" ? "Saved ✓" : "Save profile"}
              </button>
              {saveState === "review" && (
                <button className="btn btn-ghost" onClick={() => submitProfile(true)}>
                  Save with adjustments
                </button>
              )}
            </div>
            <p style={{ marginTop: 14, fontSize: "0.78rem", color: "var(--cream-dim)" }}>
              These mirror the caps stored in your vault contract — the on-chain values always win.
            </p>
          </div>
        </div>
      </section>
    </div>
  );
}
