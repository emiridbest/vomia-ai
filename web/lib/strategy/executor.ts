/**
 * Calls AgentVault.executeSwap with the operator key — the only file in the
 * strategy layer that signs and sends a transaction. The vault contract
 * enforces its own caps regardless of what this code sends; this file's job
 * is picking a good trade, the contract's is refusing a dangerous one.
 *
 * Entry points: executeIfProfitable (rebalance, gated on minProfitBps),
 * executeDca (unconditional fixed-schedule buys), and executeVenueSwap (a
 * single arbitrage leg on a specific venue). All still require a real venue
 * quote for slippage protection.
 */
import { v4 as uuidv4 } from "uuid";
import { createPublicClient, encodeFunctionData, http, keccak256, toBytes, type Address } from "viem";
import { getOperatorWalletClient } from "../vault/operatorSigner";
import { activeChain, rpcUrl } from "../chains";
import {
  buildMentoSwapCalldata,
  getMentoQuote,
  MENTO_BROKER_ADDRESS,
  findExchangeId,
  MENTO_BIPOOL_MANAGER,
} from "../dex/mento";
import { buildUniswapSwapCalldata, getBestUniswapQuote, getUniswapQuote, UNISWAP_SWAP_ROUTER_02 } from "../dex/uniswap";
import { getSquidSameChainRoute } from "../dex/squidSameChain";
import { TOKENS, type TokenSymbol } from "../tokens";
import type { ScanResult } from "./spreadScanner";
import { accrueFee, TradeLog } from "../db/models";
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

const publicClient = createPublicClient({ chain: activeChain(), transport: http(rpcUrl()) });

