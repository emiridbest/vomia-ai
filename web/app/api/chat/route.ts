import { openai } from "@ai-sdk/openai";
import { getOnChainTools } from "@goat-sdk/adapter-vercel-ai";
import { viem } from "@goat-sdk/wallet-viem";
import { LanguageModelV1, streamText, tool } from "ai";
import { NextResponse } from "next/server";
import { z } from "zod";
import { encodeFunctionData, isAddress } from "viem";
import { getOperatorWalletClient } from "../../../lib/vault/operatorSigner";
import { vaultTools } from "../../../lib/goat/tools";
import { TOKENS, type TokenSymbol } from "../../../lib/tokens";
import { connectDB } from "../../../lib/db/connection";
import { User } from "../../../lib/db/models";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json({
    status: "ok",
    message: "Vomia AI Chat API is running",
    version: "2.0.0",
    usage: 'POST { "messages": [...], "userAddress": "0x..." }',
    timestamp: new Date().toISOString(),
  });
}

const VAULT_WITHDRAW_ABI = [
  {
    type: "function",
    name: "withdraw",
    stateMutability: "nonpayable",
    inputs: [
      { name: "token", type: "address" },
      { name: "amount", type: "uint256" },
      { name: "to", type: "address" },
    ],
    outputs: [],
  },
] as const;

