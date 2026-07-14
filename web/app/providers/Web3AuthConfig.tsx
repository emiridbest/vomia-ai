"use client";

/**
 * The Web3Auth config itself is what changes with the vault architecture:
 * what happens AFTER login is either
 *   (a) the user signing with this same Web3Auth-provided wallet
 *       (deposits, withdrawals, risk-profile changes — anything that needs
 *       the owner's signature), or
 *   (b) the agent's separate, low-privilege operator key acting within the
 *       on-chain limits the user set (trades) — see lib/vault/operatorSigner.ts.
 *
 * Nothing this file produces is ever sent to, or stored in, this app's own
 * backend/database.
 */
import { type CustomChainConfig, WEB3AUTH_NETWORK } from "@web3auth/modal";
import { type Web3AuthContextConfig } from "@web3auth/modal/react";
import { activeChain, celo, celoSepolia } from "../../lib/chains";

const clientId = process.env.NEXT_PUBLIC_WEB3AUTH_CLIENT_ID || "WEB3AUTH_CLIENT_ID";

function toChainConfig(chain: typeof celo | typeof celoSepolia): CustomChainConfig {
  return {
    chainNamespace: "eip155",
    chainId: `0x${chain.id.toString(16)}`,
    displayName: chain.name,
    rpcTarget: chain.rpcUrls.default.http[0],
    blockExplorerUrl: chain.blockExplorers?.default.url ?? "",
    ticker: chain.nativeCurrency.symbol,
    tickerName: chain.nativeCurrency.name,
    decimals: chain.nativeCurrency.decimals,
    isTestnet: "testnet" in chain ? Boolean(chain.testnet) : false,
    logo: "",
  };
}

const web3AuthContextConfig: Web3AuthContextConfig = {
  web3AuthOptions: {
    clientId,
    // SAPPHIRE_MAINNET is the network that does MPC/distributed key
    // generation across Web3Auth's node operators + this app + the user's
    // device. That's what makes "social login -> wallet" possible WITHOUT
    // any single party (including this app's backend) ever holding the
    // full private key. Keep this as SAPPHIRE_MAINNET, not a config this
    // app's server manages.
    web3AuthNetwork: WEB3AUTH_NETWORK.SAPPHIRE_MAINNET,
    useSFAKey: true,
    chains: [toChainConfig(celo), toChainConfig(celoSepolia)],
    defaultChainId: toChainConfig(activeChain()).chainId,
  },
};

export default web3AuthContextConfig;