/** Sends the tagged executeSwap call and logs the result — shared by every strategy's execution path. */
async function sendTaggedSwap(params: {
  vaultAddress: Address;
  userId: string;
  strategy: "rebalance" | "dca" | "arbitrage";
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
  const walletClient = getOperatorWalletClient();

  // The tag must ride on this outer tx's own calldata tail, not on
  // params.callData (the inner router call, an ABI `bytes` arg — a tag there
  // lands mid-calldata where verifyTx won't find it). Encode the untagged
  // call, tag the result, then send raw (writeContract won't let us append
  // bytes after its own encoding).
  const untaggedData = encodeFunctionData({
    abi: AGENT_VAULT_EXECUTE_ABI,
    functionName: "executeSwap",
    args: [
      actionId,
      TOKENS[params.tokenIn].address,
      TOKENS[params.tokenOut].address,
      params.amountIn,
      params.minAmountOut,
      params.target,
      params.callData,
    ],
  });
  const taggedData = await attachAttributionTag(untaggedData);

  try {
    const txHash = await walletClient.sendTransaction({
      to: params.vaultAddress,
      data: taggedData,
      chain: walletClient.chain,
      account: walletClient.account!,
    });

    // Await the receipt before returning: this serializes same-tick trades
    // (the next send only fetches its nonce after this one mines, avoiding
    // "replacement transaction underpriced" races) and makes the logged
    // status the real on-chain outcome.
    let status: "submitted" | "settled" | "reverted" = "submitted";
    try {
      const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash, timeout: 60_000 });
      status = receipt.status === "success" ? "settled" : "reverted";
    } catch {
      // Receipt didn't arrive within the timeout — leave it as submitted
      // rather than guessing an outcome.
    }

    await TradeLog.create({
      userId: params.userId,
      vaultAddress: params.vaultAddress,
      actionId,
      strategy: params.strategy,
      tokenIn: params.tokenIn,
      tokenOut: params.tokenOut,
      amountIn: params.amountIn.toString(),
      amountOut: params.amountOut.toString(),
      status,
      txHash,
      quotedProfitBps: params.quotedProfitBps,
    });

    if (status === "reverted") {
      return { status: "reverted", txHash, actionId, reason: "Transaction mined but reverted on-chain — see the tx on Celoscan for the revert reason." };
    }
    await accrueFee(params.userId, "trade");
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
    // Re-quote to learn which fee tier won — the swap must target the pool
    // the quote came from, not a hardcoded tier.
    const best = await getBestUniswapQuote(scan.tokenIn, scan.tokenOut, scan.amountIn);
    if (!best) {
      return { status: "skipped-no-route", actionId: keccak256(toBytes(uuidv4())), reason: "Uniswap route disappeared between quote and execute — skipping this tick." };
    }
    target = UNISWAP_SWAP_ROUTER_02;
    callData = buildUniswapSwapCalldata({
      tokenIn: TOKENS[scan.tokenIn].address,
      tokenOut: TOKENS[scan.tokenOut].address,
      fee: best.fee,
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
 * Executes a swap unconditionally (no profit check). Used by the worker's DCA
 * loop (strategy: "dca") and the chat agent's on-demand swap tool
 * (strategy: "rebalance"). Still requires a real venue quote for slippage
 * protection and won't execute with no route.
 */
export async function executeDca(
  vaultAddress: Address,
  userId: string,
  tokenIn: TokenSymbol,
  tokenOut: TokenSymbol,
  amountIn: bigint,
  maxSlippageBps: number,
  strategy: "dca" | "rebalance" = "dca"
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
      strategy,
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
    const best = await getBestUniswapQuote(tokenIn, tokenOut, amountIn);
    if (!best) {
      return {
        status: "skipped-no-route",
        actionId: keccak256(toBytes(uuidv4())),
        reason: "Uniswap route disappeared between quote and execute — skipping this tick.",
      };
    }
    target = UNISWAP_SWAP_ROUTER_02;
    callData = buildUniswapSwapCalldata({
      tokenIn: TOKENS[tokenIn].address,
      tokenOut: TOKENS[tokenOut].address,
      fee: best.fee,
      recipient: vaultAddress,
      amountIn,
      amountOutMin: minAmountOut,
    });
  }

  return sendTaggedSwap({
    vaultAddress,
    userId,
    strategy,
    tokenIn,
    tokenOut,
    amountIn,
    minAmountOut,
    target,
    callData,
    amountOut: bestVenue.amountOut,
    reasonOnSuccess:
      strategy === "dca" ? `DCA buy: ${tokenIn} -> ${tokenOut} via ${bestVenue.venue}` : `On-demand swap: ${tokenIn} -> ${tokenOut} via ${bestVenue.venue}`,
  });
}

/**
 * One arbitrage leg — executes on a specific venue (no best-venue selection),
 * unconditionally (no profit gate), with the user's slippage tolerance still
 * applied against the venue's own quote.
 */
export async function executeVenueSwap(
  venue: "squid" | "uniswap",
  vaultAddress: Address,
  userId: string,
  tokenIn: TokenSymbol,
  tokenOut: TokenSymbol,
  amountIn: bigint,
  maxSlippageBps: number
): Promise<ExecutionResult> {
  let target: Address;
  let callData: `0x${string}`;
  let quotedOut: bigint;

  if (venue === "squid") {
    const route = await getSquidSameChainRoute(tokenIn, tokenOut, amountIn, vaultAddress);
    if (!route) {
      return { status: "skipped-no-route", actionId: keccak256(toBytes(uuidv4())), reason: "Squid returned no route (or rate-limited)." };
    }
    target = route.target;
    callData = route.callData;
    quotedOut = route.amountOut;
  } else {
    const best = await getBestUniswapQuote(tokenIn, tokenOut, amountIn);
    if (!best) {
      return { status: "skipped-no-route", actionId: keccak256(toBytes(uuidv4())), reason: "No Uniswap pool has a route for this pair." };
    }
    target = UNISWAP_SWAP_ROUTER_02;
    quotedOut = best.amountOut;
    callData = buildUniswapSwapCalldata({
      tokenIn: TOKENS[tokenIn].address,
      tokenOut: TOKENS[tokenOut].address,
      fee: best.fee,
      recipient: vaultAddress,
      amountIn,
      amountOutMin: (best.amountOut * BigInt(10000 - maxSlippageBps)) / 10000n,
    });
  }

  const minAmountOut = (quotedOut * BigInt(10000 - maxSlippageBps)) / 10000n;

  return sendTaggedSwap({
    vaultAddress,
    userId,
    strategy: "arbitrage",
    tokenIn,
    tokenOut,
    amountIn,
    minAmountOut,
    target,
    callData,
    amountOut: quotedOut,
    reasonOnSuccess: `Arb leg: ${tokenIn} -> ${tokenOut} via ${venue}`,
  });
}
