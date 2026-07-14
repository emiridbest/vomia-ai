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
 */
import { v4 as uuidv4 } from "uuid";
import { keccak256, toBytes, type Address } from "viem";
import { getOperatorWalletClient } from "../vault/operatorSigner";
import { buildMentoSwapCalldata, MENTO_BROKER_ADDRESS, findExchangeId, MENTO_BIPOOL_MANAGER } from "../dex/mento";
import { buildUniswapSwapCalldata, UNISWAP_SWAP_ROUTER_02 } from "../dex/uniswap";
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

export async function executeIfProfitable(
  vaultAddress: Address,
  userId: string,
  scan: ScanResult,
  maxSlippageBps: number
): Promise<ExecutionResult> {
  const actionId = keccak256(toBytes(uuidv4()));

  if (scan.decision !== "execute" || !scan.bestVenue) {
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
      return { status: "skipped-no-route", actionId, reason: "Mento exchangeId disappeared between quote and execute — skipping this tick." };
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

  // Attribution Tags: append the ERC-8021 suffix so this settlement is
  // provably credited to this project on-chain, whatever venue it routed
  // through. One line, per the newsletter — see lib/attribution.ts.
  callData = attachAttributionTag(callData);

  const walletClient = getOperatorWalletClient();

  try {
    const txHash = await walletClient.writeContract({
      address: vaultAddress,
      abi: AGENT_VAULT_EXECUTE_ABI,
      functionName: "executeSwap",
      args: [actionId, TOKENS[scan.tokenIn].address, TOKENS[scan.tokenOut].address, scan.amountIn, minAmountOut, target, callData],
      chain: walletClient.chain,
      account: walletClient.account!,
    });

    await TradeLog.create({
      userId,
      vaultAddress,
      actionId,
      strategy: "rebalance",
      tokenIn: scan.tokenIn,
      tokenOut: scan.tokenOut,
      amountIn: scan.amountIn.toString(),
      amountOut: scan.bestVenue.amountOut.toString(),
      status: "submitted",
      txHash,
      quotedProfitBps: scan.netEdgeBps ?? undefined,
    });

    return { status: "settled", txHash, actionId, reason: scan.reason };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await TradeLog.create({
      userId,
      vaultAddress,
      actionId,
      strategy: "rebalance",
      tokenIn: scan.tokenIn,
      tokenOut: scan.tokenOut,
      amountIn: scan.amountIn.toString(),
      status: "reverted",
      quotedProfitBps: scan.netEdgeBps ?? undefined,
    });
    return { status: "reverted", actionId, reason: `Execution reverted: ${message}` };
  }
}
