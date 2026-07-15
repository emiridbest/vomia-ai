/**
 * Takes a scanner decision and, if it says "execute", actually calls
 * AgentVault.executeSwap using the operator key. This is the only file in
 * the whole strategy layer that signs and sends a transaction — keeping it
 * isolated makes it the one place to audit for "does this respect the
 * vault's own on-chain limits" (short answer: it doesn't have to try very
 * hard, because the contract enforces its caps regardless of what this
 * code sends — see AgentVault.sol. This file's job is picking a *good*
 * trade; the contract's job is refusing a *dangerous* one, even if this
 * code has a bug.)
 *
 * Two entry points, two different gates:
 *   - executeIfProfitable (rebalance): only executes if the scanner found an
 *     edge above the user's minProfitBps.
 *   - executeDca: never gated on profit — DCA buys on a fixed schedule by
 *     definition, regardless of price. It still requires a real venue quote
 *     (for slippage protection) and still won't execute with no route.
 */
import { v4 as uuidv4 } from "uuid";
import { keccak256, toBytes, type Address } from "viem";
import { getOperatorWalletClient } from "../vault/operatorSigner";
import {
  buildMentoSwapCalldata,
  getMentoQuote,
  MENTO_BROKER_ADDRESS,
  findExchangeId,
  MENTO_BIPOOL_MANAGER,
} from "../dex/mento";
import { buildUniswapSwapCalldata, getUniswapQuote, UNISWAP_SWAP_ROUTER_02 } from "../dex/uniswap";
import { TOKENS, type TokenSymbol } from "../tokens";
import type { ScanResult } from "./spreadScanner";
import { TradeLog } from "../db/models";
import { attachAttributionTag } from "../attribution";

const AGENT_VAULT_EXECUTE_ABI = [
  {
    type: "function",
    name: "executeSwap",
    stateMutability: "nonpayable",
    inputs: [
      { name: "actionId", type: "bytes32" },
      { name: "tokenIn", type: "address" },
      { name: "tokenOut", type: "address" },
      { name: "amountIn", type: "uint256" },
      { name: "minAmountOut", type: "uint256" },
      { name: "target", type: "address" },
      { name: "callData", type: "bytes" },
    ],
    outputs: [{ name: "amountOut", type: "uint256" }],
  },
] as const;

export interface ExecutionResult {
  status: "settled" | "reverted" | "skipped-below-margin" | "skipped-no-route";
  txHash?: `0x${string}`;
  actionId: string;
  reason: string;
}

interface Venue {
  venue: "mento" | "uniswap";
  amountOut: bigint;
}

/** Sends the tagged executeSwap call and logs the result — shared by every strategy's execution path. */
async function sendTaggedSwap(params: {
  vaultAddress: Address;
  userId: string;
  strategy: "rebalance" | "dca";
  tokenIn: TokenSymbol;
  tokenOut: TokenSymbol;
  amountIn: bigint;
  minAmountOut: bigint;
  target: Address;
  callData: `0x${string}`;
  quotedProfitBps?: number;
  amountOut: bigint;
  reasonOnSuccess: string;
}): Promise<ExecutionResult> {
  const actionId = keccak256(toBytes(uuidv4()));
  const taggedCallData = attachAttributionTag(params.callData);
  const walletClient = getOperatorWalletClient();

  try {
    const txHash = await walletClient.writeContract({
      address: params.vaultAddress,
      abi: AGENT_VAULT_EXECUTE_ABI,
      functionName: "executeSwap",
      args: [
        actionId,
        TOKENS[params.tokenIn].address,
        TOKENS[params.tokenOut].address,
        params.amountIn,
        params.minAmountOut,
        params.target,
        taggedCallData,
      ],
      chain: walletClient.chain,
      account: walletClient.account!,
    });

    await TradeLog.create({
      userId: params.userId,
      vaultAddress: params.vaultAddress,
      actionId,
      strategy: params.strategy,
      tokenIn: params.tokenIn,
      tokenOut: params.tokenOut,
      amountIn: params.amountIn.toString(),
      amountOut: params.amountOut.toString(),
      status: "submitted",
      txHash,
      quotedProfitBps: params.quotedProfitBps,
    });

    return { status: "settled", txHash, actionId, reason: params.reasonOnSuccess };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await TradeLog.create({
      userId: params.userId,
      vaultAddress: params.vaultAddress,
      actionId,
      strategy: params.strategy,
      tokenIn: params.tokenIn,
      tokenOut: params.tokenOut,
      amountIn: params.amountIn.toString(),
      status: "reverted",
      quotedProfitBps: params.quotedProfitBps,
    });
    return { status: "reverted", actionId, reason: `Execution reverted: ${message}` };
  }
}