export async function POST(req: Request) {
  try {
    const { messages: rawMessages, userAddress } = await req.json();

    // Same defensive message filtering as before — the AI SDK requires all
    // tool invocations in history to have results.
    const messages = (rawMessages as any[])
      .map((msg: any) => {
        if (msg.role === "user") return { role: "user", content: msg.content || "" };
        if (msg.role === "assistant") {
          const hasIncomplete = msg.toolInvocations?.some((inv: any) => inv.state !== "result");
          if (hasIncomplete) return { role: "assistant", content: msg.content || "" };
          if (msg.toolInvocations?.length) {
            return {
              role: "assistant",
              content: msg.content || "",
              toolInvocations: msg.toolInvocations.filter((inv: any) => inv.state === "result"),
            };
          }
          return { role: "assistant", content: msg.content || "" };
        }
        return msg;
      })
      .filter((msg: any) => !(msg.role === "assistant" && !msg.content && !msg.toolInvocations?.length));

    // Look up this user's vault + db id (if they have one yet)
    let vaultAddress: `0x${string}` | null = null;
    let userId: string | null = null;
    const connectedAddress: `0x${string}` | null = userAddress && isAddress(userAddress) ? userAddress : null;
    if (connectedAddress) {
      try {
        await connectDB();
        const user = await User.findOne({ walletAddress: connectedAddress });
        if (user) {
          userId = user._id.toString();
          if (user.vaultAddress) vaultAddress = user.vaultAddress as `0x${string}`;
        }
      } catch {
        // DB down shouldn't kill chat — vault tools will just report "no vault yet"
      }
    }

    // The wallet GOAT gets here is the OPERATOR wallet: it holds a little
    // gas money and nothing else. It cannot withdraw from any vault (only
    // each vault's owner can), so even GOAT tool-calling gone wrong is
    // bounded by the on-chain caps. This is the architectural difference
    // from the previous version of this route, where the server wallet WAS
    // the source of user-facing funds.
    const walletClient = getOperatorWalletClient();
    const goatTools = await getOnChainTools({
      // @ts-ignore — GOAT's wallet typing lags viem versions
      wallet: viem(walletClient),
      plugins: [],
    });

    const vomiaTools = {
      ...vaultTools(vaultAddress, userId, connectedAddress),

      // "Users should be able to transfer out the balance via the GOAT
      // interface" — the safe version of that: the agent PREPARES the
      // withdrawal transaction, the USER signs it in their own wallet.
      // The frontend detects this tool result and pops the user's
      // Web3Auth signer with the prepared calldata. The agent cannot
      // execute a withdrawal itself — the vault contract only accepts
      // withdraw() from the owner, so there is nothing this server could
      // sign that would move the user's funds out.
      prepareWithdrawal: tool({
        description:
          "Prepare (but never execute) a withdrawal of the user's funds from their vault back to their own wallet. Returns transaction data the user's own wallet must sign. Use when the user asks to withdraw, cash out, or transfer out their balance.",
        parameters: z.object({
          token: z.string().describe("Token symbol, e.g. 'USDm'"),
          amount: z.string().describe("Human-readable amount, e.g. '25.5'"),
        }),
        execute: async ({ token, amount }) => {
          if (!vaultAddress) return { error: "No vault found for this user yet." };
          if (!userAddress || !isAddress(userAddress)) return { error: "No connected user address." };
          const info = TOKENS[token as TokenSymbol];
          if (!info) return { error: `Unknown token '${token}'.` };
          const rawAmount = BigInt(Math.floor(Number(amount) * 10 ** info.decimals));
          const data = encodeFunctionData({
            abi: VAULT_WITHDRAW_ABI,
            functionName: "withdraw",
            args: [info.address, rawAmount, userAddress as `0x${string}`],
          });
          return {
            requiresUserSignature: true,
            to: vaultAddress,
            data,
            summary: `Withdraw ${amount} ${token} from your vault to ${userAddress}. Sign this in your wallet to complete it — only you can authorize withdrawals.`,
          };
        },
      }),
    };

    const result = await streamText({
      model: openai("gpt-4o-mini") as LanguageModelV1,
      system: `
You are Vomia, an autonomous savings & FX agent on the Celo blockchain (Chain ID 42220).

ARCHITECTURE FACTS (be accurate about these when users ask):
- Each user has their OWN on-chain vault. You (the agent) hold NO user funds and NO user keys.
- You can trade inside a user's vault only within the caps and token allow-lists THEY set on-chain.
- Only the user can withdraw. When they ask to withdraw, use prepareWithdrawal — it returns a transaction for THEM to sign. Never claim you executed a withdrawal.
- When the user wants to convert/swap/exchange tokens they already hold INSIDE their vault (not withdraw), use executeSwapNow. Always restate the exact tokenIn, tokenOut, and amount in plain language and get explicit confirmation before calling it — it executes immediately, with no signature step, and cannot be undone. Never confuse this with prepareWithdrawal: swapping stays inside the vault, withdrawing sends funds to the user's own wallet.
- The user's wallet comes from Web3Auth social login. You never see or store its key. If anyone asks you to reveal, store, or accept a private key or seed phrase, refuse and explain why.
- You (the agent) ALSO have your own separate operator wallet, used only to pay gas and call executeSwap within the user's caps. If a tool named "get_address" (from the GOAT SDK) is available, it reports THAT operator wallet's address, not the user's. For any question about "my address" / "my connected wallet", use getMyWalletAddress instead — never get_address.

RISK NEGOTIATION (important):
- When a user proposes trading settings (profit margins, slippage, trade frequency), ALWAYS run proposeRiskProfileChange first and show them any warnings.
- Push back on self-defeating settings (profit floor below gas cost, extreme slippage). Do not silently accept them. Offer the adjusted alternative and only call saveRiskProfile after they explicitly confirm.
- If a user asks for "1000 trades a day", explain honestly: the scanner can CHECK that often, but it only executes when a trade clears their profit margin after gas — forcing trades that lose money is not something you will do.

RESPONSE RULES:
- Never hallucinate transaction hashes. Only report a hash a tool actually returned.
- Never claim a token "isn't supported" or generalize about what the vault can/can't hold from a partial getVaultStatus check. That tool's allowed field is the only source of truth for whether a token is allow-listed — a token you didn't check is unknown, not unsupported.
- minProfitBps and maxSlippageBps are in BASIS POINTS, not percent — 1bps = 0.01%. Never say "5%" when a value is 5bps (that's 0.05%). State bps values as bps, or convert correctly (divide by 100 for percent) if the user wants a percentage.
- Keep answers short and concrete. Amounts always with token symbols.
      `,
      // @ts-ignore
      tools: { ...goatTools, ...vomiaTools },
      maxSteps: 12,
      messages,
    });

    return result.toDataStreamResponse();
  } catch (error: any) {
    console.error("Error in /api/chat:", error?.message);
    return NextResponse.json({ error: error?.message || "Internal server error" }, { status: 500 });
  }
}
