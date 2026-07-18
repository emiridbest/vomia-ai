import { NextRequest, NextResponse } from "next/server";
import { isAddress } from "viem";
import { connectDB } from "../../../lib/db/connection";
import { FeeAccrual, User, FEE_PER_CHECK_USDC, FEE_PER_TRADE_USDC } from "../../../lib/db/models";

/**
 * GET /api/fees?walletAddress=... — the user's metered service fees.
 * Read-only transparency for the dashboard's trial banner: what the agent's
 * work would have cost at the published per-check/per-trade rates. Nothing
 * here moves money; settlement (post-trial) happens via x402.
 */
export async function GET(req: NextRequest) {
  const walletAddress = req.nextUrl.searchParams.get("walletAddress");
  if (!walletAddress || !isAddress(walletAddress)) {
    return NextResponse.json({ error: "Missing or invalid walletAddress" }, { status: 400 });
  }
  await connectDB();
  const user = await User.findOne({ walletAddress });
  if (!user) return NextResponse.json({ checks: 0, trades: 0, usdcOwed: 0, feePerCheck: FEE_PER_CHECK_USDC, feePerTrade: FEE_PER_TRADE_USDC });

  const rows = await FeeAccrual.find({ userId: user._id }).lean();
  const totals = rows.reduce(
    (a, r) => ({ checks: a.checks + r.checks, trades: a.trades + r.trades, usdcOwed: a.usdcOwed + r.usdcOwed }),
    { checks: 0, trades: 0, usdcOwed: 0 }
  );
  return NextResponse.json({ ...totals, feePerCheck: FEE_PER_CHECK_USDC, feePerTrade: FEE_PER_TRADE_USDC });
}
