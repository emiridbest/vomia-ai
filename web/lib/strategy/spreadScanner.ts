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
import { getReferenceAmountOut } from "../dex/oracle";
import { type TokenSymbol } from "../tokens";
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

  // Edge is measured against Mento's own SortedOracles reference rate — an
  // independent price, not the naive "amountIn is worth $1 per unit"
  // assumption this used to make (which silently broke for every pair
  // where tokenOut isn't ~1 USD: KESm/NGNm looked absurdly "profitable",
  // EURm looked like a loss, regardless of actual market conditions). If no
  // reference rate is available for this pair (not a Mento stable on either
  // side), we can't verify profitability at all, so we don't guess — skip.
  const referenceAmountOut = await getReferenceAmountOut(tokenIn, tokenOut, amountIn);
  if (referenceAmountOut === null || referenceAmountOut === 0n) {
    return {
      tokenIn,
      tokenOut,
      amountIn,
      quotes,
      bestVenue,
      netEdgeBps: null,
      decision: "skip-no-route",
      reason: "No independent reference rate available for this pair — can't verify profitability, so not executing blind.",
    };
  }

  // Sanity guard: not every Mento stable's rateFeedID is simply its own
  // token address (Chainlink-relayed feeds use a different identifier
  // scheme per Mento's docs, unverified here) — if the wrong feed gets
  // queried, medianRate can still return a *number*, just a meaningless
  // one, off by orders of magnitude from anything real. A genuine DEX-vs-
  // oracle discrepancy on a liquid stable pair should be small; if the
  // reference disagrees with the DEX's own quote by more than 10x in
  // either direction, that's a sign the reference itself is unreliable,
  // not a real 1000%+ edge. Refuse to trade on it rather than risk acting
  // on a wrong-by-orders-of-magnitude number.
  const ratio = Number(bestVenue.amountOut) / Number(referenceAmountOut);
  if (ratio > 10 || ratio < 0.1) {
    return {
      tokenIn,
      tokenOut,
      amountIn,
      quotes,
      bestVenue,
      netEdgeBps: null,
      decision: "skip-no-route",
      reason: `Oracle reference for ${tokenIn}->${tokenOut} disagrees with the DEX quote by an implausible margin (ratio ${ratio.toFixed(2)}) — likely the wrong rate feed ID for this token, not a real edge. Refusing to trade on it.`,
    };
  }

  // Pure BigInt through the comparison so this never risks precision loss
  // converting large raw token amounts to a JS Number.
  const impliedEdgeBps = Number(((bestVenue.amountOut - referenceAmountOut) * 10000n) / referenceAmountOut);

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
      reason: `Net edge ${edge}bps (vs. oracle reference rate) is below the configured minimum of ${riskProfile.minProfitBps}bps.`,
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
    reason: `Best venue (${bestVenue.venue}) clears the ${riskProfile.minProfitBps}bps margin with ${edge}bps net (vs. oracle reference rate).`,
  };
}
