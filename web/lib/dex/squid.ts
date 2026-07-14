/**
 * Squid Router — cross-chain, not same-chain.
 *
 * Design note: Squid and LiFi (lifi.ts) are bridge/DEX AGGREGATORS whose job
 * is routing value *between* chains. They're the right tool for "a user has
 * USDC on Base/Arbitrum/etc and wants to fund their Celo vault" or "send the
 * remittance out to a recipient who's on another chain" — genuinely useful,
 * and both already show up inside MiniPay's own ecosystem. They are the
 * WRONG tool for the tight same-chain loop that needs to run many times a
 * day (USDm<->KESm, USDm<->NGNm, etc): every cross-chain hop adds bridge
 * latency and fees that a same-chain Mento/Uniswap call doesn't have. Keep
 * the hot loop in mento.ts / uniswap.ts; reach for this file at account
 * funding time, not scan time.
 *
 * Needs an integrator ID (free, request one at https://docs.squidrouter.com)
 * — set SQUID_INTEGRATOR_ID in your .env. Nothing here will work without it.
 */
import { Squid } from "@0xsquid/sdk";

let squidInstance: Squid | null = null;

async function getSquid(): Promise<Squid> {
  if (squidInstance) return squidInstance;
  const integratorId = process.env.SQUID_INTEGRATOR_ID;
  if (!integratorId) {
    throw new Error("SQUID_INTEGRATOR_ID not set — request one at https://docs.squidrouter.com before using this file.");
  }
  squidInstance = new Squid({ baseUrl: "https://v2.api.squidrouter.com", integratorId });
  await squidInstance.init();
  return squidInstance;
}

export const CELO_CHAIN_ID_SQUID = "42220";

export interface BridgeInParams {
  fromChain: string; // Squid chain id, e.g. "8453" for Base
  fromToken: `0x${string}`;
  fromAmount: string; // smallest unit, as a string
  toToken: `0x${string}`; // token on Celo the user wants to end up with (e.g. USDm)
  userAddress: `0x${string}`; // the user's own wallet — funds a DEPOSIT into their vault, not the vault itself directly, since the vault only accepts `deposit()` calls from an approved sender
}

/** Quote-only — safe to call from the UI on every keystroke of an amount field. */
export async function getSquidBridgeQuote(params: BridgeInParams) {
  const squid = await getSquid();
  const { route } = await squid.getRoute({
    fromChain: params.fromChain,
    fromToken: params.fromToken,
    fromAmount: params.fromAmount,
    toChain: CELO_CHAIN_ID_SQUID,
    toToken: params.toToken,
    fromAddress: params.userAddress,
    toAddress: params.userAddress,
    slippageConfig: { autoMode: 1 },
  });
  return route;
}

/**
 * Executes a previously-quoted route. This is a USER action (they're moving
 * their own funds in from another chain) signed by the user's own Web3Auth
 * wallet client-side — the agent operator key is never involved in funding.
 * Call this from the browser with the user's own signer, not from the
 * worker/backend.
 */
export async function executeSquidBridge(route: Awaited<ReturnType<typeof getSquidBridgeQuote>>, signer: unknown) {
  const squid = await getSquid();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return squid.executeRoute({ route, signer: signer as any });
}
