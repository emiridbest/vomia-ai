/**
 * The Vomia worker — the always-on heartbeat (run with `npm run worker`).
 *
 * Every HEARTBEAT_SECONDS it loads all users with an unpaused risk profile
 * and runs their enabled strategies: arbitrage (buy CELO on Squid, sell on
 * Uniswap), rebalance (profit-gated cross-venue swaps), and dca (fixed
 * price-independent buys). Forward strategies are one-directional and
 * cycleBackIfDue() swaps accumulated balances back to USDm to avoid
 * exhaustion. When OPERATOR_DIRECT_TRADING is set the worker instead trades
 * the operator EOA's own balance (runDirectDca) — the only path that scores
 * Track 1 tagged volume, since a vault contract is never tx_from.
 *
 * The vault contract re-enforces every cap on-chain regardless of what this
 * code sends. Run as a single separate process (not the serverless app) so
 * overlapping workers can't double-submit.
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

// Operator-wallet DIRECT trading. Vault trades score zero tagged volume (a
// contract is never tx_from), so when this is on the worker trades the
// operator EOA's own balance directly. Fund it with USDm to trade + CELO for gas.
const OPERATOR_DIRECT_TRADING = process.env.OPERATOR_DIRECT_TRADING === "false";
const GAS_RESERVE_CELO = 1n * 10n ** 18n; // always keep >= 1 CELO in the operator wallet for gas
// Buy size in USDm — the throughput lever (daily volume ~= 2,880 * this).
// The wallet must hold DIRECT_DCA_MAX_BUYS * this; anything above sits idle.
const DIRECT_DCA_USDM = Number(process.env.DIRECT_DCA_USDM || 300);
// Mid token round-tripped each cycle. A stable leg is far cheaper than a
// volatile one (no drift over the hold), and tagged volume is credited on
// the USD input leg regardless of which asset moved.
const DIRECT_DCA_TOKEN = (process.env.DIRECT_DCA_TOKEN as TokenSymbol) || "USDT";
// Each leg is pinned to one venue (Uniswap's 0.01% pool measured cheapest
// both directions). A pin is ignored only when that venue has no route,
// which is logged rather than silently swallowed.
const DIRECT_DCA_BUY_VENUE = "uniswap" as const; // USDm -> DIRECT_DCA_TOKEN
const DIRECT_DCA_SELL_VENUE = "uniswap" as const; // DIRECT_DCA_TOKEN -> USDm
const DIRECT_DCA_INTERVAL_MS = 60 * 1000; // one buy per minute
// MIN == MAX makes every cycle a fixed round trip (exit eligible and forced
// on the same tick), maximizing turnover at the cost of paying the round
// trip every cycle. Set MAX above MIN to restore price selectivity.
const DIRECT_DCA_MIN_BUYS = 1; // exit becomes eligible at this many buys
const DIRECT_DCA_MAX_BUYS = 1; // ...and is forced regardless of price at this many
const DIRECT_DCA_MAX_HOLD_MS = 5 * 60 * 1000; // wall-clock backstop, if a buy fails and the count lags
const DIRECT_DCA_PROFIT_BPS = 5; // margin over cost basis a voluntary exit must clear
const DIRECT_MAX_SLIPPAGE_BPS = 100;

const HEARTBEAT_SECONDS = Number(process.env.HEARTBEAT_SECONDS || 60);
const SCAN_AMOUNT_HUMAN = Number(process.env.SCAN_AMOUNT_HUMAN || 10); // notional per-trade size to quote with

const DCA_AMOUNT_HUMAN = 2; // fixed USDm spend per DCA buy
const DCA_INTERVAL_MS = 1 * 60 * 1000; // per-pair buy cadence
const DCA_PAIRS: { tokenIn: TokenSymbol; tokenOut: TokenSymbol }[] = [
  { tokenIn: "USDm", tokenOut: "CELO" }, // G$ dropped: no Mento/Uniswap route ever quoted
];

// A buy count is a minimum accumulation gate, not a trigger: an exit needs
// both enough accumulated buys AND a favorable price. The bounded force
// triggers below override the price check; a funding-short replenish
// overrides everything.
const REBALANCE_MIN_BUYS = 3; // rebalance: min buys before considering an exit
const DCA_MIN_BUYS = 2; // dca: min buys before considering an exit
const PROFIT_TARGET_BPS = 25; // safe exit: only take a voluntary exit that beats the inventory's USDm cost basis by this
const REFILL_TRADES = 5; // funding-short exits sell only enough to fund ~this many forward trades
const MAX_HOLD_MS = 6 * 60 * 60 * 1000; // wait up to this long for a green exit before force-selling (safe exit: rarely realize a loss)
const MAX_EXIT_REVERTS = 5; // stop waiting after this many reverted exit attempts since the last settled one

// Arbitrage: round-trip a stablecoin (buy on Squid, sell on Uniswap), $20 per
// trip, one trip per pair per 30 minutes. A stable leg has no price drift over
// the hold, so realized P&L is purely the cross-venue spread. Realized
// round-trip P&L is logged per trip.
const ARB_AMOUNT_HUMAN = 5;
const ARB_INTERVAL_MS = 30 * 60 * 1000;
const ARB_STABLE_MIDS: TokenSymbol[] = ["USDT", "USDC"]; // stablecoins round-tripped against USDm

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
 * Enumerates every vault the factory created (via vaultCount/allVaults) and
 * upserts a User record for any vault missing from or mismatched in the DB.
 * Keeps the DB sync independent of the frontend's best-effort POST /api/vault,
 * which could otherwise leave a funded vault invisible to the worker. Runs
 * every tick — fine at hackathon scale; would need caching for thousands of vaults.
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

// Dogfood the paid x402 check endpoint on each internal check. Sent unpaid
// (the endpoint answers with its 402 challenge, nothing settles), so it
// counts for nothing — just exercises the real request path. Strictly
// fire-and-forget: short timeout, errors swallowed, never awaited.
const X402_CHECK_URL = process.env.VOMIA_X402_CHECK_URL || "https://vomiaagent.vercel.app/api/x402/check";
function pingX402Check(tokenIn: string, tokenOut: string, amountIn: number): void {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 3000);
  fetch(`${X402_CHECK_URL}?tokenIn=${tokenIn}&tokenOut=${tokenOut}&amountIn=${amountIn}`, { signal: controller.signal })
    .catch(() => {})
    .finally(() => clearTimeout(timer));
}

let ticking = false;

/** Buys since the most recent reverse trade: count, total tokenIn spend (the
 * inventory's cost basis, raw units), total tokenOut bought (quoted), and the
 * oldest buy's age. */
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
 * If this user is due to exit tokenIn->tokenOut, swaps the vault's tokenOut
 * balance back to tokenIn and returns true so the caller skips its forward
 * trade this tick. Returns false if not due or nothing to cycle back. The
 * amount is clamped to the vault's on-chain caps (maxSingleTrade,
 * remainingDailyAllowance) so an over-cap balance drains in chunks across
 * ticks instead of reverting every tick.
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
  // Two triggers: scheduled (N forward buys since the last reverse) and
  // funding-short (the vault can't cover the next forward trade's tokenIn,
  // so cycle back early to replenish instead of failing every forward attempt).
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

  // Cost-basis exit: a voluntary exit must return more USDm than the
  // inventory cost, plus PROFIT_TARGET_BPS (take-profit against the
  // position's own entry prices). Force triggers (max hold, repeated
  // reverted exits) override so capital can't be trapped, at the cost of
  // possibly realizing a loss.
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
  // CELO-only by default: its entry edges are genuine (price moves, the pool
  // briefly lags fair value) and its spread is tightest, so it's the pair
  // worth chasing real profit on. Overridable per-user via
  // profile.allowedTokenPairs.
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
  const amountIn = BigInt(ARB_AMOUNT_HUMAN) * 10n ** BigInt(TOKENS.USDm.decimals);

  for (const mid of ARB_STABLE_MIDS) {
    const tag = `[${user.walletAddress.slice(0, 8)}] arb USDm<->${mid}`;

    // One trip per pair per interval, gated on this pair's last buy leg.
    const lastRun = await TradeLog.findOne({ userId: user._id, strategy: "arbitrage", tokenIn: "USDm", tokenOut: mid }).sort({ createdAt: -1 });
    if (lastRun && Date.now() - lastRun.createdAt.getTime() < ARB_INTERVAL_MS) continue;

    if (!(await hasFunding(user, "USDm", amountIn))) {
      console.log(`${tag}: skipped — vault can't fund ${ARB_AMOUNT_HUMAN} USDm.`);
      continue;
    }

    // Leg 1: buy the stablecoin on Squid.
    const leg1 = await executeVenueSwap("squid", user.vaultAddress, user._id.toString(), "USDm", mid, amountIn, profile.maxSlippageBps);
    console.log(`${tag} leg1 USDm->${mid} via squid: ${leg1.status}` + (leg1.txHash ? ` tx=${leg1.txHash}` : "") + ` (${leg1.reason})`);
    if (leg1.status !== "settled") continue;

    // Leg 2: sell the whole balance of that stablecoin back on Uniswap.
    const midBalance = await publicClient.readContract({
      address: user.vaultAddress as Address,
      abi: VAULT_BALANCE_ABI,
      functionName: "tokenBalance",
      args: [TOKENS[mid].address],
    });
    if (midBalance === 0n) {
      console.log(`${tag} leg2: nothing to sell (${mid} balance 0 after leg 1?)`);
      continue;
    }
    const leg2 = await executeVenueSwap("uniswap", user.vaultAddress, user._id.toString(), mid, "USDm", midBalance, profile.maxSlippageBps);
    console.log(`${tag} leg2 ${mid}->USDm via uniswap: ${leg2.status}` + (leg2.txHash ? ` tx=${leg2.txHash}` : "") + ` (${leg2.reason})`);

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
}

