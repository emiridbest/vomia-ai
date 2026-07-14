/**
 * LiFi — the second cross-chain aggregator, same role as squid.ts: funding
 * a vault from another chain, not the same-chain hot loop. Kept alongside
 * Squid so the funding flow can compare both and offer the user the better
 * quote, rather than being locked into a single bridge provider.
 */
import { createConfig, getQuote, convertQuoteToRoute, executeRoute, type QuoteRequest } from "@lifi/sdk";

let configured = false;
function ensureConfigured() {
  if (configured) return;
  createConfig({ integrator: process.env.LIFI_INTEGRATOR_NAME || "vomia-agent" });
  configured = true;
}

export const CELO_CHAIN_ID_LIFI = 42220;

export interface LifiQuoteParams {
  fromChain: number;
  fromToken: `0x${string}`;
  fromAmount: string;
  toToken: `0x${string}`;
  userAddress: `0x${string}`;
}

export async function getLifiBridgeQuote(params: LifiQuoteParams) {
  ensureConfigured();
  const request: QuoteRequest = {
    fromChain: params.fromChain,
    toChain: CELO_CHAIN_ID_LIFI,
    fromToken: params.fromToken,
    toToken: params.toToken,
    fromAmount: params.fromAmount,
    fromAddress: params.userAddress,
  };
  return getQuote(request);
}

/** Same rule as squid.ts: user-signed, browser-side, never the operator key. */
export async function executeLifiBridge(quote: Awaited<ReturnType<typeof getLifiBridgeQuote>>) {
  ensureConfigured();
  const route = convertQuoteToRoute(quote);
  return executeRoute(route, {
    updateRouteHook(updated) {
      // wire this into the UI's live-feed component if you want a
      // step-by-step bridging progress indicator
      console.log("LiFi route update:", updated.id, updated.steps.at(-1)?.execution?.status);
    },
  });
}
