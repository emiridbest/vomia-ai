/**
 * Operator-wallet DIRECT trading.
 *
 * Why this exists: Track 1 tagged volume is attributed to transfer legs whose
 * `from` equals the transaction sender (tx_from). A vault-mediated trade can
 * NEVER satisfy that — a contract is never tx_from, so `executeSwap` txs
 * (sent by the operator EOA, tokens moving from the vault contract) score
 * zero tagged volume no matter how many run. Here the operator EOA swaps its
 * OWN balance directly on Mento/Uniswap: tx_from == the operator == the token
 * sender, so the input transfer leg is credited at full USD value.
 *
 * The ERC-8021 tag rides on the DEX call's own calldata tail (Broker.swapIn /
 * Router.exactInputSingle ignore trailing bytes), which is the true tail of
 * tx.input — exactly where verifyTx looks. No wrapper, so no ABI padding
 * problem like the vault path had.
 *
 * This is custodial for the operator's own working balance (the funds sit in
 * an EOA, not the non-custodial vault) — a deliberate, hackathon-scoped
 * choice for leaderboard volume, separate from the vault product.
 */
import { encodeFunctionData, type Address } from "viem";
import { getOperatorWalletClient, operatorAddress } from "../vault/operatorSigner";
import { activeChain, rpcUrl } from "../chains";
import { createPublicClient, http } from "viem";
import {
  buildMentoSwapCalldata,
  getMentoQuote,
  findExchangeId,
  MENTO_BROKER_ADDRESS,
  MENTO_BIPOOL_MANAGER,
} from "../dex/mento";
import { buildUniswapSwapCalldata, getBestUniswapQuote, UNISWAP_SWAP_ROUTER_02 } from "../dex/uniswap";
import { TOKENS, type TokenSymbol } from "../tokens";
import { attachAttributionTag } from "../attribution";
import { accrueFee, TradeLog, User } from "../db/models";

const publicClient = createPublicClient({ chain: activeChain(), transport: http(rpcUrl()) });
const MAX_UINT = (1n << 256n) - 1n;

const ERC20_ABI = [
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ name: "a", type: "address" }], outputs: [{ type: "uint256" }] },
  {
    type: "function",
    name: "allowance",
    stateMutability: "view",
    inputs: [
      { name: "o", type: "address" },
      { name: "s", type: "address" },
    ],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "approve",
    stateMutability: "nonpayable",
    inputs: [
      { name: "s", type: "address" },
      { name: "a", type: "uint256" },
    ],
    outputs: [{ type: "bool" }],
  },
] as const;

export interface DirectResult {
  status: "settled" | "reverted" | "skipped-no-route";
  txHash?: `0x${string}`;
  amountOut?: bigint;
  reason: string;
}

/** ERC20 balance of the operator EOA (CELO's ERC20 balance equals its native/gas balance). */
export async function operatorTokenBalance(symbol: TokenSymbol): Promise<bigint> {
  return publicClient.readContract({ address: TOKENS[symbol].address, abi: ERC20_ABI, functionName: "balanceOf", args: [operatorAddress()] });
}

/** Ensure the operator has approved `spender` to pull at least `amount` of `token`; max-approves once if not. */
async function ensureAllowance(token: Address, spender: Address, amount: bigint): Promise<void> {
  const current = await publicClient.readContract({ address: token, abi: ERC20_ABI, functionName: "allowance", args: [operatorAddress(), spender] });
  if (current >= amount) return;
  const wallet = getOperatorWalletClient();
  const hash = await wallet.sendTransaction({
    to: token,
    data: encodeFunctionData({ abi: ERC20_ABI, functionName: "approve", args: [spender, MAX_UINT] }),
    chain: wallet.chain,
    account: wallet.account!,
  });
  await publicClient.waitForTransactionReceipt({ hash, timeout: 60_000 });
}

/** The one operator "user" row (walletAddress = operator, no vaultAddress) — gives direct-trade logs a real userId. */
export async function ensureOperatorUser(): Promise<{ id: string; address: Address }> {
  const address = operatorAddress();
  // Explicitly $unset vaultAddress: the operator EOA is a trader, never a
  // vault. If it ever carries a vaultAddress, the per-vault loop tries to
  // read tokenBalance() on an EOA (not a contract) and throws, which
  // previously killed the whole tick.
  const user = await User.findOneAndUpdate(
    { walletAddress: address },
    { $set: { walletAddress: address }, $unset: { vaultAddress: "" } },
    { upsert: true, new: true }
  );
  return { id: user._id.toString(), address };
}

