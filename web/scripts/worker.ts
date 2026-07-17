/**
 * The Vomia worker — the always-on heartbeat (run with `npm run worker`).
 *
 * Every HEARTBEAT_SECONDS it loads all users with an unpaused risk profile
 * and runs whichever strategies they've enabled:
 *
 *   - rebalance: scans each allowed token pair across venues, and for any
 *     scan that clears the user's own profit margin (against Mento's own
 *     oracle reference rate — see lib/dex/oracle.ts), executes through
 *     their vault. Never manufactures a trade to hit a volume number —
 *     every skipped tick is logged with its reason.
 *   - dca: buys a fixed amount into CELO and G$ from USDm on a fixed
 *     schedule (DCA_INTERVAL_MS), independent of price — that's the
 *     definition of dollar-cost-averaging. It rides this same heartbeat
 *     rather than running its own timer: each tick just checks, per user
 *     and per DCA pair, whether enough time has passed since the last DCA
 *     trade (via TradeLog), and only then executes.
 *
 * Both strategies are one-directional by default (USDm spent, never
 * replenished), which would eventually exhaust the vault's USDm balance.
 * cycleBackIfDue() catches this: after REBALANCE_CYCLE_LIMIT forward trades
 * into a currency (rebalance) or DCA_CYCLE_LIMIT forward buys (dca), it
 * swaps the entire accumulated balance of that token back to USDm instead
 * of doing another forward trade. This also gives a natural checkpoint to
 * see whether a cycle actually netted more or less USDm than was spent.
 *
 * Either way, the vault contract re-enforces every cap on-chain regardless
 * of what this code sends.
 *
 * Run this as a single separate process (Railway/Fly/a VPS), NOT inside
 * the Next.js serverless app — serverless instances can overlap, and two
 * workers double-submitting is exactly what the vault's actionId
 * idempotency exists to catch, but there's no reason to lean on the last
 * line of defense by design.
 */
import { createPublicClient, http, type Address } from "viem";
import { celo } from "viem/chains";
import { connectDB } from "../lib/db/connection";
import { User, RiskProfile, TradeLog } from "../lib/db/models";
import { scanPair } from "../lib/strategy/spreadScanner";
import { executeIfProfitable, executeDca, executeVenueSwap } from "../lib/strategy/executor";
import { TOKENS, type TokenSymbol } from "../lib/tokens";
import { DEFAULT_RISK_PROFILE } from "../lib/strategy/riskProfile";
import { rpcUrl } from "../lib/chains";

const HEARTBEAT_SECONDS = Number(process.env.HEARTBEAT_SECONDS || 60);
const SCAN_AMOUNT_HUMAN = Number(process.env.SCAN_AMOUNT_HUMAN || 10); // notional per-trade size to quote with

const DCA_AMOUNT_HUMAN = 1; // fixed USDm spend per DCA buy, per the product spec
const DCA_INTERVAL_MS = 3 * 60 * 1000;
const DCA_PAIRS: { tokenIn: TokenSymbol; tokenOut: TokenSymbol }[] = [
  { tokenIn: "USDm", tokenOut: "CELO" },
  { tokenIn: "USDm", tokenOut: "GOOD_DOLLAR" },
];

const REBALANCE_CYCLE_LIMIT = 3; // forward trades into a currency before swapping the balance back
const DCA_CYCLE_LIMIT = 10; // forward buys before swapping the accumulated balance back

// The 24h buy-on-Squid / sell-on-Uniswap experiment (owner-requested, to
// settle a disagreement between API round-trip quotes — which say this
// combination loses ~4.5%/trip — and manual frontend checks that suggested
// it's profitable). Sized and paced so 24h of running settles the question
// for a couple of dollars either way rather than draining the vault:
// 1 USDm per trip, one trip per 30 minutes, realized P&L logged per trip.
const ARB_AMOUNT_HUMAN = 1;
const ARB_INTERVAL_MS = 30 * 60 * 1000;

