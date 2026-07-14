/**
 * Vault-aware chat tools, in Vercel AI SDK's `tool()` shape — the same
 * shape GOAT's `getOnChainTools()` already produces (see the existing
 * app/api/chat/route.ts), so these just spread into the same `tools`
 * object passed to `streamText`. Kept separate from GOAT's own tools
 * because these are Vomia-specific (vault balance, risk profile
 * negotiation) rather than generic on-chain actions.
 *
 * Note what's deliberately NOT a tool here: there is no "sign a transaction
 * for the user" tool and no "reveal a private key" tool. The chat agent can
 * read vault state and read/propose risk-profile changes; it cannot move
 * funds itself — that only ever happens through the scanner+executor loop
 * (lib/strategy/), gated by the on-chain caps in AgentVault.sol.
 */
import { tool } from "ai";
import { z } from "zod";
import { createPublicClient, http, type Address } from "viem";
import { celo } from "viem/chains";
import { rpcUrl } from "../chains";
import { TOKENS, type TokenSymbol } from "../tokens";
import { reviewProposedProfile, DEFAULT_RISK_PROFILE } from "../strategy/riskProfile";
import { connectDB } from "../db/connection";
import { RiskProfile as RiskProfileModel, User } from "../db/models";

const VAULT_READ_ABI = [
  { type: "function", name: "owner", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "operator", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "paused", stateMutability: "view", inputs: [], outputs: [{ type: "bool" }] },
  {
    type: "function",
    name: "tokenBalance",
    stateMutability: "view",
    inputs: [{ name: "token", type: "address" }],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "remainingDailyAllowance",
    stateMutability: "view",
    inputs: [{ name: "token", type: "address" }],
    outputs: [{ type: "uint256" }],
  },
] as const;

const publicClient = createPublicClient({ chain: celo, transport: http(rpcUrl()) });

export function vaultTools(vaultAddress: Address | null, userId: string | null) {
  return {
    getVaultStatus: tool({
      description:
        "Read the user's own vault: whether it's paused, which tokens have a balance, and remaining daily trading allowance per token. Use this before answering any question about balances or agent status.",
      parameters: z.object({
        tokens: z.array(z.string()).describe("Token symbols to check, e.g. ['USDm', 'KESm']"),
      }),
      execute: async ({ tokens }) => {
        if (!vaultAddress) return { error: "This user hasn't created a vault yet — direct them to the dashboard to create one first." };
        const [paused] = await Promise.all([publicClient.readContract({ address: vaultAddress, abi: VAULT_READ_ABI, functionName: "paused" })]);
        const balances = await Promise.all(
          tokens.map(async (symbol) => {
            const info = TOKENS[symbol as TokenSymbol];
            if (!info) return { symbol, error: "unknown token" };
            const [balance, remaining] = await Promise.all([
              publicClient.readContract({ address: vaultAddress, abi: VAULT_READ_ABI, functionName: "tokenBalance", args: [info.address] }),
              publicClient.readContract({ address: vaultAddress, abi: VAULT_READ_ABI, functionName: "remainingDailyAllowance", args: [info.address] }),
            ]);
            return {
              symbol,
              balance: (Number(balance) / 10 ** info.decimals).toString(),
              remainingDailyAllowance: (Number(remaining) / 10 ** info.decimals).toString(),
            };
          })
        );
        return { vaultAddress, paused, balances };
      },
    }),

    getRiskProfile: tool({
      description: "Read the user's current risk profile / trading rule settings.",
      parameters: z.object({}),
      execute: async () => {
        if (!userId) return DEFAULT_RISK_PROFILE;
        await connectDB();
        const profile = await RiskProfileModel.findOne({ userId });
        return profile ?? DEFAULT_RISK_PROFILE;
      },
    }),

    proposeRiskProfileChange: tool({
      description:
        "Propose a change to the user's risk profile (e.g. after they say something like 'save 10% every Friday' or 'be more aggressive'). This does NOT save the change — it reviews the numbers first and returns warnings if the user is asking for something self-defeating (e.g. a profit floor below gas cost, or slippage above what the vault contract allows), the same way a careful human operator would push back before applying a risky setting. Present the review to the user and only call saveRiskProfile after they confirm.",
      parameters: z.object({
        minProfitBps: z.number().optional(),
        maxSlippageBps: z.number().optional(),
        maxTradesPerDay: z.number().optional(),
      }),
      execute: async (proposed) => {
        const ESTIMATED_GAS_BPS_FOR_TYPICAL_TRADE = 2; // see spreadScanner.ts's estimateGasBps for the live version
        return reviewProposedProfile(proposed, ESTIMATED_GAS_BPS_FOR_TYPICAL_TRADE);
      },
    }),

    saveRiskProfile: tool({
      description: "Persist a risk profile the user has confirmed (after reviewing proposeRiskProfileChange's output with them).",
      parameters: z.object({
        minProfitBps: z.number(),
        maxSlippageBps: z.number(),
        maxTradesPerDay: z.number(),
        enabledStrategies: z.array(z.enum(["rebalance", "arbitrage", "remittance", "dca"])),
      }),
      execute: async (profile) => {
        if (!userId) return { error: "No user context — this should be called from an authenticated session." };
        await connectDB();
        await RiskProfileModel.findOneAndUpdate({ userId }, profile, { upsert: true });
        return { saved: true, profile };
      },
    }),
  };
}
