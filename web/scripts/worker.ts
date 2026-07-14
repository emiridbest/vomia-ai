/**
 * The Vomia worker — the always-on heartbeat (run with `npm run worker`).
 *
 * Every HEARTBEAT_SECONDS it: loads all users with an unpaused risk
 * profile, scans each of their allowed token pairs across venues, and for
 * any scan that clears the user's own profit margin, executes through
 * their vault (which re-enforces every cap on-chain regardless of what
 * this code does).
 *
 * Honest capacity math for the "1000 trades/day" target: at a 60s
 * heartbeat this loop *checks* each pair ~1,440 times a day, so the
 * pipeline can execute 1000+/day *if the market offers that many
 * above-margin opportunities*. It will not manufacture trades to hit a
 * number — every skipped tick is logged with its reason, which is itself
 * useful demo material ("the agent declined 1,395 times today and here's
 * why" is a better judging story than 1,000 forced losses).
 *
 * Run this as a single separate process (Railway/Fly/a VPS), NOT inside
 * the Next.js serverless app — serverless instances can overlap, and two
 * workers double-submitting is exactly what the vault's actionId
 * idempotency exists to catch, but there's no reason to lean on the last
 * line of defense by design.
 */
import "dotenv/config";
import { connectDB } from "../lib/db/connection";
import { User, RiskProfile, TradeLog } from "../lib/db/models";
import { scanPair } from "../lib/strategy/spreadScanner";
import { executeIfProfitable } from "../lib/strategy/executor";
import { TOKENS, type TokenSymbol } from "../lib/tokens";
import { DEFAULT_RISK_PROFILE } from "../lib/strategy/riskProfile";

const HEARTBEAT_SECONDS = Number(process.env.HEARTBEAT_SECONDS || 60);
const SCAN_AMOUNT_HUMAN = Number(process.env.SCAN_AMOUNT_HUMAN || 10); // notional per-trade size to quote with

let ticking = false;

async function tick() {
  if (ticking) return; // never let a slow tick overlap the next one
  ticking = true;
  const startedAt = Date.now();

  try {
    await connectDB();
    const users = await User.find({ vaultAddress: { $exists: true, $ne: null } });

    for (const user of users) {
      const profile = (await RiskProfile.findOne({ userId: user._id })) ?? DEFAULT_RISK_PROFILE;
      if ((profile as any).paused) continue;

      // Self-enforced daily trade budget (the vault separately enforces
      // token-unit caps on-chain; this one is about count).
      const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
      const tradesToday = await TradeLog.countDocuments({
        userId: user._id,
        status: { $in: ["submitted", "settled"] },
        createdAt: { $gte: since },
      });
      if (tradesToday >= profile.maxTradesPerDay) continue;

      const pairs: { tokenIn: TokenSymbol; tokenOut: TokenSymbol }[] =
        (profile as any).allowedTokenPairs?.length
          ? (profile as any).allowedTokenPairs
          : [
              { tokenIn: "USDm", tokenOut: "KESm" },
              { tokenIn: "USDm", tokenOut: "NGNm" },
              { tokenIn: "USDm", tokenOut: "EURm" },
            ];

      for (const pair of pairs) {
        const decimalsIn = TOKENS[pair.tokenIn].decimals;
        const amountIn = BigInt(Math.floor(SCAN_AMOUNT_HUMAN * 10 ** decimalsIn));

        const scan = await scanPair(pair.tokenIn, pair.tokenOut, amountIn, SCAN_AMOUNT_HUMAN, profile);

        if (scan.decision === "execute") {
          const result = await executeIfProfitable(
            user.vaultAddress as `0x${string}`,
            user._id.toString(),
            scan,
            profile.maxSlippageBps
          );
          console.log(
            `[${user.walletAddress.slice(0, 8)}] ${pair.tokenIn}->${pair.tokenOut}: ${result.status}` +
              (result.txHash ? ` tx=${result.txHash}` : "") +
              ` (${result.reason})`
          );
        } else {
          // Log skips too — this is the honest live-feed material.
          console.log(`[${user.walletAddress.slice(0, 8)}] ${pair.tokenIn}->${pair.tokenOut}: ${scan.decision} (${scan.reason})`);
        }
      }
    }
  } catch (err) {
    console.error("Worker tick failed:", err instanceof Error ? err.message : err);
  } finally {
    ticking = false;
    console.log(`tick complete in ${Date.now() - startedAt}ms — next in ${HEARTBEAT_SECONDS}s`);
  }
}

console.log(`Vomia worker starting. Heartbeat: ${HEARTBEAT_SECONDS}s, scan size: ${SCAN_AMOUNT_HUMAN} units.`);
tick();
setInterval(tick, HEARTBEAT_SECONDS * 1000);
