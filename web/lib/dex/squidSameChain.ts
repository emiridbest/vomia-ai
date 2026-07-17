/**
 * Squid Router, same-chain mode (Celo -> Celo) — added for the 24h
 * buy-on-Squid / sell-on-Uniswap arbitrage experiment.
 *
 * Two facts worth keeping in mind when reading results:
 *  - Squid is an AGGREGATOR: a live route inspection showed its same-chain
 *    USDm->CELO route executes "swap: Mento V2" under the hood — its edge
 *    over quoting Mento directly is routing choice, not a different market.
 *  - Their API rate-limits aggressively (429 after a handful of requests),
 *    which is why this module is only called from the low-cadence arbitrage
 *    strategy, never from the 20s scan loop.
 *
 * Uses the plain REST API rather than @0xsquid/sdk — the installed SDK
 * build has a broken internal dependency (@0xsquid/squid-types missing),
 * and the REST surface is all we need: one POST returns both the quote and
 * the executable transactionRequest (target + calldata) in one shot.
 */
import type { Address } from "viem";
import { TOKENS, type TokenSymbol } from "../tokens";

/** Squid's router/facade on Celo — taken from a live route's transactionRequest.target, not hardcoded from memory. */
export const SQUID_ROUTER_CELO: Address = "0xce16F69375520ab01377ce7B88f5BA8C48F8D666";

export interface SquidSameChainRoute {
  target: Address;
  callData: `0x${string}`;
  amountOut: bigint;
}

/**
 * Quote + executable calldata for a same-chain swap, built with the VAULT as
 * both from and to address so the calldata pulls tokenIn from the vault's
 * allowance (granted by executeSwap's forceApprove) and returns tokenOut to
 * the vault. Returns null on any API failure (including their rate limit).
 */
export async function getSquidSameChainRoute(
  tokenIn: TokenSymbol,
  tokenOut: TokenSymbol,
  amountIn: bigint,
  vaultAddress: Address
): Promise<SquidSameChainRoute | null> {
  const integratorId = process.env.SQUID_INTEGRATOR_ID;
  if (!integratorId) {
    console.warn("SQUID_INTEGRATOR_ID not set — Squid unavailable as a venue.");
    return null;
  }
  try {
    const res = await fetch("https://v2.api.squidrouter.com/v2/route", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-integrator-id": integratorId },
      body: JSON.stringify({
        fromChain: "42220",
        toChain: "42220",
        fromToken: TOKENS[tokenIn].address,
        toToken: TOKENS[tokenOut].address,
        fromAmount: amountIn.toString(),
        fromAddress: vaultAddress,
        toAddress: vaultAddress,
        slippage: 1,
      }),
    });
    if (!res.ok) {
      console.warn(`Squid route ${tokenIn}->${tokenOut}: HTTP ${res.status}`);
      return null;
    }
    const data = await res.json();
    const target = data?.route?.transactionRequest?.target;
    const callData = data?.route?.transactionRequest?.data;
    const amountOut = data?.route?.estimate?.toAmount;
    if (!target || !callData || !amountOut) return null;
    return { target: target as Address, callData: callData as `0x${string}`, amountOut: BigInt(amountOut) };
  } catch (err) {
    console.warn(`Squid route ${tokenIn}->${tokenOut} failed:`, err instanceof Error ? err.message : err);
    return null;
  }
}
