import { NextRequest, NextResponse } from "next/server";
import { connectDB } from "../../../lib/db/connection";
import { TradeLog } from "../../../lib/db/models";

/**
 * GET /api/trades?limit=50[&vault=0x...]
 * Recent agent actions for the live feed. Public by design — every row
 * here corresponds to (or explains the absence of) an on-chain event, so
 * there is nothing secret in it, and a public, provable feed is the
 * trust story: anyone can cross-check a row's txHash on Celoscan.
 */
export async function GET(req: NextRequest) {
  const limit = Math.min(Number(req.nextUrl.searchParams.get("limit") || 50), 200);
  const vault = req.nextUrl.searchParams.get("vault");

  try {
    await connectDB();
    const query = vault ? { vaultAddress: vault } : {};
    const trades = await TradeLog.find(query).sort({ createdAt: -1 }).limit(limit).lean();
    return NextResponse.json({
      trades: trades.map((t: any) => ({
        time: t.createdAt,
        strategy: t.strategy,
        pair: `${t.tokenIn} → ${t.tokenOut}`,
        amountIn: t.amountIn,
        status: t.status,
        txHash: t.txHash ?? null,
        netEdgeBps: t.quotedProfitBps ?? null,
      })),
    });
  } catch {
    return NextResponse.json({ trades: [], note: "Database not reachable — feed unavailable." });
  }
}