export async function executeIfProfitable(
  vaultAddress: Address,
  userId: string,
  scan: ScanResult,
  maxSlippageBps: number
): Promise<ExecutionResult> {
  if (scan.decision !== "execute" || !scan.bestVenue) {
    const actionId = keccak256(toBytes(uuidv4()));
    await TradeLog.create({
      userId,
      vaultAddress,
      actionId,
      strategy: "rebalance",
      tokenIn: scan.tokenIn,
      tokenOut: scan.tokenOut,
      amountIn: scan.amountIn.toString(),
      status: scan.decision === "skip-no-route" ? "reverted" : "skipped-below-margin",
      quotedProfitBps: scan.netEdgeBps ?? undefined,
    });
    return { status: scan.decision === "skip-no-route" ? "skipped-no-route" : "skipped-below-margin", actionId, reason: scan.reason };
  }

  const minAmountOut = (scan.bestVenue.amountOut * BigInt(10000 - maxSlippageBps)) / 10000n;

  let target: Address;
  let callData: `0x${string}`;

  if (scan.bestVenue.venue === "mento") {
    const exchangeId = await findExchangeId(TOKENS[scan.tokenIn].address, TOKENS[scan.tokenOut].address);
    if (!exchangeId) {
      return { status: "skipped-no-route", actionId: keccak256(toBytes(uuidv4())), reason: "Mento exchangeId disappeared between quote and execute — skipping this tick." };
    }
    target = MENTO_BROKER_ADDRESS;
    callData = buildMentoSwapCalldata({
      exchangeProvider: MENTO_BIPOOL_MANAGER,
      exchangeId,
      tokenIn: TOKENS[scan.tokenIn].address,
      tokenOut: TOKENS[scan.tokenOut].address,
      amountIn: scan.amountIn,
      amountOutMin: minAmountOut,
    });
  } else {
    target = UNISWAP_SWAP_ROUTER_02;
    callData = buildUniswapSwapCalldata({
      tokenIn: TOKENS[scan.tokenIn].address,
      tokenOut: TOKENS[scan.tokenOut].address,
      fee: 3000,
      recipient: vaultAddress, // swapped tokens must come back to the vault, not the operator
      amountIn: scan.amountIn,
      amountOutMin: minAmountOut,
    });
  }

  return sendTaggedSwap({
    vaultAddress,
    userId,
    strategy: "rebalance",
    tokenIn: scan.tokenIn,
    tokenOut: scan.tokenOut,
    amountIn: scan.amountIn,
    minAmountOut,
    target,
    callData,
    quotedProfitBps: scan.netEdgeBps ?? undefined,
    amountOut: scan.bestVenue.amountOut,
    reasonOnSuccess: scan.reason,
  });
}

/**
 * DCA: buy tokenOut with a fixed amountIn of tokenIn, unconditionally — no
 * profit check, that's the point of dollar-cost-averaging. Still requires a
 * real quote from at least one venue (for slippage protection) and still
 * won't execute if nothing has a route (e.g. no Uniswap pool for this pair).
 */
export async function executeDca(
  vaultAddress: Address,
  userId: string,
  tokenIn: TokenSymbol,
  tokenOut: TokenSymbol,
  amountIn: bigint,
  maxSlippageBps: number
): Promise<ExecutionResult> {
  const [mento, uniswapOut] = await Promise.all([
    getMentoQuote(tokenIn, tokenOut, amountIn).catch(() => null),
    getUniswapQuote(tokenIn, tokenOut, amountIn).catch(() => null),
  ]);

  const quotes: Venue[] = [];
  if (mento) quotes.push({ venue: "mento", amountOut: mento.amountOut });
  if (uniswapOut !== null) quotes.push({ venue: "uniswap", amountOut: uniswapOut });

  if (quotes.length === 0) {
    const actionId = keccak256(toBytes(uuidv4()));
    await TradeLog.create({
      userId,
      vaultAddress,
      actionId,
      strategy: "dca",
      tokenIn,
      tokenOut,
      amountIn: amountIn.toString(),
      status: "reverted",
    });
    return { status: "skipped-no-route", actionId, reason: `No venue has a route for ${tokenIn}->${tokenOut} right now.` };
  }

  const bestVenue = quotes.reduce((best, q) => (q.amountOut > best.amountOut ? q : best));
  const minAmountOut = (bestVenue.amountOut * BigInt(10000 - maxSlippageBps)) / 10000n;

  let target: Address;
  let callData: `0x${string}`;

  if (bestVenue.venue === "mento") {
    const exchangeId = await findExchangeId(TOKENS[tokenIn].address, TOKENS[tokenOut].address);
    if (!exchangeId) {
      return {
        status: "skipped-no-route",
        actionId: keccak256(toBytes(uuidv4())),
        reason: "Mento exchangeId disappeared between quote and execute — skipping this tick.",
      };
    }
    target = MENTO_BROKER_ADDRESS;
    callData = buildMentoSwapCalldata({
      exchangeProvider: MENTO_BIPOOL_MANAGER,
      exchangeId,
      tokenIn: TOKENS[tokenIn].address,
      tokenOut: TOKENS[tokenOut].address,
      amountIn,
      amountOutMin: minAmountOut,
    });
  } else {
    target = UNISWAP_SWAP_ROUTER_02;
    callData = buildUniswapSwapCalldata({
      tokenIn: TOKENS[tokenIn].address,
      tokenOut: TOKENS[tokenOut].address,
      fee: 3000,
      recipient: vaultAddress,
      amountIn,
      amountOutMin: minAmountOut,
    });
  }

  return sendTaggedSwap({
    vaultAddress,
    userId,
    strategy: "dca",
    tokenIn,
    tokenOut,
    amountIn,
    minAmountOut,
    target,
    callData,
    amountOut: bestVenue.amountOut,
    reasonOnSuccess: `DCA buy: ${tokenIn} -> ${tokenOut} via ${bestVenue.venue}`,
  });
}
