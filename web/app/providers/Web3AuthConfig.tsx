"use client";

/**
 * This is deliberately close to what you already had — the config itself
 * was fine. The only thing that changes with the vault architecture is
 * what happens AFTER login: instead of the app trying to take custody of
 * whatever wallet this produces, the address it produces becomes the
 * `owner` of the user's on-chain AgentVault (see app/api/vault/route.ts),
 * and everything after that is either:
 *   (a) the user signing with this same Web3Auth-provided wallet
 *       (deposits, withdrawals, risk-profile changes — anything that needs
 *       the owner's signature), or
 *   (b) the agent's separate, low-privilege operator key acting within the
 *       on-chain limits the user set (trades) — see lib/vault/operatorSigner.ts.
 *
 * Nothing this file produces is ever sent to, or stored in, this app's own
 * backend/database.
 */
import { CONNECTOR_INITIAL_AUTHENTICATION_MODE, WEB3AUTH_NETWORK } from "@web3auth/modal";
import { type Web3AuthContextConfig } from "@web3auth/modal/react";

const clientId = process.env.NEXT_PUBLIC_WEB3AUTH_CLIENT_ID || "WEB3AUTH_CLIENT_ID";

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
    initialAuthenticationMode: CONNECTOR_INITIAL_AUTHENTICATION_MODE.CONNECT_AND_SIGN,
  },
};

export default web3AuthContextConfig;
