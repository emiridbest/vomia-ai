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
 * token's own address, per Mento's docs. The oracle's internal fixed-point
 * precision cancels out when cross-dividing two rates — but the ratio's
 * ORIENTATION does not: the rates are stable-units-per-CELO, and a formula
 * assuming the opposite orientation errs by the square of the cross rate,
 * not by a sign flip that cancels. (Learned the hard way — see the
 * derivation note on getReferenceAmountOut below.)
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
 * Derivation: medianRate(X) gives rateX = numX/denX = STABLE UNITS PER
 * CELO — verified against live values with CELO at ~0.07 USD: USDm 0.068,
 * KESm 9.03 (0.068 x ~132 KES/USD), NGNm 96.5, EURm 0.061 all fit that
 * reading exactly. (An earlier version of this formula assumed the
 * opposite orientation — CELO per stable unit — which inverted every
 * cross-rate: it made KESm/NGNm references wrong by the SQUARE of the
 * local exchange rate, ~17,000x and ~1,900,000x, and quietly skewed EURm
 * by ~25%, small enough to pass the scanner's 10x sanity guard while
 * still poisoning its edge numbers.) So:
 *   amountIn / rateIn  == its CELO-equivalent value
 *   amountOut / rateOut == its CELO-equivalent value
 * Setting those equal and solving for amountOut:
 *   amountOut = amountIn * (rateOut / rateIn)
 *             = amountIn * (numOut * denIn) / (denOut * numIn)
 * scaled for each token's own decimals. All done in BigInt — no floating
 * point, no precision loss, and the oracle's internal fixed-point scale
 * cancels out of the ratio entirely.
 *
 * Returns null if either token has no oracle rate feed (not a Mento stable
 * — e.g. USDC, USDT, G$) or the call fails for any reason.
 */
export async function getReferenceAmountOut(tokenIn: TokenSymbol, tokenOut: TokenSymbol, amountIn: bigint): Promise<bigint | null> {
  try {
    // The rates are denominated IN CELO (stable units per CELO), so CELO
    // itself is the numeraire: its "rate" is 1/1 by definition, and the
    // oracle has no feed keyed by the CELO token address.
    const rateFor = (symbol: TokenSymbol): Promise<readonly [bigint, bigint]> =>
      symbol === "CELO"
        ? Promise.resolve([1n, 1n] as const)
        : publicClient.readContract({
            address: SORTED_ORACLES_ADDRESS,
            abi: SORTED_ORACLES_ABI,
            functionName: "medianRate",
            args: [TOKENS[symbol].address],
          });

    const [rateIn, rateOut] = await Promise.all([rateFor(tokenIn), rateFor(tokenOut)]);

    const [numIn, denIn] = rateIn;
    const [numOut, denOut] = rateOut;
    if (numIn === 0n || denIn === 0n || numOut === 0n || denOut === 0n) return null;

    const decimalsIn = TOKENS[tokenIn].decimals;
    const decimalsOut = TOKENS[tokenOut].decimals;

    // amountOut = amountIn * numOut * denIn * 10^decimalsOut / (denOut * numIn * 10^decimalsIn)
    const numerator = amountIn * numOut * denIn * 10n ** BigInt(decimalsOut);
    const denominator = denOut * numIn * 10n ** BigInt(decimalsIn);
    return numerator / denominator;
  } catch {
    return null;
  }
}
