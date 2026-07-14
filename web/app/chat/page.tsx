"use client";

import { useEffect, useRef } from "react";
import { useChat } from "ai/react";
import Link from "next/link";

/**
 * Chat UI — a leaner rebuild of the original Vomia chat component in this
 * project's design system. The important behavioral change: when the agent
 * returns a prepareWithdrawal tool result (requiresUserSignature: true),
 * this UI is where the user's OWN Web3Auth wallet gets popped to sign it.
 * Wire `sendUserTransaction` below to your Web3Auth/wagmi signer — left as
 * an explicit seam because the signer object comes from your provider setup.
 */
export default function ChatPage() {
  const endRef = useRef<HTMLDivElement>(null);

  const { messages, input, setInput, handleSubmit, isLoading, append } = useChat({
    api: "/api/chat",
    // body: { userAddress } — supply from your Web3Auth/wagmi hook once the provider is mounted
  });

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  const suggestions = [
    "What's in my vault right now?",
    "Keep 40% of my balance in KESm, rebalance when it drifts 2%",
    "Set my minimum profit to 5bps", // deliberately low — demos the agent pushing back
    "Withdraw 10 USDm back to my wallet",
  ];

  return (
    <div className="container">
      <nav className="topbar">
        <Link href="/" className="wordmark">VO<span>MIA</span></Link>
        <div className="topnav">
          <Link href="/">Home</Link>
          <Link href="/dashboard">Dashboard</Link>
        </div>
        <span className="badge-live">CELO · AGENT LIVE</span>
      </nav>

      <div className="chat-shell">
        <div className="chat-messages">
          {messages.length === 0 && (
            <div className="suggestions">
              <p style={{ color: "var(--cream-dim)", marginBottom: 8 }}>
                Talk to your agent — it manages your vault, never your keys.
              </p>
              {suggestions.map((s) => (
                <button key={s} onClick={() => append({ role: "user", content: s })}>{s}</button>
              ))}
            </div>
          )}

          {messages.map((m) => (
            <div key={m.id}>
              <div className={`msg ${m.role === "user" ? "msg-user" : "msg-assistant"}`}>{m.content}</div>
              {m.toolInvocations?.map((t: any, i: number) =>
                t.state === "result" ? (
                  <div key={i} className="msg-tool">
                    ⚙ {t.toolName}
                    {t.result?.requiresUserSignature && (
                      <>
                        {" — signature required: "}
                        <button
                          className="btn btn-ghost"
                          style={{ padding: "4px 10px", marginLeft: 8 }}
                          onClick={() => sendUserTransaction(t.result)}
                        >
                          Sign in wallet
                        </button>
                      </>
                    )}
                  </div>
                ) : null
              )}
            </div>
          ))}
          {isLoading && <div className="msg msg-assistant">…</div>}
          <div ref={endRef} />
        </div>

        <form className="chat-input-row" onSubmit={handleSubmit}>
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="Message Vomia…"
            disabled={isLoading}
            aria-label="Message Vomia"
          />
          <button className="btn btn-primary" type="submit" disabled={isLoading || !input.trim()}>
            Send
          </button>
        </form>
      </div>
    </div>
  );
}

/**
 * Seam for the user-signed withdrawal: receives { to, data, summary } from
 * the prepareWithdrawal tool. Replace the alert with your Web3Auth/wagmi
 * sendTransaction — e.g.:
 *   const { sendTransactionAsync } = useSendTransaction();
 *   await sendTransactionAsync({ to: result.to, data: result.data });
 * Kept out of the component body here so the page renders without the
 * wallet provider mounted.
 */
function sendUserTransaction(result: { to: `0x${string}`; data: `0x${string}`; summary: string }) {
  alert(
    `Wire this to your Web3Auth signer:\n\n${result.summary}\n\nto: ${result.to}\ndata: ${result.data.slice(0, 42)}…`
  );
}
