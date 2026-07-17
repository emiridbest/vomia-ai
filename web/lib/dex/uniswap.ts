/**
 * Uniswap V3 integration on Celo.
 *
 * SwapRouter02 address below is verified against two independent sources
 * (CeloScan's deployed + verified source code, and Uniswap's own
 * docs/deployments repo on GitHub) — see README.md. The Quoter address is
 * deliberately LEFT BLANK here rather than guessed: quoting wasn't
 * independently confirmed for Celo's specific deployment during research,
 * and a wrong address for a read-only quote call fails loudly (a revert),
 * which is a very different risk profile than a wrong token/router address
 * for a call that moves funds — but it should still come from you, pulled
 * from https://docs.celo.org/tooling/contracts/uniswap-contracts or
 * https://developers.uniswap.org, not pattern-matched from another chain.
 * Set it as UNISWAP_QUOTER_V2_ADDRESS in your .env.
 */
import { createPublicClient, http, encodeFunctionData, type Address } from "viem";
import { celo } from "viem/chains";
import { rpcUrl } from "../chains";
import { TOKENS, type TokenSymbol } from "../tokens";

export const UNISWAP_SWAP_ROUTER_02: Address = "0x5615CDAb10dc425a742d643d949a7F474C01abc4";

const QUOTER_V2_ABI = [
  {
    type: "function",
    name: "quoteExactInputSingle",
    stateMutability: "nonpayable", // QuoterV2 simulates via revert-and-catch; must be called with `simulateContract`, not `readContract`
    inputs: [
      {
        name: "params",
        type: "tuple",
        components: [
          { name: "tokenIn", type: "address" },
          { name: "tokenOut", type: "address" },
          { name: "amountIn", type: "uint256" },
          { name: "fee", type: "uint24" },
          { name: "sqrtPriceLimitX96", type: "uint160" },
        ],
      },
    ],
    outputs: [
      { name: "amountOut", type: "uint256" },
      { name: "sqrtPriceX96After", type: "uint160" },
      { name: "initializedTicksCrossed", type: "uint32" },
      { name: "gasEstimate", type: "uint256" },
    ],
  },
] as const;

const SWAP_ROUTER_02_ABI = [
  {
    type: "function",
    name: "exactInputSingle",
    stateMutability: "payable",
    inputs: [
      {
        name: "params",
        type: "tuple",
        components: [
          { name: "tokenIn", type: "address" },
          { name: "tokenOut", type: "address" },
          { name: "fee", type: "uint24" },
          { name: "recipient", type: "address" },
          { name: "amountIn", type: "uint256" },
          { name: "amountOutMinimum", type: "uint256" },
          { name: "sqrtPriceLimitX96", type: "uint160" },
        ],
      },
    ],
    outputs: [{ name: "amountOut", type: "uint256" }],
  },
] as const;

const publicClient = createPublicClient({ chain: celo, transport: http(rpcUrl()) });

/** All Uniswap V3 fee tiers, in hundredths of a bip (500 = 0.05%, 3000 = 0.3%). */
export const FEE_TIERS = [100, 500, 3000, 10000] as const;

async function quoteAtFee(tokenIn: TokenSymbol, tokenOut: TokenSymbol, amountIn: bigint, fee: number): Promise<bigint | null> {
  const quoterAddress = process.env.UNISWAP_QUOTER_V2_ADDRESS as Address | undefined;
  if (!quoterAddress) return null;
  try {
    const { result } = await publicClient.simulateContract({
      address: quoterAddress,
      abi: QUOTER_V2_ABI,
      functionName: "quoteExactInputSingle",
      args: [
        {
          tokenIn: TOKENS[tokenIn].address,
          tokenOut: TOKENS[tokenOut].address,
          amountIn,
          fee,
          sqrtPriceLimitX96: 0n,
        },
      ],
    });
    return result[0];
  } catch (err) {
    // No pool at this fee tier, or insufficient liquidity — not a bug, just "no route here"
    return null;
  }
}

/**
 * Best single-hop quote across every fee tier — the Uniswap frontend's smart
 * order router checks all tiers (and multi-hops), so quoting only the 0.3%
 * pool systematically underprices Uniswap on pairs whose real liquidity
 * lives in a different tier. Returns the winning tier alongside the amount
 * so the swap calldata can be built against the same pool that was quoted.
 */
export async function getBestUniswapQuote(
  tokenIn: TokenSymbol,
  tokenOut: TokenSymbol,
  amountIn: bigint
): Promise<{ amountOut: bigint; fee: number } | null> {
  const quoterAddress = process.env.UNISWAP_QUOTER_V2_ADDRESS as Address | undefined;
  if (!quoterAddress) {
    console.warn("UNISWAP_QUOTER_V2_ADDRESS not set — skipping Uniswap as a venue. See this file's header comment.");
    return null;
  }
  const results = await Promise.all(FEE_TIERS.map((fee) => quoteAtFee(tokenIn, tokenOut, amountIn, fee).then((amountOut) => ({ fee, amountOut }))));
  let best: { amountOut: bigint; fee: number } | null = null;
  for (const r of results) {
    if (r.amountOut !== null && (best === null || r.amountOut > best.amountOut)) best = { amountOut: r.amountOut, fee: r.fee };
  }
  return best;
}

export async function getUniswapQuote(
  tokenIn: TokenSymbol,
  tokenOut: TokenSymbol,
  amountIn: bigint
): Promise<bigint | null> {
  const best = await getBestUniswapQuote(tokenIn, tokenOut, amountIn);
  return best?.amountOut ?? null;
}

export function buildUniswapSwapCalldata(params: {
  tokenIn: Address;
  tokenOut: Address;
  fee: number;
  recipient: Address; // the vault's own address — tokens must land back in the vault
  amountIn: bigint;
  amountOutMin: bigint;
}): `0x${string}` {
  return encodeFunctionData({
    abi: SWAP_ROUTER_02_ABI,
    functionName: "exactInputSingle",
    args: [
      {
        tokenIn: params.tokenIn,
        tokenOut: params.tokenOut,
        fee: params.fee,
        recipient: params.recipient,
        amountIn: params.amountIn,
        amountOutMinimum: params.amountOutMin,
        sqrtPriceLimitX96: 0n,
      },
    ],
  });
}
