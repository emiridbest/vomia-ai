"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { encodeFunctionData, parseUnits } from "viem";
import { useSendTransaction, useWaitForTransactionReceipt, useWriteContract, usePublicClient } from "wagmi";
import ConnectWalletButton from "../components/ConnectWalletButton";
import { useVomiaIdentity } from "../hooks/useVomiaIdentity";
import { activeChain } from "../../lib/chains";
import { DEFAULT_STRATEGY_TOKENS, TOKENS, tokenAddress, type TokenSymbol } from "../../lib/tokens";
import { MENTO_BROKER_ADDRESS } from "../../lib/dex/mento";
import { UNISWAP_SWAP_ROUTER_02 } from "../../lib/dex/uniswap";
import { SQUID_ROUTER_CELO } from "../../lib/dex/squidSameChain";
import { attachAttributionTag } from "../../lib/attribution";

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

const FACTORY_ABI = [
  {
    type: "function",
    name: "createVault",
    stateMutability: "nonpayable",
    inputs: [{ name: "operator", type: "address" }],
    outputs: [{ name: "vault", type: "address" }],
  },
] as const;

const VAULT_ABI = [
  { type: "function", name: "paused", stateMutability: "view", inputs: [], outputs: [{ type: "bool" }] },
  {
    type: "function",
    name: "tokenBalance",
    stateMutability: "view",
    inputs: [{ name: "token", type: "address" }],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "setPaused",
    stateMutability: "nonpayable",
    inputs: [{ name: "newPaused", type: "bool" }],
    outputs: [],
  },
  {
    type: "function",
    name: "setTokenPolicy",
    stateMutability: "nonpayable",
    inputs: [
      { name: "token", type: "address" },
      { name: "allowed", type: "bool" },
      { name: "maxSingleTradeAmount", type: "uint256" },
      { name: "dailyCapAmount", type: "uint256" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "setTargetAllowed",
    stateMutability: "nonpayable",
    inputs: [
      { name: "target", type: "address" },
      { name: "allowed", type: "bool" },
    ],
    outputs: [],
  },
] as const;

const ERC20_TRANSFER_ABI = [
  {
    type: "function",
    name: "transfer",
    stateMutability: "nonpayable",
    inputs: [
      { name: "to", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ type: "bool" }],
  },
] as const;

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as const;

const ACTIVATION_TOKENS: TokenSymbol[] = DEFAULT_STRATEGY_TOKENS;
// Effectively-unlimited caps, at the owner's explicit request, so the agent
// can trade all day without hitting a ceiling (and cycle-backs can return an
// entire accumulated balance in one transaction instead of cap-sized
// chunks). Deliberate trade-off, stated plainly: these caps are the vault's
// blast-radius bound if the operator key is ever compromised (SECURITY.md's
// core argument), so raising them this high trades that protection away —
// acceptable for a small hackathon vault, not a default to keep for real
// user funds.
const DEFAULT_MAX_SINGLE_TRADE = "1000000000"; // 1 billion tokens per trade
const DEFAULT_DAILY_CAP = "1000000000"; // 1 billion tokens per rolling 24h

export default function Dashboard() {
  const { isConnected, address, web3AuthSub } = useVomiaIdentity();
  const factoryAddress = process.env.NEXT_PUBLIC_VAULT_FACTORY_ADDRESS as `0x${string}` | undefined;
  const publicClient = usePublicClient();
  const chain = activeChain();
  const explorerBase = chain.blockExplorers?.default.url ?? "https://celoscan.io";

  const [vaultAddress, setVaultAddress] = useState<`0x${string}` | null>(null);
  const [vaultChecked, setVaultChecked] = useState(false);
  const [pendingTxHash, setPendingTxHash] = useState<`0x${string}` | undefined>();
  const [vaultPaused, setVaultPaused] = useState<boolean | null>(null);
  const [balances, setBalances] = useState<Partial<Record<TokenSymbol, string>>>({});
  const [copied, setCopied] = useState(false);

  const [depositToken, setDepositToken] = useState<TokenSymbol>("USDm");
  const [depositAmount, setDepositAmount] = useState("");
  const [depositStatus, setDepositStatus] = useState<string | null>(null);
  const [activationStatus, setActivationStatus] = useState<string | null>(null);
  const [pauseBusy, setPauseBusy] = useState(false);

  const [trades, setTrades] = useState<TradeRow[]>([]);
  const [feedNote, setFeedNote] = useState<string | null>(null);
  const [profile, setProfile] = useState<ProfileState>({ minProfitBps: 2, maxSlippageBps: 100, maxTradesPerDay: 5000 });
  const [strategy, setStrategy] = useState<"rebalance" | "dca" | "arbitrage">("rebalance");
  const [warnings, setWarnings] = useState<string[]>([]);
  const [saveState, setSaveState] = useState<"idle" | "review" | "saved">("idle");
  const [profileError, setProfileError] = useState<string | null>(null);

  const { writeContractAsync, isPending: submittingVaultTx } = useWriteContract();
  const { sendTransactionAsync } = useSendTransaction();
  const { isSuccess: vaultTxConfirmed } = useWaitForTransactionReceipt({ hash: pendingTxHash });

  const checkVault = useCallback(async () => {
    if (!address) {
      setVaultAddress(null);
      setVaultChecked(true);
      return;
    }
    try {
      const res = await fetch(`/api/vault?walletAddress=${address}`);
      const data = await res.json();
      setVaultAddress(data.vaultAddress ?? null);
    } catch {
      setVaultAddress(null);
    } finally {
      setVaultChecked(true);
    }
  }, [address]);

  useEffect(() => {
    checkVault();
  }, [checkVault]);

  // Keep the DB mapping (walletAddress -> vaultAddress) in sync whenever we
  // know a vault exists on-chain, regardless of whether it was just created
  // here or already existed (e.g. after the DB collection was renamed and
  // the old mapping no longer resolves). POST /api/vault is an idempotent
  // upsert keyed by walletAddress, so calling it again is harmless.
  // web3AuthSub is attached when available but never required — its own
  // fetch can hang or fail without blocking anything here.
  const syncVaultToDb = useCallback(async () => {
    if (!vaultAddress || !address) return false;
    try {
      const res = await fetch("/api/vault", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ web3AuthSub: web3AuthSub ?? undefined, walletAddress: address, vaultAddress }),
      });
      if (!res.ok) console.error("Vault DB sync failed:", res.status, await res.text().catch(() => ""));
      return res.ok;
    } catch (err) {
      console.error("Vault DB sync failed:", err);
      return false;
    }
  }, [vaultAddress, address, web3AuthSub]);

  useEffect(() => {
    syncVaultToDb();
  }, [syncVaultToDb]);

  // Load whatever risk profile (including strategy choice) is already
  // saved, so the form reflects reality instead of always resetting to
  // defaults on every page load.
  useEffect(() => {
    if (!address) return;
    fetch(`/api/risk-profile?walletAddress=${address}`)
      .then((res) => res.json())
      .then((data) => {
        if (data.isDefault || !data.profile) return;
        setProfile({
          minProfitBps: data.profile.minProfitBps,
          maxSlippageBps: data.profile.maxSlippageBps,
          maxTradesPerDay: data.profile.maxTradesPerDay,
        });
        if (data.profile.enabledStrategies?.includes("dca")) setStrategy("dca");
        if (data.profile.enabledStrategies?.includes("arbitrage")) setStrategy("arbitrage");
      })
      .catch(() => {});
  }, [address]);

  // Once the createVault transaction confirms, look the vault up on-chain
  // (via the same GET this page already uses). The DB-sync effect above
  // picks up from here once vaultAddress is set.
  useEffect(() => {
    if (!vaultTxConfirmed || !address) return;
    (async () => {
      const res = await fetch(`/api/vault?walletAddress=${address}`);
      const data = await res.json();
      if (data.vaultAddress) setVaultAddress(data.vaultAddress);
    })();
  }, [vaultTxConfirmed, address]);

  const refreshVaultStatus = useCallback(async () => {
    if (!vaultAddress || !publicClient) return;
    try {
      const [paused, ...tokenBalances] = await Promise.all([
        publicClient.readContract({ address: vaultAddress, abi: VAULT_ABI, functionName: "paused" }),
        ...ACTIVATION_TOKENS.map((symbol) =>
          publicClient.readContract({
            address: vaultAddress,
            abi: VAULT_ABI,
            functionName: "tokenBalance",
            args: [tokenAddress(symbol, chain.id)],
          })
        ),
      ]);
      setVaultPaused(paused as boolean);
      const next: Partial<Record<TokenSymbol, string>> = {};
      ACTIVATION_TOKENS.forEach((symbol, i) => {
        next[symbol] = (Number(tokenBalances[i]) / 10 ** TOKENS[symbol].decimals).toString();
      });
      setBalances(next);
    } catch {
      // vault reads are best-effort for this panel; the feed/risk-profile UI don't depend on it
    }
  }, [vaultAddress, publicClient, chain.id]);

  useEffect(() => {
    refreshVaultStatus();
    const t = setInterval(refreshVaultStatus, 30_000);
    return () => clearInterval(t);
  }, [refreshVaultStatus]);

  const loadTrades = useCallback(async () => {
    try {
      const url = vaultAddress ? `/api/trades?limit=40&vault=${vaultAddress}` : "/api/trades?limit=40";
      const res = await fetch(url);
      const data = await res.json();
      setTrades(data.trades ?? []);
      setFeedNote(data.note ?? null);
    } catch {
      setFeedNote("Feed unreachable.");
    }
  }, [vaultAddress]);

  useEffect(() => {
    loadTrades();
    const t = setInterval(loadTrades, 20_000);
    return () => clearInterval(t);
  }, [loadTrades]);

  async function openVault() {
    if (!factoryAddress || !address) return;
    const hash = await writeContractAsync({
      address: factoryAddress,
      abi: FACTORY_ABI,
      functionName: "createVault",
      args: [ZERO_ADDRESS],
    });
    setPendingTxHash(hash);
  }

  function copyVaultAddress() {
    if (!vaultAddress) return;
    navigator.clipboard.writeText(vaultAddress);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  async function depositToVault() {
    if (!vaultAddress || !depositAmount || !publicClient) return;
    const info = TOKENS[depositToken];
    let amountWei: bigint;
    try {
      amountWei = parseUnits(depositAmount, info.decimals);
    } catch {
      setDepositStatus("Enter a valid amount.");
      return;
    }
    setDepositStatus("Confirm in your wallet…");
    try {
      // Sent as a raw tagged transaction (not useWriteContract) so the
      // ERC-8021 attribution suffix can ride along on the deposit itself,
      // same as every trade the worker executes.
      const transferData = encodeFunctionData({
        abi: ERC20_TRANSFER_ABI,
        functionName: "transfer",
        args: [vaultAddress, amountWei],
      });
      const taggedData = await attachAttributionTag(transferData);
      const hash = await sendTransactionAsync({
        to: tokenAddress(depositToken, chain.id),
        data: taggedData,
      });
      setDepositStatus("Confirming on-chain…");
      await publicClient.waitForTransactionReceipt({ hash });
      setDepositStatus(`Deposited ${depositAmount} ${depositToken} ✓`);
      setDepositAmount("");
      refreshVaultStatus();
    } catch (err: any) {
      setDepositStatus(`Failed: ${err?.shortMessage || err?.message || "unknown error"}`);
    }
  }

  async function togglePause() {
    if (!vaultAddress || vaultPaused === null) return;
    setPauseBusy(true);
    try {
      const hash = await writeContractAsync({
        address: vaultAddress,
        abi: VAULT_ABI,
        functionName: "setPaused",
        args: [!vaultPaused],
      });
      await publicClient?.waitForTransactionReceipt({ hash });
      await refreshVaultStatus();
    } catch (err: any) {
      setActivationStatus(`Failed to change pause state: ${err?.shortMessage || err?.message || "unknown error"}`);
    } finally {
      setPauseBusy(false);
    }
  }

  async function activateDefaultTrading() {
    if (!vaultAddress || !publicClient) return;
    const steps: { label: string; run: () => Promise<`0x${string}`> }[] = [
      {
        label: "Mento Broker",
        run: () =>
          writeContractAsync({
            address: vaultAddress,
            abi: VAULT_ABI,
            functionName: "setTargetAllowed",
            args: [MENTO_BROKER_ADDRESS, true],
          }),
      },
      {
        label: "Uniswap router",
        run: () =>
          writeContractAsync({
            address: vaultAddress,
            abi: VAULT_ABI,
            functionName: "setTargetAllowed",
            args: [UNISWAP_SWAP_ROUTER_02, true],
          }),
      },
      {
        label: "Squid router",
        run: () =>
          writeContractAsync({
            address: vaultAddress,
            abi: VAULT_ABI,
            functionName: "setTargetAllowed",
            args: [SQUID_ROUTER_CELO, true],
          }),
      },
      ...ACTIVATION_TOKENS.map((symbol) => ({
        label: symbol,
        run: () => {
          const info = TOKENS[symbol];
          return writeContractAsync({
            address: vaultAddress,
            abi: VAULT_ABI,
            functionName: "setTokenPolicy",
            args: [
              tokenAddress(symbol, chain.id),
              true,
              parseUnits(DEFAULT_MAX_SINGLE_TRADE, info.decimals),
              parseUnits(DEFAULT_DAILY_CAP, info.decimals),
            ],
          });
        },
      })),
    ];

    for (let i = 0; i < steps.length; i++) {
      setActivationStatus(`Allow-listing ${steps[i].label} (${i + 1}/${steps.length})… confirm in your wallet`);
      try {
        const hash = await steps[i].run();
        await publicClient.waitForTransactionReceipt({ hash });
      } catch (err: any) {
        setActivationStatus(`Stopped at ${steps[i].label}: ${err?.shortMessage || err?.message || "unknown error"}`);
        return;
      }
    }
    setActivationStatus(
      `Activated ✓ — ${ACTIVATION_TOKENS.join(", ")} allow-listed with effectively-unlimited caps (${DEFAULT_MAX_SINGLE_TRADE}/trade, ${DEFAULT_DAILY_CAP}/day each). Adjust anytime.`
    );
  }

  async function putProfile(acknowledge: boolean) {
    return fetch("/api/risk-profile", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        walletAddress: address,
        // Saving a profile is the user's opt-in signal — RiskProfile.paused
        // defaults to true for anyone who's never configured anything, but
        // actively saving one here means they want the worker to run.
        profile: { ...profile, enabledStrategies: [strategy], paused: false },
        acknowledgeWarnings: acknowledge,
      }),
    });
  }

  async function submitProfile(acknowledge: boolean) {
    if (!address) return;
    setProfileError(null);
    let res = await putProfile(acknowledge);

    // Self-heal: "User not found" here means the vault->DB sync effect
    // hasn't landed yet (a timing race on a fresh wallet) or silently
    // failed. Re-sync explicitly and retry once before surfacing an error.
    if (res.status === 404) {
      const synced = await syncVaultToDb();
      if (synced) res = await putProfile(acknowledge);
    }

    const data = await res.json();
    if (!res.ok || data.error) {
      setProfileError(data.error || `Save failed (${res.status})`);
      setSaveState("idle");
      return;
    }
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
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <ConnectWalletButton />
          <span className="badge-live">CELO · AGENT LIVE</span>
        </div>
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
                        <a className="txlink" href={`${explorerBase}/tx/${t.txHash}`} target="_blank" rel="noreferrer">
                          {t.txHash.slice(0, 10)}…
                        </a>
                      ) : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {isConnected && vaultAddress && (
            <div className="card">
              <h3>Your vault</h3>
              <div className="field-row" style={{ alignItems: "center" }}>
                <a
                  className="txlink"
                  href={`${explorerBase}/address/${vaultAddress}`}
                  target="_blank"
                  rel="noreferrer"
                  style={{ fontFamily: "monospace" }}
                >
                  {vaultAddress}
                </a>
                <button className="btn btn-ghost" style={{ padding: "4px 10px" }} onClick={copyVaultAddress}>
                  {copied ? "Copied ✓" : "Copy"}
                </button>
              </div>
              <p style={{ color: "var(--cream-dim)", fontSize: "0.82rem", marginTop: 6 }}>
                {vaultPaused === null ? "Checking status…" : vaultPaused ? "⏸ Paused — the agent will not trade" : "▶ Active"}
              </p>

              <h4 style={{ marginTop: 16, fontSize: "0.85rem" }}>Balances</h4>
              <ul style={{ fontSize: "0.85rem", color: "var(--cream-dim)", marginTop: 4 }}>
                {ACTIVATION_TOKENS.map((symbol) => (
                  <li key={symbol}>{symbol === "GOOD_DOLLAR" ? "G$" : symbol}: {balances[symbol] ?? "…"}</li>
                ))}
              </ul>

              <h4 style={{ marginTop: 16, fontSize: "0.85rem" }}>Fund your vault</h4>
              <p style={{ color: "var(--cream-dim)", fontSize: "0.8rem", marginBottom: 8 }}>
                Send tokens to the address above from any wallet, or deposit directly from your connected wallet:
              </p>
              <div className="field-row">
                <select value={depositToken} onChange={(e) => setDepositToken(e.target.value as TokenSymbol)}>
                  {ACTIVATION_TOKENS.map((symbol) => (
                    <option key={symbol} value={symbol}>{symbol === "GOOD_DOLLAR" ? "G$ (GoodDollar)" : symbol}</option>
                  ))}
                </select>
                <input
                  type="number"
                  placeholder="Amount"
                  value={depositAmount}
                  onChange={(e) => setDepositAmount(e.target.value)}
                />
                <button className="btn btn-primary" onClick={depositToVault} disabled={!depositAmount}>
                  Deposit
                </button>
              </div>
              {depositStatus && <p style={{ fontSize: "0.8rem", color: "var(--cream-dim)", marginTop: 6 }}>{depositStatus}</p>}

              <h4 style={{ marginTop: 16, fontSize: "0.85rem" }}>Activate trading</h4>
              <p style={{ color: "var(--cream-dim)", fontSize: "0.8rem", marginBottom: 8 }}>
                Allow-lists Mento + Uniswap as trading venues and {ACTIVATION_TOKENS.join("/")} as tradeable tokens
                with effectively-unlimited caps ({DEFAULT_MAX_SINGLE_TRADE} per trade and per day, each token — several
                transactions, sign each one). Safe to run again to update caps. Note: high caps mean the on-chain
                spend limits no longer bound the agent — only use with funds you&rsquo;re comfortable trading freely.
              </p>
              <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
                <button className="btn btn-primary" onClick={activateDefaultTrading}>
                  Activate default trading pairs
                </button>
                <button className="btn btn-ghost" onClick={togglePause} disabled={pauseBusy || vaultPaused === null}>
                  {pauseBusy ? "Confirm in your wallet…" : vaultPaused ? "Un-pause" : "Pause"}
                </button>
              </div>
              {activationStatus && <p style={{ fontSize: "0.8rem", color: "var(--cream-dim)", marginTop: 6 }}>{activationStatus}</p>}
            </div>
          )}

          <div className="card">
            <h3>Risk profile — the agent will push back</h3>

            {!isConnected && (
              <p style={{ color: "var(--cream-dim)", fontSize: "0.85rem" }}>
                Connect your wallet to open a vault and set your risk profile.
              </p>
            )}

            {isConnected && vaultChecked && !vaultAddress && (
              <div>
                <p style={{ color: "var(--cream-dim)", fontSize: "0.85rem", marginBottom: 12 }}>
                  No vault yet for this wallet. Opening one deploys your personal
                  AgentVault — only you can withdraw from it.
                </p>
                <button className="btn btn-primary" onClick={openVault} disabled={submittingVaultTx || !factoryAddress}>
                  {submittingVaultTx ? "Confirm in your wallet…" : "Open your vault"}
                </button>
                {!factoryAddress && (
                  <p style={{ color: "var(--cream-dim)", fontSize: "0.78rem", marginTop: 8 }}>
                    NEXT_PUBLIC_VAULT_FACTORY_ADDRESS is not set.
                  </p>
                )}
              </div>
            )}

            {isConnected && vaultAddress && (
              <>
                <div className="field-row">
                  <label htmlFor="strategy">Strategy</label>
                  <select id="strategy" value={strategy} onChange={(e) => setStrategy(e.target.value as "rebalance" | "dca" | "arbitrage")}>
                    <option value="rebalance">Rebalance — trade only when it clears your profit margin</option>
                    <option value="dca">DCA — buy 2 USDm worth of CELO every minute, regardless of price</option>
                    <option value="arbitrage">Arbitrage (experiment) — buy CELO on Squid, sell on Uniswap, 1 USDm every 30 minutes</option>
                  </select>
                </div>
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
                {profileError && (
                  <div className="warnings" role="alert">
                    <p>{profileError}</p>
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
              </>
            )}
          </div>
        </div>
      </section>
    </div>
  );
}
