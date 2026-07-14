import { NextRequest, NextResponse } from "next/server";
import { withX402 } from "../../../../lib/x402/gate";
import { getMentoQuote } from "../../../../lib/dex/mento";
import { getUniswapQuote } from "../../../../lib/dex/uniswap";
import { TOKENS, type TokenSymbol } from "../../../../lib/tokens";

/**
 * GET /api/x402/fx-route?from=USDm&to=KESm&amount=100
 *
 * Public, paid, agent-consumable FX quoting endpoint — this is literally
 * the "other agents pay you per call" product the Revenue and x402-payments
 * tracks are built to reward, and it needs nothing from the caller except a
 * signed x402 payment. Any agent (including other hackathon teams' bots)
 * can call this directly; no account, no API key.
 */
async function handler(req: NextRequest): Promise<NextResponse> {
  const from = req.nextUrl.searchParams.get("from") as TokenSymbol | null;
  const to = req.nextUrl.searchParams.get("to") as TokenSymbol | null;
  const amountRaw = req.nextUrl.searchParams.get("amount");

  if (!from || !to || !amountRaw || !TOKENS[from] || !TOKENS[to]) {
    return NextResponse.json({ error: "from, to (token symbols) and amount (human units) are required" }, { status: 400 });
  }

  const amountIn = BigInt(Math.floor(Number(amountRaw) * 10 ** TOKENS[from].decimals));

  const [mento, uniswapOut] = await Promise.all([
    getMentoQuote(from, to, amountIn).catch(() => null),
    getUniswapQuote(from, to, amountIn).catch(() => null),
  ]);

  const routes = [
    mento ? { venue: "mento", amountOut: formatAmount(mento.amountOut, TOKENS[to].decimals) } : null,
    uniswapOut !== null ? { venue: "uniswap", amountOut: formatAmount(uniswapOut, TOKENS[to].decimals) } : null,
  ].filter(Boolean);

  if (routes.length === 0) {
    return NextResponse.json({ error: `No route found from ${from} to ${to}` }, { status: 404 });
  }

  return NextResponse.json({ from, to, amountIn: amountRaw, routes, settledVia: "x402 on Celo" });
}

function formatAmount(raw: bigint, decimals: number): string {
  return (Number(raw) / 10 ** decimals).toString();
}

export const GET = withX402({ price: "$0.01", description: "Vomia FX route quote across Mento + Uniswap on Celo" }, handler);
