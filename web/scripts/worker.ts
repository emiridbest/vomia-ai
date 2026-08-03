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
 * All of the above is the vault product. When OPERATOR_DIRECT_TRADING is set
 * the worker does none of it, and instead DCAs the operator EOA's own balance
 * (runDirectDca) — the operator's funds, not any user's vault, and the only
 * trades that score Track 1 tagged volume. See that function for why.
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
import { accrueFee, User, RiskProfile, TradeLog } from "../lib/db/models";
import { scanPair } from "../lib/strategy/spreadScanner";
import { getMentoQuote } from "../lib/dex/mento";
import { getUniswapQuote } from "../lib/dex/uniswap";
import { getReferenceAmountOut } from "../lib/dex/oracle";
import { executeIfProfitable, executeDca, executeVenueSwap } from "../lib/strategy/executor";
import { ensureOperatorUser, executeDirectSwap, operatorTokenBalance } from "../lib/strategy/directTrader";
import { TOKENS, type TokenSymbol } from "../lib/tokens";
import { DEFAULT_RISK_PROFILE } from "../lib/strategy/riskProfile";
import { rpcUrl } from "../lib/chains";

// Operator-wallet DIRECT trading. Vault-mediated trades score ZERO Track 1
// tagged volume (a contract is never tx_from), so when this is on the worker
// DCAs the operator EOA's own USDm/CELO directly (tag on the tx tail,
// tx_from == token sender) and skips the per-vault loops entirely to conserve
// gas. Fund the operator wallet with USDm to trade + CELO for gas.
const OPERATOR_DIRECT_TRADING = process.env.OPERATOR_DIRECT_TRADING === "true";
const GAS_RESERVE_CELO = 1n * 10n ** 18n; // always keep >= 1 CELO in the operator wallet for gas
const DIRECT_DCA_USDM = 10; // owner-set: operator DCA buy size, in USDm
const DIRECT_DCA_INTERVAL_MS = 60 * 1000; // one buy per minute — the real cadence, independent of the heartbeat
const DIRECT_DCA_MIN_BUYS = 3; // sell from the 4th buy on, but only if the quote is green
const DIRECT_DCA_MAX_BUYS = 3; // ...and unconditionally by the 5th
const DIRECT_DCA_MAX_HOLD_MS = 5 * 60 * 1000; // wall-clock backstop for that same "by the 5th minute" rule
const DIRECT_DCA_PROFIT_BPS = 5; // a voluntary (4th-buy) exit must beat the cycle's cost basis by this
const DIRECT_MAX_SLIPPAGE_BPS = 100;

const HEARTBEAT_SECONDS = Number(process.env.HEARTBEAT_SECONDS || 60);
const SCAN_AMOUNT_HUMAN = Number(process.env.SCAN_AMOUNT_HUMAN || 10); // notional per-trade size to quote with

const DCA_AMOUNT_HUMAN = 2; // fixed USDm spend per DCA buy, per the product spec
const DCA_INTERVAL_MS = 1 * 60 * 1000; // per-pair buy cadence (owner-set; rebalance cadence is the heartbeat itself)
const DCA_PAIRS: { tokenIn: TokenSymbol; tokenOut: TokenSymbol }[] = [
  // G$ was dropped from DCA (and the app's default token set): no Mento
  // exchange and no Uniswap v3 pool at any fee tier ever quoted a route,
  // so every buy attempt just logged a no-route skip.
  { tokenIn: "USDm", tokenOut: "CELO" },
];

// Exit design, after two live corrections: a buy count is a MINIMUM
// accumulation gate, never a trigger. (A count-as-trigger forced selling on
// a schedule regardless of price — spread bleed; no count at all made one
// buy "inventory" and exits fired every other tick — churn with no
// accumulation.) An exit now requires BOTH enough accumulated buys AND a
// favorable price; only the bounded force triggers below override the
// price check, and a funding-short replenish overrides everything.
const REBALANCE_MIN_BUYS = 3; // rebalance: accumulate at least this many buys before considering an exit
const DCA_MIN_BUYS = 10; // dca: accumulate at least this many buys before considering an exit
const PROFIT_TARGET_BPS = 10; // voluntary exits require the quote to beat the inventory's USDm cost basis by this margin
const REFILL_TRADES = 5; // funding-short exits sell only enough inventory to fund about this many forward trades
const MAX_HOLD_MS = 20 * 60 * 1000; // never hold inventory longer than this waiting for a good exit
const MAX_EXIT_REVERTS = 3; // stop waiting after this many actual exit attempts reverted since the last settled one

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

