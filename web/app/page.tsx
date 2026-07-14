import Link from "next/link";
import ConnectWalletButton from "./components/ConnectWalletButton";

/**
 * Landing page. Structure intentionally parallels what works about
 * remitroute.vercel.app (live badge, plain-language rules, safety grid,
 * "agents pay us per call" API block) but the visual identity is Vomia's
 * own: adire-indigo field, the rotating savings-circle as the hero motif,
 * and copy that says exactly what the system can and cannot do — the
 * non-custodial claims below are true of the contracts in /contracts,
 * not marketing.
 */

function VomiaCircle() {
  // 12 contribution nodes on a ring — one highlighted (whose "turn" it is).
  const nodes = Array.from({ length: 12 }, (_, i) => {
    const angle = (i / 12) * 2 * Math.PI - Math.PI / 2;
    const r = 132;
    return { x: 170 + r * Math.cos(angle), y: 170 + r * Math.sin(angle), active: i === 0 };
  });
  return (
    <div className="circle-wrap" aria-hidden="true">
      <svg className="vomia-circle" viewBox="0 0 340 340" fill="none">
        <circle cx="170" cy="170" r="132" stroke="rgba(245,240,230,0.18)" strokeWidth="1" strokeDasharray="3 6" />
        <circle cx="170" cy="170" r="98" stroke="rgba(232,163,61,0.25)" strokeWidth="1" />
        {nodes.map((n, i) => (
          <circle key={i} cx={n.x} cy={n.y} r={n.active ? 9 : 5} fill={n.active ? "#e8a33d" : "#f5f0e6"} opacity={n.active ? 1 : 0.55} />
        ))}
      </svg>
      <div className="circle-center">
        heartbeat
        <strong>60s</strong>
        scan → decide → settle
      </div>
    </div>
  );
}

const TICKER_ITEMS = (
  <>
    <span><b>USDm→NGNm</b> 1 = 1,580 <i className="up">MENTO</i></span>
    <span><b>USDm→KESm</b> 1 = 129.4 <i className="up">MENTO</i></span>
    <span><b>USDm→EURm</b> 1 = 0.92 <i className="up">MENTO</i></span>
    <span><b>GAS/AVG</b> $0.0007 <i>PAID IN USDm</i></span>
    <span><b>PAY-PER-CALL</b> x402 · $0.005–$0.01</span>
    <span><b>VAULTS</b> non-custodial · owner-withdraw only</span>
  </>
);

