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
import { DEFAULT_STRATEGY_TOKENS, TOKENS, type TokenSymbol } from "../tokens";
import { reviewProposedProfile, DEFAULT_RISK_PROFILE } from "../strategy/riskProfile";
import { executeDca } from "../strategy/executor";
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
  {
    type: "function",
    name: "allowedTokens",
    stateMutability: "view",
    inputs: [{ name: "", type: "address" }],
    outputs: [{ type: "bool" }],
  },
] as const;

const publicClient = createPublicClient({ chain: celo, transport: http(rpcUrl()) });

export function vaultTools(vaultAddress: Address | null, userId: string | null, userAddress: Address | null) {
  return {
    getMyWalletAddress: tool({
      description:
        "Get the USER's own connected wallet address (from their Web3Auth login). Use this for any question about 'my address' or 'my connected wallet' — do NOT use GOAT's generic get_address tool for this, which reports the agent's own operator wallet, not the user's.",
      parameters: z.object({}),
      execute: async () => {
        if (!userAddress) return { error: "No wallet connected yet." };
        return { address: userAddress };
      },
    }),

    getVaultStatus: tool({
      description:
        "Read the user's own vault: whether it's paused, and for each token — whether it's allow-listed for trading, its balance, and remaining daily trading allowance. Use this before answering ANY question about balances or agent status. Omit 'tokens' to check the full default token set (USDm, KESm, NGNm, EURm, USDC, USDT, CELO) — always do this unless the user named specific tokens, since checking only a couple and reporting 'the vault only supports X' would be wrong: allowed=false just means that token isn't allow-listed yet, not that it can't be.",
      parameters: z.object({
        tokens: z.array(z.string()).optional().describe("Token symbols to check. Omit to check the full default set."),
      }),
      execute: async ({ tokens }) => {
        if (!vaultAddress) return { error: "This user hasn't created a vault yet — direct them to the dashboard to create one first." };
        const symbols = tokens && tokens.length > 0 ? tokens : DEFAULT_STRATEGY_TOKENS;
        const [paused] = await Promise.all([publicClient.readContract({ address: vaultAddress, abi: VAULT_READ_ABI, functionName: "paused" })]);
        const balances = await Promise.all(
          symbols.map(async (symbol) => {
            const info = TOKENS[symbol as TokenSymbol];
            if (!info) return { symbol, error: "unknown token" };
            const [allowed, balance, remaining] = await Promise.all([
              publicClient.readContract({ address: vaultAddress, abi: VAULT_READ_ABI, functionName: "allowedTokens", args: [info.address] }),
              publicClient.readContract({ address: vaultAddress, abi: VAULT_READ_ABI, functionName: "tokenBalance", args: [info.address] }),
              publicClient.readContract({ address: vaultAddress, abi: VAULT_READ_ABI, functionName: "remainingDailyAllowance", args: [info.address] }),
            ]);
            return {
              symbol,
              allowed,
              balance: (Number(balance) / 10 ** info.decimals).toString(),
              remainingDailyAllowance: (Number(remaining) / 10 ** info.decimals).toString(),
            };
          })
        );
        return { vaultAddress, paused, balances };
      },
    }),

    executeSwapNow: tool({
      description:
        "Execute an immediate swap INSIDE the user's vault, converting one allow-listed token to another, right now. This does NOT check whether the trade is 'profitable' — the autonomous rebalance strategy does that on its own schedule; this tool exists for when the user explicitly asks to convert/swap/exchange tokens they already hold in their vault. It still gets a real quote and applies the user's own slippage tolerance. Do NOT use this for withdrawals (money leaving the vault to the user's own wallet) — use prepareWithdrawal for that instead. ALWAYS state the exact tokenIn, tokenOut, and amount back to the user and get explicit confirmation before calling this — it executes immediately with no separate signature step and cannot be undone.",
      parameters: z.object({
        tokenIn: z.string().describe("Token symbol to swap FROM, e.g. 'KESm'"),
        tokenOut: z.string().describe("Token symbol to swap TO, e.g. 'USDm'"),
        amount: z.string().describe("Human-readable amount of tokenIn to swap, e.g. '3840.87'"),
      }),
      execute: async ({ tokenIn, tokenOut, amount }) => {
        if (!vaultAddress) return { error: "This user hasn't created a vault yet." };
        if (!userId) return { error: "No user context — this should be called from an authenticated session." };
        const inInfo = TOKENS[tokenIn as TokenSymbol];
        const outInfo = TOKENS[tokenOut as TokenSymbol];
        if (!inInfo) return { error: `Unknown token '${tokenIn}'.` };
        if (!outInfo) return { error: `Unknown token '${tokenOut}'.` };
        const parsedAmount = Number(amount);
        if (!Number.isFinite(parsedAmount) || parsedAmount <= 0) return { error: "Invalid amount." };
        const amountIn = BigInt(Math.floor(parsedAmount * 10 ** inInfo.decimals));

        await connectDB();
        const profile = await RiskProfileModel.findOne({ userId });
        const maxSlippageBps = profile?.maxSlippageBps ?? DEFAULT_RISK_PROFILE.maxSlippageBps;

        return executeDca(vaultAddress, userId, tokenIn as TokenSymbol, tokenOut as TokenSymbol, amountIn, maxSlippageBps, "rebalance");
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