// Dogfood the product's own paid API surface: each internal check also
// pings the deployed x402 check endpoint as an ordinary client. Sent
// UNPAID on purpose — the endpoint answers with its 402 payment challenge
// and nothing settles, so this counts for nothing on any leaderboard; it
// exercises the real request path the trial's metered fees will settle
// through later. Strictly fire-and-forget: short timeout, every error
// swallowed, never awaited by trading logic.
const X402_CHECK_URL = process.env.VOMIA_X402_CHECK_URL || "https://vomiaagent.vercel.app/api/x402/check";
function pingX402Check(tokenIn: string, tokenOut: string, amountIn: number): void {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 3000);
  fetch(`${X402_CHECK_URL}?tokenIn=${tokenIn}&tokenOut=${tokenOut}&amountIn=${amountIn}`, { signal: controller.signal })
    .catch(() => {})
    .finally(() => clearTimeout(timer));
}

let ticking = false;



/** Buys since the most recent reverse trade: how many, their total tokenIn
 * spend (the inventory's cost basis, raw units), the total tokenOut they
 * bought (quoted, so within slippage of what actually landed), and the oldest
 * buy's age. */
async function forwardsSinceLastReverse(
  userId: string,
  tokenIn: TokenSymbol,
  tokenOut: TokenSymbol
): Promise<{ count: number; totalIn: bigint; totalOut: bigint; oldestAt: Date | null }> {
  const lastReverse = await TradeLog.findOne({
    userId,
    tokenIn: tokenOut,
    tokenOut: tokenIn,
    status: { $in: ["submitted", "settled"] },
  }).sort({ createdAt: -1 });
  const since = lastReverse ? lastReverse.createdAt : new Date(0);
  const forwards = await TradeLog.find({
    userId,
    tokenIn,
    tokenOut,
    status: { $in: ["submitted", "settled"] },
    createdAt: { $gt: since },
  }).sort({ createdAt: 1 }).lean();
  let totalIn = 0n;
  let totalOut = 0n;
  for (const f of forwards) {
    totalIn += BigInt(f.amountIn);
    if (f.amountOut) totalOut += BigInt(f.amountOut);
  }
  return { count: forwards.length, totalIn, totalOut, oldestAt: forwards.length ? forwards[0].createdAt : null };
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
  minBuys: number,
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
  const { count: forwardCount, totalIn: costBasis, oldestAt } = await forwardsSinceLastReverse(user._id.toString(), tokenIn, tokenOut);
  const balanceIn = await publicClient.readContract({
    address: user.vaultAddress as Address,
    abi: VAULT_BALANCE_ABI,
    functionName: "tokenBalance",
    args: [TOKENS[tokenIn].address],
  });
  const fundingShort = balanceIn < neededIn;
  // Enough accumulated buys makes an exit ELIGIBLE; the edge check below
  // decides whether to actually take it.
  const scheduled = !fundingShort && forwardCount >= minBuys;
  if (!fundingShort && !scheduled) return false;
  const trigger = fundingShort ? `replenishing ${tokenIn} (balance below trade size)` : `after ${forwardCount} buys, exit favorable or forced`;

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

  // Cost-basis exit (owner-requested): a voluntary exit must return MORE
  // USDm than the inventory actually cost, plus PROFIT_TARGET_BPS — a
  // take-profit against the position's own entry prices, not against the
  // oracle. The force triggers (max hold, repeated reverted exits) still
  // override so a falling market can't trap capital forever; those exits
  // can realize losses, which is the accepted price of never being stuck.
  if (scheduled) {
    const [bestQuote, revertedReverses] = await Promise.all([
      Promise.all([
        getMentoQuote(tokenOut, tokenIn, amount).then((q) => q?.amountOut ?? null).catch(() => null),
        getUniswapQuote(tokenOut, tokenIn, amount).catch(() => null),
      ]).then(([m, u]) => (m !== null && u !== null ? (m > u ? m : u) : m ?? u)),
      (async () => {
        const lastSettledReverse = await TradeLog.findOne({
          userId: user._id.toString(),
          tokenIn: tokenOut,
          tokenOut: tokenIn,
          status: { $in: ["submitted", "settled"] },
        }).sort({ createdAt: -1 });
        return TradeLog.countDocuments({
          userId: user._id.toString(),
          tokenIn: tokenOut,
          tokenOut: tokenIn,
          status: "reverted",
          createdAt: { $gt: lastSettledReverse ? lastSettledReverse.createdAt : new Date(0) },
        });
      })(),
    ]);
    await accrueFee(user._id.toString(), "check"); // exit-eligibility check quotes venues
    pingX402Check(tokenOut, tokenIn, Number(amount / 10n ** 18n));

    // Selling a clamped portion of the inventory only needs to beat the
    // same portion of the cost basis.
    const basisForAmount = balance > 0n ? (costBasis * amount) / balance : costBasis;
    const target = basisForAmount + (basisForAmount * BigInt(PROFIT_TARGET_BPS)) / 10000n;
    if (bestQuote === null || bestQuote < target) {
      const heldMs = oldestAt ? Date.now() - oldestAt.getTime() : 0;
      const force =
        heldMs >= MAX_HOLD_MS
          ? "max hold reached"
          : revertedReverses >= MAX_EXIT_REVERTS
            ? `${revertedReverses} reverted exit attempts`
            : null;
      if (!force) {
        // Quietly wait — forward trading continues; this is the normal
        // resting state between cycles, not an exceptional postponement.
        return false;
      }
      console.log(
        `[${user.walletAddress.slice(0, 8)}] ${strategy}-cycle-back ${tokenOut}->${tokenIn}: forcing exit below cost basis (quote ${bestQuote ?? "n/a"} < target ${target}) — ${force}.`
      );
    } else {
      const profitBps = basisForAmount > 0n ? Number(((bestQuote - basisForAmount) * 10000n) / basisForAmount) : 0;
      console.log(
        `[${user.walletAddress.slice(0, 8)}] ${strategy}-cycle-back ${tokenOut}->${tokenIn}: taking profit — quote beats cost basis by ${profitBps}bps.`
      );
    }
  } else if (fundingShort) {
    // Partial replenish: sell only enough inventory to fund ~REFILL_TRADES
    // more forward trades instead of dumping the whole position at
    // whatever the current price is — the rest keeps waiting for its
    // profit target.
    const refFull = await getReferenceAmountOut(tokenOut, tokenIn, balance);
    if (refFull !== null && refFull > 0n) {
      const wantIn = neededIn * BigInt(REFILL_TRADES);
      if (wantIn < refFull) {
        let partial = (balance * wantIn) / refFull;
        if (partial === 0n) partial = balance;
        if (partial < amount) amount = partial;
      }
    }
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
  // CELO-only by default, based on 36h of realized results (1,804 settled
  // trades): CELO's entry edges are genuine (its price actually moves, so
  // the pool briefly lags fair value ~400x/day) and its spread is the
  // tightest, netting -0.79% of turnover vs -1.3% to -2.3% on KESm/NGNm/
  // EURm — whose large quoted "edges" (avg +180..290bps) were mostly
  // oracle staleness, not capturable dislocations. Regional pairs can
  // still be enabled per-user via profile.allowedTokenPairs.
  const pairs: { tokenIn: TokenSymbol; tokenOut: TokenSymbol }[] = profile.allowedTokenPairs?.length
    ? profile.allowedTokenPairs
    : [{ tokenIn: "USDm", tokenOut: "CELO" }];

  for (const pair of pairs) {
    const decimalsIn = TOKENS[pair.tokenIn].decimals;
    const amountIn = BigInt(Math.floor(SCAN_AMOUNT_HUMAN * 10 ** decimalsIn));

    const cycled = await cycleBackIfDue(user, pair.tokenIn, pair.tokenOut, REBALANCE_MIN_BUYS, "rebalance", profile.maxSlippageBps, amountIn);
    if (cycled) continue;

    if (!(await hasFunding(user, pair.tokenIn, amountIn))) {
      console.log(`[${user.walletAddress.slice(0, 8)}] rebalance ${pair.tokenIn}->${pair.tokenOut}: skipped — vault ${pair.tokenIn} balance below trade size and nothing to cycle back.`);
      continue;
    }

    const scan = await scanPair(pair.tokenIn, pair.tokenOut, amountIn, SCAN_AMOUNT_HUMAN, profile);
    await accrueFee(user._id.toString(), "check");
    pingX402Check(pair.tokenIn, pair.tokenOut, SCAN_AMOUNT_HUMAN);

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

    const cycled = await cycleBackIfDue(user, pair.tokenIn, pair.tokenOut, DCA_MIN_BUYS, "dca", profile.maxSlippageBps, amountIn);
    if (cycled) continue;

    const lastRun = await TradeLog.findOne({ userId: user._id, strategy: "dca", tokenIn: pair.tokenIn, tokenOut: pair.tokenOut }).sort({
      createdAt: -1,
    });
    if (lastRun && Date.now() - lastRun.createdAt.getTime() < DCA_INTERVAL_MS) continue;

    if (!(await hasFunding(user, pair.tokenIn, amountIn))) {
      console.log(`[${user.walletAddress.slice(0, 8)}] dca ${pair.tokenIn}->${pair.tokenOut}: skipped — vault ${pair.tokenIn} balance below buy size and nothing to cycle back.`);
      continue;
    }

    await accrueFee(user._id.toString(), "check"); // the buy itself quotes every venue
    pingX402Check(pair.tokenIn, pair.tokenOut, DCA_AMOUNT_HUMAN);
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

/**
 * DCA on the operator EOA's OWN balance (USDm -> CELO). This is the only
 * shape of trade that scores Track 1 tagged volume: tx_from == the token
 * sender, so the input leg is credited at full USD value. A vault trade never
 * can be — a contract is never tx_from.
 *
 * The schedule, owner-set: buy DIRECT_DCA_USDM (10) of CELO once a minute,
 * price-independent (that is what makes it DCA rather than the rebalance
 * strategy), then close the cycle back to USDm from the 4th buy on if the
 * quote beats the cycle's cost basis, and unconditionally by the 5th.
 *
 * The working balance sets the real cycle length, because the wallet spends
 * its whole float before the exit returns it: a 30 USDm float buys 3 times
 * and then exits on the funding-short trigger below, so cycles run ~3-5
 * minutes and turn over ~30 USDm. Fund it with 50+ USDm to actually reach
 * the 4th and 5th buys.
 *
 * The sell is capped at what the logged buys since the last exit actually
 * accumulated, rather than being the whole balance less a gas reserve: any
 * pre-existing CELO was never bought at one of this cycle's prices, so
 * including it both skews the cost-basis check and spends the gas float.
 *
 * One action per tick, each awaiting its receipt, to keep nonces serial.
 */
async function runDirectDca() {
  const { id: uid, address } = await ensureOperatorUser();
  const tag = `[direct ${address.slice(0, 8)}]`;
  const amountIn = BigInt(DIRECT_DCA_USDM) * 10n ** BigInt(TOKENS.USDm.decimals);
  const [usdm, celoBal] = await Promise.all([operatorTokenBalance("USDm"), operatorTokenBalance("CELO")]);
  const { count, totalIn: costBasis, totalOut: inventory, oldestAt } = await forwardsSinceLastReverse(uid, "USDm", "CELO");

  // ---- EXIT: sell the cycle's CELO back to USDm. Eligible from the 4th buy,
  // OR as soon as the wallet can't fund the next buy — on a working balance
  // under DIRECT_DCA_USDM * DIRECT_DCA_MIN_BUYS the cycle just ends short (a
  // 30 USDm float buys 3 times, not 4). Without that second trigger the loop
  // deadlocks: no USDm left to buy with, and a buy count permanently below
  // the exit gate, so it would sit there logging skips forever.
  //
  // Either way the exit is taken only if it beats cost basis +
  // DIRECT_DCA_PROFIT_BPS; the 5th buy or a 5-minute hold forces it
  // regardless of price, which is what bounds the cycle. ----
  const outOfFunds = usdm < amountIn;
  if ((count >= DIRECT_DCA_MIN_BUYS || outOfFunds) && inventory > 0n) {
    const headroom = celoBal > GAS_RESERVE_CELO ? celoBal - GAS_RESERVE_CELO : 0n;
    const sellable = inventory < headroom ? inventory : headroom;
    if (sellable > 0n) {
      const [m, u] = await Promise.all([
        getMentoQuote("CELO", "USDm", sellable).then((q) => q?.amountOut ?? null).catch(() => null),
        getUniswapQuote("CELO", "USDm", sellable).catch(() => null),
      ]);
      const bestQuote = m !== null && u !== null ? (m > u ? m : u) : (m ?? u);
      await accrueFee(uid, "check");
      pingX402Check("CELO", "USDm", Number(sellable / 10n ** 18n));
      const basisPortion = (costBasis * sellable) / inventory;
      const target = basisPortion + (basisPortion * BigInt(DIRECT_DCA_PROFIT_BPS)) / 10000n;
      const heldMs = oldestAt ? Date.now() - oldestAt.getTime() : 0;
      const takeProfit = bestQuote !== null && bestQuote >= target;
      const forced = count >= DIRECT_DCA_MAX_BUYS || heldMs >= DIRECT_DCA_MAX_HOLD_MS;
      if (takeProfit || forced) {
        const why = takeProfit
          ? `take-profit +${DIRECT_DCA_PROFIT_BPS}bps`
          : count >= DIRECT_DCA_MAX_BUYS
            ? `forced at ${count} buys`
            : `forced at ${Math.round(heldMs / 60000)}min hold`;
        const res = await executeDirectSwap(uid, "CELO", "USDm", sellable, DIRECT_MAX_SLIPPAGE_BPS, "dca");
        console.log(`${tag} dca sell CELO->USDm, closing a ${count}-buy cycle (${why}): ${res.status}` + (res.txHash ? ` tx=${res.txHash}` : "") + ` (${res.reason})`);
        return;
      }
      const held = `${Math.round(heldMs / 60000)}min`;
      console.log(
        `${tag} dca holding ${count} buys${outOfFunds ? " (out of USDm — this cycle is done buying)" : ""} at ${held} — quote under cost basis +${DIRECT_DCA_PROFIT_BPS}bps; sells anyway by ${DIRECT_DCA_MAX_HOLD_MS / 60000}min.`
      );
      // Out of USDm means there is no buy to fall through to.
      if (outOfFunds) return;
    }
  }

  // ---- BUY: 10 USDm of CELO, once a minute, price-independent. Gated on the
  // last buy's timestamp rather than on the tick, so the cadence stays a real
  // minute whatever HEARTBEAT_SECONDS is set to. ----
  if (outOfFunds) {
    console.log(`${tag} dca skipped — operator USDm ${(Number(usdm) / 1e18).toFixed(2)} is below the ${DIRECT_DCA_USDM} buy size and there is no inventory to sell. Top the wallet up.`);
    return;
  }
  const lastBuy = await TradeLog.findOne({
    userId: uid,
    tokenIn: "USDm",
    tokenOut: "CELO",
    status: { $in: ["submitted", "settled"] },
  }).sort({ createdAt: -1 });
  if (lastBuy && Date.now() - lastBuy.createdAt.getTime() < DIRECT_DCA_INTERVAL_MS) return;
  await accrueFee(uid, "check");
  pingX402Check("USDm", "CELO", DIRECT_DCA_USDM);
  const res = await executeDirectSwap(uid, "USDm", "CELO", amountIn, DIRECT_MAX_SLIPPAGE_BPS, "dca");
  console.log(`${tag} dca buy ${DIRECT_DCA_USDM} USDm->CELO (buy ${count + 1} of this cycle): ${res.status}` + (res.txHash ? ` tx=${res.txHash}` : "") + ` (${res.reason})`);
}

async function tick() {
  if (ticking) return; // never let a slow tick overlap the next one
  ticking = true;
  const startedAt = Date.now();

  try {
    await connectDB();
    if (OPERATOR_DIRECT_TRADING) {
      await runDirectDca();
      return;
    }
    await reconcileVaultsFromChain();
    const users = await User.find({ vaultAddress: { $exists: true, $ne: null } });
    console.log(`Found ${users.length} user(s) with a vault.`);

    for (const user of users) {
      // Per-user isolation: a single bad user row (e.g. a non-contract
      // vaultAddress that makes tokenBalance() throw) must never abort the
      // whole tick and halt everyone else's trading, as it once did.
      try {
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
      } catch (userErr) {
        console.error(`[${user.walletAddress.slice(0, 8)}] tick error (skipped, other users continue):`, userErr instanceof Error ? userErr.message : userErr);
      }
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