export default function Landing() {
  return (
    <>
      <div className="container">
        <nav className="topbar">
          <Link href="/" className="wordmark">VO<span>MIA</span></Link>
          <div className="topnav">
            <Link href="/dashboard">Dashboard</Link>
            <Link href="/chat">Agent chat</Link>
            <a href="https://docs.celo.org/build-on-celo/build-with-ai/x402" target="_blank" rel="noreferrer">x402 docs</a>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <ConnectWalletButton />
            <span className="badge-live">CELO · AGENT LIVE</span>
          </div>
        </nav>

        <div className="hero">
          <div>
            <h1>
              The savings circle,<br />
              running <em>itself</em>.
            </h1>
            <p className="sub">
              Vomia is an always-on FX &amp; savings agent on Celo. Log in with your socials,
              set one rule in plain language, and the agent trades inside a vault
              that only <strong>you</strong> can withdraw from — every action capped,
              every settlement provable on-chain, gas paid in stablecoins.
            </p>
            <div className="cta-row">
              <Link className="btn btn-primary" href="/dashboard">Open your vault</Link>
              <Link className="btn btn-ghost" href="/dashboard#feed">Watch the live feed</Link>
            </div>
          </div>
          <VomiaCircle />
        </div>
      </div>

      <div className="ticker" aria-hidden="true">
        <div className="ticker-track">
          {TICKER_ITEMS}
          {TICKER_ITEMS}
        </div>
      </div>

      <div className="container">
        <section>
          <p className="eyebrow">/ How it works</p>
          <h2 className="section-title">Three steps. Then zero taps.</h2>
          <div className="steps">
            <div className="step">
              <span className="num">01</span>
              <h3>Log in, get a vault</h3>
              <p>
                Social login via Web3Auth creates your wallet with MPC — no seed phrase,
                and no server (including ours) ever holds your key. One tap deploys your
                personal on-chain vault.
              </p>
              <span className="rule-quote">Your wallet key: split across you + Web3Auth. Our database: zero keys.</span>
            </div>
            <div className="step">
              <span className="num">02</span>
              <h3>Set a rule &amp; a budget</h3>
              <p>
                Tell the agent your rule and risk margins in plain language. It will push
                back if your numbers would lose money — then writes your caps into the
                vault contract itself.
              </p>
              <span className="rule-quote">&ldquo;Keep 40% in KESm, max 50 USDm per trade, 200 a day.&rdquo;</span>
            </div>
            <div className="step">
              <span className="num">03</span>
              <h3>The agent runs it</h3>
              <p>
                Every heartbeat it quotes Mento and Uniswap, executes only when a trade
                clears your profit margin after gas, and logs every decision — including
                the ones it declined.
              </p>
              <span className="rule-quote">Skipped: edge 4bps &lt; your 15bps floor. No trade.</span>
            </div>
          </div>
        </section>

        <section>
          <p className="eyebrow">/ Safety</p>
          <h2 className="section-title">It moves real money, so the limits live on-chain, not in a promise.</h2>
          <div className="caps-grid">
            <div className="cap">
              <span className="check">✓ OWNER-ONLY WITHDRAW</span>
              <h4>Your money, always</h4>
              <p>The agent&rsquo;s key physically cannot withdraw. Emergency withdrawal works even while paused.</p>
            </div>
            <div className="cap">
              <span className="check">✓ SPEND CAPS</span>
              <h4>Per-trade &amp; daily</h4>
              <p>Enforced by the vault contract on every call — not by trusting the bot&rsquo;s code.</p>
            </div>
            <div className="cap">
              <span className="check">✓ CIRCUIT BREAKER</span>
              <h4>Agent can pause itself</h4>
              <p>…but only you can un-pause. An agent that trips its own breaker can&rsquo;t lift it.</p>
            </div>
            <div className="cap">
              <span className="check">✓ IDEMPOTENCY</span>
              <h4>No double-fires</h4>
              <p>Every action carries a unique id the contract will only honor once. Retries can&rsquo;t double-trade.</p>
            </div>
          </div>
        </section>

        <section>
          <p className="eyebrow">/ Agent economy</p>
          <h2 className="section-title">Other agents pay Vomia, per call.</h2>
          <div className="api-block">
            <div><span className="verb">GET</span> <span className="path">/api/x402/fx-route?from=USDm&amp;to=KESm&amp;amount=100</span></div>
            <div className="meta">PRICE <span className="price">$0.01 / call</span> · SETTLE x402 on Celo · no account, no API key</div>
            <div className="meta">200 &#123; routes: [&#123; venue, amountOut &#125;] &#125;</div>
          </div>
          <div className="api-block">
            <div><span className="verb">GET</span> <span className="path">/api/x402/check?tokenIn=USDm&amp;tokenOut=NGNm&amp;amountIn=10</span></div>
            <div className="meta">PRICE <span className="price">$0.001 / call</span> · &ldquo;should I rebalance?&rdquo; — paid whether the answer is yes or no</div>
          </div>
        </section>

        <footer>
          <div>Vomia — a non-custodial DeFAI agent on Celo. Every transaction verifiable on Celoscan.</div>
          <div className="foot-links">
            <a href="https://celoscan.io" target="_blank" rel="noreferrer">Celoscan ↗</a>
            <a href="https://docs.celo.org" target="_blank" rel="noreferrer">Celo docs ↗</a>
            <Link href="/dashboard">Dashboard</Link>
          </div>
        </footer>
      </div>
    </>
  );
}
