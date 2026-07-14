import { NextRequest, NextResponse } from "next/server";
import { isAddress } from "viem";
import { connectDB } from "../../../lib/db/connection";
import { RiskProfile, User } from "../../../lib/db/models";
import { reviewProposedProfile, DEFAULT_RISK_PROFILE } from "../../../lib/strategy/riskProfile";

export async function GET(req: NextRequest) {
  const walletAddress = req.nextUrl.searchParams.get("walletAddress");
  if (!walletAddress || !isAddress(walletAddress)) {
    return NextResponse.json({ error: "Missing or invalid walletAddress" }, { status: 400 });
  }

  await connectDB();
  const user = await User.findOne({ walletAddress });
  if (!user) return NextResponse.json({ profile: DEFAULT_RISK_PROFILE, isDefault: true });

  const profile = await RiskProfile.findOne({ userId: user._id });
  return NextResponse.json({ profile: profile ?? DEFAULT_RISK_PROFILE, isDefault: !profile });
}

export async function PUT(req: NextRequest) {
  const body = await req.json();
  const { walletAddress, profile, estimatedGasBps } = body ?? {};
  if (!walletAddress || !isAddress(walletAddress) || !profile) {
    return NextResponse.json({ error: "walletAddress and profile are required" }, { status: 400 });
  }

  const review = reviewProposedProfile(profile, estimatedGasBps ?? 2);
  if (!review.accepted && !body.acknowledgeWarnings) {
    // First pass: return warnings for the UI/chat to show the user, without saving yet.
    return NextResponse.json({ saved: false, review }, { status: 200 });
  }

  await connectDB();
  const user = await User.findOne({ walletAddress });
  if (!user) return NextResponse.json({ error: "User not found — create a vault first" }, { status: 404 });

  const finalProfile = { ...profile, ...(review.adjusted ?? {}) };
  const saved = await RiskProfile.findOneAndUpdate({ userId: user._id }, finalProfile, { upsert: true, new: true });

  return NextResponse.json({ saved: true, profile: saved, review });
}