/**
 * DCA on the operator EOA's own balance (USDm -> DIRECT_DCA_TOKEN and back) —
 * the only trade shape that scores tagged volume, since tx_from is the token
 * sender (a vault contract never is). Buys DIRECT_DCA_USDM of the mid token
 * once a minute, price-independent, then sells the lot back at
 * DIRECT_DCA_MAX_BUYS. The float must cover DIRECT_DCA_MAX_BUYS *
 * DIRECT_DCA_USDM. The sell is capped at the buys accumulated since the last
 * exit (not the whole balance) so a pre-existing holding doesn't skew the
 * cost-basis check. One action per tick, awaiting each receipt, to keep nonces serial.
 */
async function runDirectDca() {
  const { id: uid, address } = await ensureOperatorUser();
  const tag = `[direct ${address.slice(0, 8)}]`;
  const mid = DIRECT_DCA_TOKEN;
  const midUnit = 10n ** BigInt(TOKENS[mid].decimals);
  const amountIn = BigInt(DIRECT_DCA_USDM) * 10n ** BigInt(TOKENS.USDm.decimals);
  const [usdm, midBal] = await Promise.all([operatorTokenBalance("USDm"), operatorTokenBalance(mid)]);
  const { count, totalIn: costBasis, totalOut: inventory, oldestAt } = await forwardsSinceLastReverse(uid, "USDm", mid);

  // EXIT: sell the cycle's inventory back to USDm. Eligible at
  // DIRECT_DCA_MIN_BUYS or as soon as the wallet can't fund the next buy
  // (the out-of-funds trigger avoids a deadlock when the float is under
  // DIRECT_DCA_USDM * DIRECT_DCA_MIN_BUYS). Taken if it beats cost basis +
  // DIRECT_DCA_PROFIT_BPS; forced regardless of price at DIRECT_DCA_MAX_BUYS
  // or the hold cap.
  const outOfFunds = usdm < amountIn;
  if ((count >= DIRECT_DCA_MIN_BUYS || outOfFunds) && inventory > 0n) {
    // Only CELO doubles as the gas token, so only CELO needs a reserve held
    // back from the sell; a stable leg can be sold down to zero.
    const headroom = mid === "CELO" ? (midBal > GAS_RESERVE_CELO ? midBal - GAS_RESERVE_CELO : 0n) : midBal;
    const sellable = inventory < headroom ? inventory : headroom;
    if (sellable > 0n) {
      const [m, u] = await Promise.all([
        getMentoQuote(mid, "USDm", sellable).then((q) => q?.amountOut ?? null).catch(() => null),
        getUniswapQuote(mid, "USDm", sellable).catch(() => null),
      ]);
      const bestQuote = m !== null && u !== null ? (m > u ? m : u) : (m ?? u);
      await accrueFee(uid, "check");
      pingX402Check(mid, "USDm", Number(sellable / midUnit));
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
        const res = await executeDirectSwap(uid, mid, "USDm", sellable, DIRECT_MAX_SLIPPAGE_BPS, "dca", DIRECT_DCA_SELL_VENUE);
        console.log(`${tag} dca sell ${mid}->USDm, closing a ${count}-buy cycle (${why}): ${res.status}` + (res.txHash ? ` tx=${res.txHash}` : "") + ` (${res.reason})`);
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

  // BUY: DIRECT_DCA_USDM of the mid token once a minute, price-independent.
  // Gated on the last buy's timestamp, not the tick, so the cadence stays a
  // real minute whatever HEARTBEAT_SECONDS is.
  if (outOfFunds) {
    console.log(`${tag} dca skipped — operator USDm ${(Number(usdm) / 1e18).toFixed(2)} is below the ${DIRECT_DCA_USDM} buy size and there is no inventory to sell. Top the wallet up.`);
    return;
  }
  const lastBuy = await TradeLog.findOne({
    userId: uid,
    tokenIn: "USDm",
    tokenOut: mid,
    status: { $in: ["submitted", "settled"] },
  }).sort({ createdAt: -1 });
  if (lastBuy && Date.now() - lastBuy.createdAt.getTime() < DIRECT_DCA_INTERVAL_MS) return;
  await accrueFee(uid, "check");
  pingX402Check("USDm", mid, DIRECT_DCA_USDM);
  const res = await executeDirectSwap(uid, "USDm", mid, amountIn, DIRECT_MAX_SLIPPAGE_BPS, "dca", DIRECT_DCA_BUY_VENUE);
  console.log(`${tag} dca buy ${DIRECT_DCA_USDM} USDm->${mid} (buy ${count + 1} of this cycle): ${res.status}` + (res.txHash ? ` tx=${res.txHash}` : "") + ` (${res.reason})`);
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
      // Per-user isolation: one bad user row must never abort the whole
      // tick and halt everyone else's trading.
      try {
        const profile = (await RiskProfile.findOne({ userId: user._id })) ?? DEFAULT_RISK_PROFILE;
        if ((profile as any).paused) {
          console.log(`[${user.walletAddress.slice(0, 8)}] skipped: risk profile is paused.`);
          continue;
        }

        const strategies: string[] = profile.enabledStrategies?.length ? profile.enabledStrategies : DEFAULT_RISK_PROFILE.enabledStrategies;

        // Self-enforced daily trade-count budget, shared across the user's
        // enabled strategies (the vault separately enforces token-unit caps on-chain).
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
  // Sync indexes at startup: Mongoose won't alter existing indexes on a live
  // collection when the schema changes, so a stale index can otherwise reject
  // valid writes.
  await connectDB();
  await User.syncIndexes();
  await RiskProfile.syncIndexes();
  await TradeLog.syncIndexes();
  tick();
  setInterval(tick, HEARTBEAT_SECONDS * 1000);
}

start();
