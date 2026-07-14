/**
 * Mento Broker integration.
 *
 * This is the PRIMARY venue for same-chain Mento-currency swaps (USDm <->
 * KESm, USDm <-> NGNm, USDm <-> EURm, CELO <-> USDm, etc). It's the fastest
 * and cheapest path for exactly the pairs this project cares about most, so
 * the scanner should check Mento first before reaching for Uniswap or a
 * cross-chain aggregator.
 *
 * Broker address verified against docs.mento.org's own deployments page AND
 * a real, executed mainnet swapIn transaction on CeloScan (both independently
 * matching 0x777A8255cA72412f0d706dc03C9D1987306B4CaD) — see README.md
 * "What's verified vs. what needs your own review".
 */
import { createPublicClient, http, encodeFunctionData, type Address } from "viem";
import { celo } from "viem/chains";
import { rpcUrl } from "../chains";
import { TOKENS, type TokenSymbol } from "../tokens";

export const MENTO_BROKER_ADDRESS: Address = "0x777A8255cA72412f0d706dc03C9D1987306B4CaD";
// The BiPoolManager that holds the USDm<->CELO pool — confirmed against a
// real on-chain swapIn call. Other pairs (USDm<->KESm, USDm<->NGNm, etc.)
// may live on the same or a different exchange provider; call
// `getExchangeProviders` / `getExchangesForProvider` below to discover the
// exchangeId for a pair you haven't hardcoded yet, and cache the result —
// exchangeIds are stable once created.
export const MENTO_BIPOOL_MANAGER: Address = "0x22d9db95E6Ae61c104A7B6F6C78D7993B94ec901";

const BROKER_ABI = [
  {
    type: "function",
    name: "getAmountOut",
    stateMutability: "view",
    inputs: [
      { name: "exchangeProvider", type: "address" },
      { name: "exchangeId", type: "bytes32" },
      { name: "tokenIn", type: "address" },
      { name: "tokenOut", type: "address" },
      { name: "amountIn", type: "uint256" },
    ],
    outputs: [{ name: "amountOut", type: "uint256" }],
  },
  {
    type: "function",
    name: "swapIn",
    stateMutability: "nonpayable",
    inputs: [
      { name: "exchangeProvider", type: "address" },
      { name: "exchangeId", type: "bytes32" },
      { name: "tokenIn", type: "address" },
      { name: "tokenOut", type: "address" },
      { name: "amountIn", type: "uint256" },
      { name: "amountOutMin", type: "uint256" },
    ],
    outputs: [{ name: "amountOut", type: "uint256" }],
  },
  {
    type: "function",
    name: "getExchangeProviders",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "address[]" }],
  },
] as const;

const BIPOOL_MANAGER_ABI = [
  {
    type: "function",
    name: "getExchanges",
    stateMutability: "view",
    inputs: [],
    outputs: [
      {
        name: "",
        type: "tuple[]",
        components: [
          { name: "exchangeId", type: "bytes32" },
          { name: "assets", type: "address[]" },
        ],
      },
    ],
  },
] as const;

const publicClient = createPublicClient({ chain: celo, transport: http(rpcUrl()) });

/**
 * Finds the exchangeId for a token pair by scanning the BiPoolManager's
 * exchange list. Cheap to call but not free — cache the result per pair in
 * your own process rather than calling this on every scan tick.
 */
export async function findExchangeId(tokenA: Address, tokenB: Address): Promise<`0x${string}` | null> {
  const exchanges = await publicClient.readContract({
    address: MENTO_BIPOOL_MANAGER,
    abi: BIPOOL_MANAGER_ABI,
    functionName: "getExchanges",
  });
  for (const ex of exchanges as readonly { exchangeId: `0x${string}`; assets: readonly Address[] }[]) {
    const assets = ex.assets.map((a) => a.toLowerCase());
    if (assets.includes(tokenA.toLowerCase()) && assets.includes(tokenB.toLowerCase())) {
      return ex.exchangeId;
    }
  }
  return null;
}

export interface MentoQuote {
  amountOut: bigint;
  exchangeProvider: Address;
  exchangeId: `0x${string}`;
}

export async function getMentoQuote(tokenIn: TokenSymbol, tokenOut: TokenSymbol, amountIn: bigint): Promise<MentoQuote | null> {
  const tokenInAddr = TOKENS[tokenIn].address;
  const tokenOutAddr = TOKENS[tokenOut].address;
  const exchangeId = await findExchangeId(tokenInAddr, tokenOutAddr);
  if (!exchangeId) return null;

  const amountOut = await publicClient.readContract({
    address: MENTO_BROKER_ADDRESS,
    abi: BROKER_ABI,
    functionName: "getAmountOut",
    args: [MENTO_BIPOOL_MANAGER, exchangeId, tokenInAddr, tokenOutAddr, amountIn],
  });

  return { amountOut, exchangeProvider: MENTO_BIPOOL_MANAGER, exchangeId };
}

/**
 * Builds the raw calldata for a Broker.swapIn call, ready to pass as the
 * `callData` argument to AgentVault.executeSwap (with `target` =
 * MENTO_BROKER_ADDRESS). The vault — not this function — is what actually
 * holds and approves the tokens; this just encodes the call.
 */
export function buildMentoSwapCalldata(params: {
  exchangeProvider: Address;
  exchangeId: `0x${string}`;
  tokenIn: Address;
  tokenOut: Address;
  amountIn: bigint;
  amountOutMin: bigint;
}): `0x${string}` {
  return encodeFunctionData({
    abi: BROKER_ABI,
    functionName: "swapIn",
    args: [params.exchangeProvider, params.exchangeId, params.tokenIn, params.tokenOut, params.amountIn, params.amountOutMin],
  });
}
