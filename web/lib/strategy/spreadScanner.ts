/**
 * The scan loop. This is the piece that can legitimately run very
 * frequently (every price check can be an x402-priced call — see
 * lib/x402/gate.ts — which is what makes "1000 calls/day" realistic even
 * though 1000 *profitable executions* a day for one user's portfolio is
 * not, per the honest framing in this project's README/chat history: a
 * single portfolio only drifts out of target so often, so most scan ticks
 * should conclude "no trade" rather than force one).
 *
 * A tick never executes anything itself — it returns a decision, and the
 * caller (executor.ts, or the worker loop) decides whether to act on it.
 * Keeping "decide" and "act" separate makes both independently testable
 * and makes it trivial to run this in a dry-run/read-only mode.
 */
import { getMentoQuote } from "../dex/mento";
import { getUniswapQuote } from "../dex/uniswap";
import { TOKENS, type TokenSymbol } from "../tokens";
import { netEdgeBps, type RiskProfile } from "./riskProfile";

export interface VenueQuote {
  venue: "mento" | "uniswap";
  amountOut: bigint;
}

export interface ScanResult {
  tokenIn: TokenSymbol;
  tokenOut: TokenSymbol;
  amountIn: bigint;
  quotes: VenueQuote[];
  bestVenue: VenueQuote | null;
  netEdgeBps: number | null;
  decision: "execute" | "skip-below-margin" | "skip-no-route";
  reason: string;
}

/**
 * Rough gas cost estimate expressed in bps of the trade size, so it can be
 * compared apples-to-apples against minProfitBps. Celo's gas is sub-cent,
 * so for any trade above a few dollars this number should be tiny — but for
 * very small trades (a few cents), gas can dominate, which is exactly the
 * kind of thing minProfitBps exists to catch. This is a simple heuristic,
 * not a live gas oracle; tighten it with a real estimate before trusting it
 * with meaningful size.
 */
function estimateGasBps(amountInUsd: number): number {
  const ESTIMATED_GAS_USD = 0.001; // Celo is consistently sub-cent per tx; pad generously anyway
  if (amountInUsd <= 0) return 10000; // avoid divide-by-zero; treat as "gas eats everything"
  return Math.round((ESTIMATED_GAS_USD / amountInUsd) * 10000);
}

export async function scanPair(
  tokenIn: TokenSymbol,
  tokenOut: TokenSymbol,
  amountIn: bigint,
  amountInUsdEstimate: number,
  riskProfile: RiskProfile
): Promise<ScanResult> {
  const quotes: VenueQuote[] = [];

  const mento = await getMentoQuote(tokenIn, tokenOut, amountIn).catch(() => null);
  if (mento) quotes.push({ venue: "mento", amountOut: mento.amountOut });

  const uniswapOut = await getUniswapQuote(tokenIn, tokenOut, amountIn).catch(() => null);
  if (uniswapOut !== null) quotes.push({ venue: "uniswap", amountOut: uniswapOut });

  if (quotes.length === 0) {
    return {
      tokenIn,
      tokenOut,
      amountIn,
      quotes,
      bestVenue: null,
      netEdgeBps: null,
      decision: "skip-no-route",
      reason: "No venue returned a route for this pair.",
    };
  }

  const bestVenue = quotes.reduce((best, q) => (q.amountOut > best.amountOut ? q : best));

  // "Edge" here is measured against the naive 1:1-of-value expectation
  // encoded in amountInUsdEstimate — a proper implementation should compare
  // against a reference price feed (e.g. Mento's own SortedOracles) rather
  // than assuming amountIn's USD value; wire that in before trusting this
  // with real arbitrage decisions rather than simple rebalancing.
  const outDecimals = TOKENS[tokenOut].decimals;
  const outAsFloat = Number(bestVenue.amountOut) / 10 ** outDecimals;
  const impliedEdgeBps = Math.round(((outAsFloat - amountInUsdEstimate) / amountInUsdEstimate) * 10000);

  const gasBps = estimateGasBps(amountInUsdEstimate);
  const edge = netEdgeBps(impliedEdgeBps, 0, gasBps);

  if (edge < riskProfile.minProfitBps) {
    return {
      tokenIn,
      tokenOut,
      amountIn,
      quotes,
      bestVenue,
      netEdgeBps: edge,
      decision: "skip-below-margin",
      reason: `Net edge ${edge}bps is below the configured minimum of ${riskProfile.minProfitBps}bps.`,
    };
  }

  return {
    tokenIn,
    tokenOut,
    amountIn,
    quotes,
    bestVenue,
    netEdgeBps: edge,
    decision: "execute",
    reason: `Best venue (${bestVenue.venue}) clears the ${riskProfile.minProfitBps}bps margin with ${edge}bps net.`,
  };
}
