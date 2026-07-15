/**
 * Mento's SortedOracles — the independent reference price this project's
 * "edge" calculation was missing. Without this, spreadScanner.ts compared a
 * DEX quote's raw output *count* against a naive assumption that amountIn is
 * worth 1:1 in USD, which is meaningless once tokenOut isn't ~1 USD (e.g.
 * KESm, NGNm): a correct, fair-value swap into a currency where 1 USD buys
 * ~129 units gets reported as a ~1000x "profit", and a swap into a currency
 * where 1 USD buys <1 unit (EURm) gets reported as a loss. Neither is real.
 *
 * SortedOraclesProxy address verified two ways: cross-checked against
 * docs.mento.org's own deployments page (which also independently confirmed
 * this project's existing MENTO_BROKER_ADDRESS and MENTO_BIPOOL_MANAGER
 * values, both already verified elsewhere in this codebase), AND confirmed
 * on CeloScan as a verified contract named "SortedOraclesProxy" with an
 * active, multi-million-transaction history.
 *
 * medianRate(rateFeedID) returns (numerator, denominator) — a RATIO, not a
 * fixed-point absolute value. For a Mento stable token, rateFeedID is the
 * token's own address, per Mento's docs. Because it's a ratio, this file
 * never needs to know which side of the ratio is "CELO" vs "the stable", or
 * what internal fixed-point precision the oracle uses — as long as both
 * tokens being compared go through the same medianRate call convention
 * (they do, it's the same oracle for every Mento stable), those unknowns
 * cancel out algebraically when cross-dividing two rates through their
 * shared CELO reference. See getReferenceAmountOut below for the derivation.
 */
import { createPublicClient, http, type Address } from "viem";
import { celo } from "viem/chains";
import { rpcUrl } from "../chains";
import { TOKENS, type TokenSymbol } from "../tokens";

export const SORTED_ORACLES_ADDRESS: Address = "0xefb84935239dacdecf7c5ba76d8de40b077b7b33";

const SORTED_ORACLES_ABI = [
  {
    type: "function",
    name: "medianRate",
    stateMutability: "view",
    inputs: [{ name: "token", type: "address" }],
    outputs: [
      { name: "numerator", type: "uint256" },
      { name: "denominator", type: "uint256" },
    ],
  },
] as const;

const publicClient = createPublicClient({ chain: celo, transport: http(rpcUrl()) });

/**
 * The fair-value amount of tokenOut you'd expect for amountIn of tokenIn, at
 * Mento's own oracle reference rate — independent of any DEX's live quote.
 *
 * Derivation: medianRate(X) gives rateX = numX/denX, both stables' rates
 * expressed the same way relative to CELO (whichever side CELO is actually
 * on doesn't matter, see file header). So:
 *   amountIn * rateIn  == its CELO-equivalent value
 *   amountOut * rateOut == its CELO-equivalent value
 * Setting those equal and solving for amountOut:
 *   amountOut = amountIn * (rateIn / rateOut)
 *             = amountIn * (numIn * denOut) / (denIn * numOut)
 * scaled for each token's own decimals. All done in BigInt — no floating
 * point, no precision loss, and the oracle's internal fixed-point scale
 * cancels out of the ratio entirely.
 *
 * Returns null if either token has no oracle rate feed (not a Mento stable
 * — e.g. USDC, USDT, G$) or the call fails for any reason.
 */
export async function getReferenceAmountOut(tokenIn: TokenSymbol, tokenOut: TokenSymbol, amountIn: bigint): Promise<bigint | null> {
  try {
    const [rateIn, rateOut] = await Promise.all([
      publicClient.readContract({
        address: SORTED_ORACLES_ADDRESS,
        abi: SORTED_ORACLES_ABI,
        functionName: "medianRate",
        args: [TOKENS[tokenIn].address],
      }),
      publicClient.readContract({
        address: SORTED_ORACLES_ADDRESS,
        abi: SORTED_ORACLES_ABI,
        functionName: "medianRate",
        args: [TOKENS[tokenOut].address],
      }),
    ]);

    const [numIn, denIn] = rateIn;
    const [numOut, denOut] = rateOut;
    if (numIn === 0n || denIn === 0n || numOut === 0n || denOut === 0n) return null;

    const decimalsIn = TOKENS[tokenIn].decimals;
    const decimalsOut = TOKENS[tokenOut].decimals;

    // amountOut = amountIn * numIn * denOut * 10^decimalsOut / (denIn * numOut * 10^decimalsIn)
    const numerator = amountIn * numIn * denOut * 10n ** BigInt(decimalsOut);
    const denominator = denIn * numOut * 10n ** BigInt(decimalsIn);
    return numerator / denominator;
  } catch {
    return null;
  }
}