/**
 * Swap `amountIn` of tokenIn -> tokenOut from the operator's own balance, on
 * the best of Mento/Uniswap, tagged, output back to the operator. Logs to
 * TradeLog (vaultAddress = operator address) and accrues the trade fee.
 */
export async function executeDirectSwap(
  userId: string,
  tokenIn: TokenSymbol,
  tokenOut: TokenSymbol,
  amountIn: bigint,
  maxSlippageBps: number,
  strategy: "rebalance" | "dca",
  /**
   * Pin this leg to one venue instead of taking whichever quotes higher.
   * The pin is honoured even when the other venue is quoting better — that
   * is the point of pinning, and the cost is real (the two flip on this pair
   * by around a basis point). It is NOT honoured when the pinned venue has
   * no route at all: falling back beats stalling the loop, and the fallback
   * is logged loudly rather than silently.
   */
  preferVenue?: "mento" | "uniswap"
): Promise<DirectResult> {
  const [mento, uni] = await Promise.all([
    getMentoQuote(tokenIn, tokenOut, amountIn).catch(() => null),
    getBestUniswapQuote(tokenIn, tokenOut, amountIn).catch(() => null),
  ]);
  const mentoOut = mento?.amountOut ?? null;
  const uniOut = uni?.amountOut ?? null;
  if (mentoOut === null && uniOut === null) {
    return { status: "skipped-no-route", reason: `No venue routes ${tokenIn}->${tokenOut}.` };
  }
  let useMento: boolean;
  if (preferVenue === "mento") useMento = mentoOut !== null;
  else if (preferVenue === "uniswap") useMento = uniOut === null;
  else useMento = mentoOut !== null && (uniOut === null || mentoOut >= uniOut);
  const pinMissed = preferVenue !== undefined && useMento !== (preferVenue === "mento");
  if (pinMissed) {
    console.warn(`[direct] ${tokenIn}->${tokenOut}: pinned to ${preferVenue} but it has no route; falling back to ${useMento ? "mento" : "uniswap"}.`);
  }
  const quotedOut = (useMento ? mentoOut : uniOut) as bigint;
  const minAmountOut = (quotedOut * BigInt(10000 - maxSlippageBps)) / 10000n;

  let target: Address;
  let callData: `0x${string}`;
  if (useMento) {
    const exchangeId = await findExchangeId(TOKENS[tokenIn].address, TOKENS[tokenOut].address);
    if (!exchangeId) return { status: "skipped-no-route", reason: "Mento exchangeId not found." };
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
      fee: (uni as { fee: number }).fee,
      recipient: operatorAddress(),
      amountIn,
      amountOutMin: minAmountOut,
    });
  }

  await ensureAllowance(TOKENS[tokenIn].address, target, amountIn);

  const tagged = await attachAttributionTag(callData);
  const wallet = getOperatorWalletClient();
  const actionId = `direct-${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;
  try {
    const txHash = await wallet.sendTransaction({ to: target, data: tagged, chain: wallet.chain, account: wallet.account! });
    let status: "submitted" | "settled" | "reverted" = "submitted";
    try {
      const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash, timeout: 60_000 });
      status = receipt.status === "success" ? "settled" : "reverted";
    } catch {
      /* leave as submitted */
    }
    await TradeLog.create({
      userId,
      vaultAddress: operatorAddress(),
      actionId,
      strategy,
      tokenIn,
      tokenOut,
      amountIn: amountIn.toString(),
      amountOut: quotedOut.toString(),
      status,
      txHash,
    });
    if (status === "reverted") return { status: "reverted", txHash, reason: "Direct swap reverted on-chain." };
    await accrueFee(userId, "trade");
    return { status: "settled", txHash, amountOut: quotedOut, reason: `Direct ${tokenIn}->${tokenOut} via ${useMento ? "mento" : "uniswap"}` };
  } catch (err) {
    return { status: "reverted", reason: `Direct swap failed: ${err instanceof Error ? err.message : String(err)}` };
  }
}