const publicClient = createPublicClient({ chain: celo, transport: http(rpcUrl()) });
const VAULT_BALANCE_ABI = [
  { type: "function", name: "tokenBalance", stateMutability: "view", inputs: [{ name: "token", type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "owner", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "maxSingleTrade", stateMutability: "view", inputs: [{ name: "", type: "address" }], outputs: [{ type: "uint256" }] },
  {
    type: "function",
    name: "remainingDailyAllowance",
    stateMutability: "view",
    inputs: [{ name: "token", type: "address" }],
    outputs: [{ type: "uint256" }],
  },
] as const;

const FACTORY_ADDRESS = process.env.NEXT_PUBLIC_VAULT_FACTORY_ADDRESS as Address | undefined;
const FACTORY_ABI = [
  { type: "function", name: "vaultCount", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "allVaults", stateMutability: "view", inputs: [{ name: "", type: "uint256" }], outputs: [{ type: "address" }] },
] as const;

/**
 * Enumerates every vault the factory has ever created (vaultCount/allVaults
 * — cheap contract reads, no event-log block-range scanning needed) and
 * upserts a User record for any vault whose owner isn't already in the DB,
 * or whose DB record points at the wrong vault. This makes the DB sync
 * independent of the frontend's best-effort POST /api/vault call, which has
 * no delivery guarantee at all — a closed tab, a network blip, or a silent
 * failure there previously left a real, funded vault permanently invisible
 * to the worker until someone noticed and fixed it by hand (twice, in
 * testing). Runs every tick; fine at hackathon scale (a full rescan is a
 * couple of cheap reads per vault), would want an incremental/cached
 * approach if this ever needs to handle thousands of vaults.
 */
async function reconcileVaultsFromChain() {
  if (!FACTORY_ADDRESS) return;
  const count = await publicClient.readContract({ address: FACTORY_ADDRESS, abi: FACTORY_ABI, functionName: "vaultCount" });
  for (let i = 0n; i < count; i++) {
    const vaultAddress = await publicClient.readContract({ address: FACTORY_ADDRESS, abi: FACTORY_ABI, functionName: "allVaults", args: [i] });
    const owner = await publicClient.readContract({ address: vaultAddress, abi: VAULT_BALANCE_ABI, functionName: "owner" });
    const existing = await User.findOne({ walletAddress: owner });
    if (!existing) {
      await User.create({ walletAddress: owner, vaultAddress });
      console.log(`Reconciled a vault the DB didn't know about: ${owner.slice(0, 8)} -> ${vaultAddress}`);
    } else if (existing.vaultAddress?.toLowerCase() !== vaultAddress.toLowerCase()) {
      await User.updateOne({ _id: existing._id }, { vaultAddress });
      console.log(`Corrected a stale vault mapping for ${owner.slice(0, 8)}`);
    }
  }
}

let ticking = false;

/** How many tokenIn->tokenOut trades have settled since the most recent tokenOut->tokenIn (reverse) trade. */
async function forwardCountSinceLastReverse(userId: string, tokenIn: TokenSymbol, tokenOut: TokenSymbol): Promise<number> {
  const lastReverse = await TradeLog.findOne({
    userId,
    tokenIn: tokenOut,
    tokenOut: tokenIn,
    status: { $in: ["submitted", "settled"] },
  }).sort({ createdAt: -1 });
  const since = lastReverse ? lastReverse.createdAt : new Date(0);
  return TradeLog.countDocuments({
    userId,
    tokenIn,
    tokenOut,
    status: { $in: ["submitted", "settled"] },
    createdAt: { $gt: since },
  });
}

/**
 * If this user has hit the cycle limit for tokenIn->tokenOut, swaps the
 * vault's current tokenOut balance back to tokenIn (unconditional, same as
 * DCA — this is housekeeping to prevent exhaustion, not a profit-gated
 * trade) and returns true so the caller skips its normal forward-trade
 * logic for this pair this tick. Returns false if not due, or if there's
 * nothing to cycle back.
 *
 * The amount is clamped to the vault's own on-chain caps (maxSingleTrade
 * and remainingDailyAllowance) — without this, an accumulated balance
 * above the per-trade cap made every cycle-back attempt revert with
 * OverSingleTradeCap, then retry the identical doomed swap every tick,
 * burning operator gas each time (observed live: a 146-CELO balance
 * against a 50/trade cap). Clamped cycle-backs drain the balance in
 * cap-sized chunks across successive ticks instead.
 */
async function cycleBackIfDue(
  user: any,
  tokenIn: TokenSymbol,
  tokenOut: TokenSymbol,
  cycleLimit: number,
  strategy: "rebalance" | "dca",
  maxSlippageBps: number,
  neededIn: bigint
): Promise<boolean> {
  // Two triggers: the scheduled one (N forward buys since the last
  // reverse), and a funding-short one — if the vault can no longer cover
  // the next forward trade's tokenIn amount, cycle back early to replenish
  // rather than letting every forward attempt fail on the token transfer
  // (observed live: USDm drained to 0.13 while the accumulated value sat
  // in KESm/NGNm/EURm, and every 10-USDm attempt reverted with
  // "SafeERC20: low-level call failed" until a scheduled cycle-back
  // happened to come around).
  const forwardCount = await forwardCountSinceLastReverse(user._id.toString(), tokenIn, tokenOut);
  let trigger = forwardCount >= cycleLimit ? `after ${forwardCount} buys` : null;
  if (!trigger) {
    const balanceIn = await publicClient.readContract({
      address: user.vaultAddress as Address,
      abi: VAULT_BALANCE_ABI,
      functionName: "tokenBalance",
      args: [TOKENS[tokenIn].address],
    });
    if (balanceIn < neededIn) trigger = `replenishing ${tokenIn} (balance below trade size)`;
  }
  if (!trigger) return false;

  const tokenOutAddress = TOKENS[tokenOut].address;
  const [balance, maxSingle, remainingDaily] = await Promise.all([
    publicClient.readContract({ address: user.vaultAddress as Address, abi: VAULT_BALANCE_ABI, functionName: "tokenBalance", args: [tokenOutAddress] }),
    publicClient.readContract({ address: user.vaultAddress as Address, abi: VAULT_BALANCE_ABI, functionName: "maxSingleTrade", args: [tokenOutAddress] }),
    publicClient.readContract({
      address: user.vaultAddress as Address,
      abi: VAULT_BALANCE_ABI,
      functionName: "remainingDailyAllowance",
      args: [tokenOutAddress],
    }),
  ]);

  let amount = balance;
  if (amount > maxSingle) amount = maxSingle;
  if (amount > remainingDaily) amount = remainingDaily;
  if (amount === 0n) {
    if (balance > 0n) {
      console.log(
        `[${user.walletAddress.slice(0, 8)}] ${strategy}-cycle-back ${tokenOut}->${tokenIn}: blocked — balance ${balance} but vault cap allows 0 right now (daily allowance spent or token capped at 0).`
      );
    }
    return false;
  }

  const result = await executeDca(user.vaultAddress, user._id.toString(), tokenOut, tokenIn, amount, maxSlippageBps, strategy);
  console.log(
    `[${user.walletAddress.slice(0, 8)}] ${strategy}-cycle-back ${tokenOut}->${tokenIn} (${trigger}): ${result.status}` +
      (result.txHash ? ` tx=${result.txHash}` : "") +
      ` (${result.reason})`
  );
  return true;
}

/** True if the vault holds at least `amountIn` of `tokenIn` — checked before a forward trade so an unfundable attempt is skipped with a clear log line instead of failing on the token transfer. */
async function hasFunding(user: any, tokenIn: TokenSymbol, amountIn: bigint): Promise<boolean> {
  const balance = await publicClient.readContract({
    address: user.vaultAddress as Address,
    abi: VAULT_BALANCE_ABI,
    functionName: "tokenBalance",
    args: [TOKENS[tokenIn].address],
  });
  return balance >= amountIn;
}

async function runRebalance(user: any, profile: any) {
  const pairs: { tokenIn: TokenSymbol; tokenOut: TokenSymbol }[] = profile.allowedTokenPairs?.length
    ? profile.allowedTokenPairs
    : [
        { tokenIn: "USDm", tokenOut: "KESm" },
        { tokenIn: "USDm", tokenOut: "NGNm" },
        { tokenIn: "USDm", tokenOut: "EURm" },
        // Tightest Mento spread of the lot (typically ~-36bps vs the
        // oracle mid, against ~-350bps on the regional pairs), so it's the
        // pair most likely to genuinely clear the profit floor when the
        // pool price dislocates above oracle fair value.
        { tokenIn: "USDm", tokenOut: "CELO" },
      ];

  for (const pair of pairs) {
    const decimalsIn = TOKENS[pair.tokenIn].decimals;
    const amountIn = BigInt(Math.floor(SCAN_AMOUNT_HUMAN * 10 ** decimalsIn));

    const cycled = await cycleBackIfDue(user, pair.tokenIn, pair.tokenOut, REBALANCE_CYCLE_LIMIT, "rebalance", profile.maxSlippageBps, amountIn);
    if (cycled) continue;

    if (!(await hasFunding(user, pair.tokenIn, amountIn))) {
      console.log(`[${user.walletAddress.slice(0, 8)}] rebalance ${pair.tokenIn}->${pair.tokenOut}: skipped — vault ${pair.tokenIn} balance below trade size and nothing to cycle back.`);
      continue;
    }

    const scan = await scanPair(pair.tokenIn, pair.tokenOut, amountIn, SCAN_AMOUNT_HUMAN, profile);

    if (scan.decision === "execute") {
      const result = await executeIfProfitable(user.vaultAddress, user._id.toString(), scan, profile.maxSlippageBps);
      console.log(
        `[${user.walletAddress.slice(0, 8)}] rebalance ${pair.tokenIn}->${pair.tokenOut}: ${result.status}` +
          (result.txHash ? ` tx=${result.txHash}` : "") +
          ` (${result.reason})`
      );
    } else {
      // Log skips too — this is the honest live-feed material.
      console.log(`[${user.walletAddress.slice(0, 8)}] rebalance ${pair.tokenIn}->${pair.tokenOut}: ${scan.decision} (${scan.reason})`);
    }
  }
}

async function runDca(user: any, profile: any) {
  for (const pair of DCA_PAIRS) {
    const decimalsIn = TOKENS[pair.tokenIn].decimals;
    const amountIn = BigInt(Math.floor(DCA_AMOUNT_HUMAN * 10 ** decimalsIn));

    const cycled = await cycleBackIfDue(user, pair.tokenIn, pair.tokenOut, DCA_CYCLE_LIMIT, "dca", profile.maxSlippageBps, amountIn);
    if (cycled) continue;

    const lastRun = await TradeLog.findOne({ userId: user._id, strategy: "dca", tokenIn: pair.tokenIn, tokenOut: pair.tokenOut }).sort({
      createdAt: -1,
    });
    if (lastRun && Date.now() - lastRun.createdAt.getTime() < DCA_INTERVAL_MS) continue;

    if (!(await hasFunding(user, pair.tokenIn, amountIn))) {
      console.log(`[${user.walletAddress.slice(0, 8)}] dca ${pair.tokenIn}->${pair.tokenOut}: skipped — vault ${pair.tokenIn} balance below buy size and nothing to cycle back.`);
      continue;
    }

    const result = await executeDca(user.vaultAddress, user._id.toString(), pair.tokenIn, pair.tokenOut, amountIn, profile.maxSlippageBps);
    console.log(
      `[${user.walletAddress.slice(0, 8)}] dca ${pair.tokenIn}->${pair.tokenOut}: ${result.status}` +
        (result.txHash ? ` tx=${result.txHash}` : "") +
        ` (${result.reason})`
    );
  }
}

async function runArbitrage(user: any, profile: any) {
  const tag = `[${user.walletAddress.slice(0, 8)}] arb`;

  // One trip per interval, gated on the last arbitrage-strategy trade.
  const lastRun = await TradeLog.findOne({ userId: user._id, strategy: "arbitrage" }).sort({ createdAt: -1 });
  if (lastRun && Date.now() - lastRun.createdAt.getTime() < ARB_INTERVAL_MS) return;

  const amountIn = BigInt(ARB_AMOUNT_HUMAN) * 10n ** BigInt(TOKENS.USDm.decimals);
  if (!(await hasFunding(user, "USDm", amountIn))) {
    console.log(`${tag}: skipped — vault can't fund ${ARB_AMOUNT_HUMAN} USDm.`);
    return;
  }

  // Leg 1: buy CELO on Squid.
  const leg1 = await executeVenueSwap("squid", user.vaultAddress, user._id.toString(), "USDm", "CELO", amountIn, profile.maxSlippageBps);
  console.log(`${tag} leg1 USDm->CELO via squid: ${leg1.status}` + (leg1.txHash ? ` tx=${leg1.txHash}` : "") + ` (${leg1.reason})`);
  if (leg1.status !== "settled") return;

  // Leg 2: sell the vault's whole CELO balance on Uniswap (the vault held 0
  // CELO before leg 1 on this strategy's vault; selling the full balance
  // keeps the experiment's books clean between trips).
  const celoBalance = await publicClient.readContract({
    address: user.vaultAddress as Address,
    abi: VAULT_BALANCE_ABI,
    functionName: "tokenBalance",
    args: [TOKENS.CELO.address],
  });
  if (celoBalance === 0n) {
    console.log(`${tag} leg2: nothing to sell (CELO balance 0 after leg 1?)`);
    return;
  }
  const leg2 = await executeVenueSwap("uniswap", user.vaultAddress, user._id.toString(), "CELO", "USDm", celoBalance, profile.maxSlippageBps);
  console.log(`${tag} leg2 CELO->USDm via uniswap: ${leg2.status}` + (leg2.txHash ? ` tx=${leg2.txHash}` : "") + ` (${leg2.reason})`);

  // Realized round-trip P&L, from the vault's own USDm balance movement.
  if (leg2.status === "settled") {
    const usdmAfter = await publicClient.readContract({
      address: user.vaultAddress as Address,
      abi: VAULT_BALANCE_ABI,
      functionName: "tokenBalance",
      args: [TOKENS.USDm.address],
    });
    console.log(`${tag} round trip complete — vault USDm now ${(Number(usdmAfter) / 1e18).toFixed(6)} (spent ${ARB_AMOUNT_HUMAN} USDm on leg 1).`);
  }
}

async function tick() {
  if (ticking) return; // never let a slow tick overlap the next one
  ticking = true;
  const startedAt = Date.now();

  try {
    await connectDB();
    await reconcileVaultsFromChain();
    const users = await User.find({ vaultAddress: { $exists: true, $ne: null } });
    console.log(`Found ${users.length} user(s) with a vault.`);

    for (const user of users) {
      const profile = (await RiskProfile.findOne({ userId: user._id })) ?? DEFAULT_RISK_PROFILE;
      if ((profile as any).paused) {
        console.log(`[${user.walletAddress.slice(0, 8)}] skipped: risk profile is paused.`);
        continue;
      }

      const strategies: string[] = profile.enabledStrategies?.length ? profile.enabledStrategies : DEFAULT_RISK_PROFILE.enabledStrategies;

      // Self-enforced daily trade budget (the vault separately enforces
      // token-unit caps on-chain; this one is about count), shared across
      // whichever strategies this user has enabled.
      const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
      const tradesToday = await TradeLog.countDocuments({
        userId: user._id,
        status: { $in: ["submitted", "settled"] },
        createdAt: { $gte: since },
      });
      if (tradesToday >= profile.maxTradesPerDay) {
        console.log(`[${user.walletAddress.slice(0, 8)}] skipped: hit daily trade cap (${tradesToday}/${profile.maxTradesPerDay}).`);
        continue;
      }

      console.log(`[${user.walletAddress.slice(0, 8)}] strategies: ${strategies.join(", ")}`);
      if (strategies.includes("rebalance")) await runRebalance(user, profile);
      if (strategies.includes("dca")) await runDca(user, profile);
      if (strategies.includes("arbitrage")) await runArbitrage(user, profile);
    }
  } catch (err) {
    console.error("Worker tick failed:", err instanceof Error ? err.message : err);
  } finally {
    ticking = false;
    console.log(`tick complete in ${Date.now() - startedAt}ms — next in ${HEARTBEAT_SECONDS}s`);
  }
}

async function start() {
  console.log(`Vomia worker starting. Heartbeat: ${HEARTBEAT_SECONDS}s, scan size: ${SCAN_AMOUNT_HUMAN} units.`);
  // Mongoose doesn't alter existing indexes on a live collection just
  // because the schema changed — a stale unique index on the old
  // web3AuthSub field (since made optional) was still rejecting any second
  // user record without one. Sync once at startup so the live indexes
  // always match the current schema, instead of needing a one-off manual
  // fix every time a schema constraint changes.
  await connectDB();
  await User.syncIndexes();
  await RiskProfile.syncIndexes();
  await TradeLog.syncIndexes();
  tick();
  setInterval(tick, HEARTBEAT_SECONDS * 1000);
}

start();
