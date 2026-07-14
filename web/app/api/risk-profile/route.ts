import { NextRequest, NextResponse } from "next/server";
import { connectDB } from "../../../lib/db/connection";
import { RiskProfile, User } from "../../../lib/db/models";
import { reviewProposedProfile, DEFAULT_RISK_PROFILE } from "../../../lib/strategy/riskProfile";

export async function GET(req: NextRequest) {
  const web3AuthSub = req.nextUrl.searchParams.get("web3AuthSub");
  if (!web3AuthSub) return NextResponse.json({ error: "Missing web3AuthSub" }, { status: 400 });

  await connectDB();
  const user = await User.findOne({ web3AuthSub });
  if (!user) return NextResponse.json({ profile: DEFAULT_RISK_PROFILE, isDefault: true });

  const profile = await RiskProfile.findOne({ userId: user._id });
  return NextResponse.json({ profile: profile ?? DEFAULT_RISK_PROFILE, isDefault: !profile });
}

export async function PUT(req: NextRequest) {
  const body = await req.json();
  const { web3AuthSub, profile, estimatedGasBps } = body ?? {};
  if (!web3AuthSub || !profile) return NextResponse.json({ error: "web3AuthSub and profile are required" }, { status: 400 });

  const review = reviewProposedProfile(profile, estimatedGasBps ?? 2);
  if (!review.accepted && !body.acknowledgeWarnings) {
    // First pass: return warnings for the UI/chat to show the user, without saving yet.
    return NextResponse.json({ saved: false, review }, { status: 200 });
  }

  await connectDB();
  const user = await User.findOne({ web3AuthSub });
  if (!user) return NextResponse.json({ error: "User not found — create a vault first" }, { status: 404 });

  const finalProfile = { ...profile, ...(review.adjusted ?? {}) };
  const saved = await RiskProfile.findOneAndUpdate({ userId: user._id }, finalProfile, { upsert: true, new: true });

  return NextResponse.json({ saved: true, profile: saved, review });
}
