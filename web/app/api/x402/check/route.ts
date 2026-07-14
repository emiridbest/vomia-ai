import { NextRequest, NextResponse } from "next/server";
import { withX402 } from "../../../../lib/x402/gate";
import { scanPair } from "../../../../lib/strategy/spreadScanner";
import { DEFAULT_RISK_PROFILE } from "../../../../lib/strategy/riskProfile";
import type { TokenSymbol } from "../../../../lib/tokens";

/**
 * GET /api/x402/check?tokenIn=USDm&tokenOut=KESm&amountIn=10
 *
 * Priced per call ($0.005 by default — see .env.example) regardless of
 * whether the answer turns out to be "trade" or "no trade". This is what
 * makes a paid-per-check rebalancing/monitoring service viable for the
 * "most x402 payments" track even when actual trade *executions* stay
 * low: a user (or another agent) polling "should I rebalance?" every few
 * minutes generates real, priced calls whether or not the answer is yes.
 */
async function handler(req: NextRequest): Promise<NextResponse> {
  const tokenIn = req.nextUrl.searchParams.get("tokenIn") as TokenSymbol | null;
  const tokenOut = req.nextUrl.searchParams.get("tokenOut") as TokenSymbol | null;
  const amountInRaw = req.nextUrl.searchParams.get("amountIn");

  if (!tokenIn || !tokenOut || !amountInRaw) {
    return NextResponse.json({ error: "tokenIn, tokenOut, and amountIn (human units) are required" }, { status: 400 });
  }

  const amountIn = BigInt(Math.floor(Number(amountInRaw) * 1e18));
  const scan = await scanPair(tokenIn, tokenOut, amountIn, Number(amountInRaw), DEFAULT_RISK_PROFILE);

  return NextResponse.json({
    tokenIn,
    tokenOut,
    amountIn: amountInRaw,
    decision: scan.decision,
    netEdgeBps: scan.netEdgeBps,
    bestVenue: scan.bestVenue?.venue ?? null,
    reason: scan.reason,
  });
}

export const GET = withX402({ price: "$0.005", description: "Vomia rebalance check — priced above the facilitator's ~$0.001/settlement credit" }, handler);
