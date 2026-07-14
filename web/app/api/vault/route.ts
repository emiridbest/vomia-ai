import { NextRequest, NextResponse } from "next/server";
import { createPublicClient, http, isAddress } from "viem";
import { celo } from "viem/chains";
import { rpcUrl } from "../../../lib/chains";
import { connectDB } from "../../../lib/db/connection";
import { User } from "../../../lib/db/models";

const publicClient = createPublicClient({ chain: celo, transport: http(rpcUrl()) });

const FACTORY_ABI = [
  {
    type: "function",
    name: "vaultOf",
    stateMutability: "view",
    inputs: [{ name: "user", type: "address" }],
    outputs: [{ type: "address" }],
  },
] as const;

/**
 * GET /api/vault?web3AuthSub=...&walletAddress=...
 * Looks up the user's vault, checking the factory directly on-chain so this
 * is never out of sync with reality even if the DB record is stale/missing.
 */
export async function GET(req: NextRequest) {
  const walletAddress = req.nextUrl.searchParams.get("walletAddress");
  if (!walletAddress || !isAddress(walletAddress)) {
    return NextResponse.json({ error: "Missing or invalid walletAddress" }, { status: 400 });
  }

  const factoryAddress = process.env.NEXT_PUBLIC_VAULT_FACTORY_ADDRESS;
  if (!factoryAddress || !isAddress(factoryAddress)) {
    return NextResponse.json({ error: "VaultFactory not deployed / NEXT_PUBLIC_VAULT_FACTORY_ADDRESS not set" }, { status: 500 });
  }

  const vaultAddress = await publicClient.readContract({
    address: factoryAddress as `0x${string}`,
    abi: FACTORY_ABI,
    functionName: "vaultOf",
    args: [walletAddress as `0x${string}`],
  });

  const hasVault = vaultAddress !== "0x0000000000000000000000000000000000000000";
  return NextResponse.json({ vaultAddress: hasVault ? vaultAddress : null, factoryAddress });
}

/**
 * POST — call this right after the user's browser wallet confirms their own
 * `factory.createVault(...)` transaction, so we can record it and create
 * their User + default (paused) RiskProfile documents. This never signs or
 * sends any transaction itself.
 */
export async function POST(req: NextRequest) {
  const body = await req.json();
  const { web3AuthSub, walletAddress, vaultAddress } = body ?? {};

  if (!web3AuthSub || !isAddress(walletAddress) || !isAddress(vaultAddress)) {
    return NextResponse.json({ error: "web3AuthSub, walletAddress, and vaultAddress are all required" }, { status: 400 });
  }

  // Trust but verify: confirm this vault really is what the factory has on
  // record for this wallet before writing it down, so a client can't just
  // POST an arbitrary address and have the app treat it as this user's vault.
  const factoryAddress = process.env.NEXT_PUBLIC_VAULT_FACTORY_ADDRESS as `0x${string}`;
  const onChainVault = await publicClient.readContract({
    address: factoryAddress,
    abi: FACTORY_ABI,
    functionName: "vaultOf",
    args: [walletAddress],
  });
  if (onChainVault.toLowerCase() !== vaultAddress.toLowerCase()) {
    return NextResponse.json({ error: "vaultAddress does not match what the factory has on record for this wallet" }, { status: 409 });
  }

  await connectDB();
  const user = await User.findOneAndUpdate(
    { web3AuthSub },
    { web3AuthSub, walletAddress, vaultAddress },
    { upsert: true, new: true }
  );

  return NextResponse.json({ user });
}
