/**
 * The agent's operator signer.
 *
 * This is the ONE private key this backend ever holds. It is:
 *   - NOT any user's wallet key (those live in Web3Auth's MPC network + the
 *     user's device — this backend never sees them).
 *   - Shared across all users' vaults (every AgentVault points its
 *     `operator` at this same address, or the factory's `defaultOperator`).
 *   - Deliberately powerless on its own: it can only call
 *     `AgentVault.executeSwap`, and only within the per-token caps and
 *     allow-lists each user set on their own vault. Even a full compromise
 *     of this key cannot move funds anywhere the vault contract doesn't
 *     permit, and cannot touch a vault whose owner never allow-listed a
 *     token/target/cap in the first place.
 *
 * Hackathon-speed setup: this key comes from an environment variable,
 * decrypted at process start. That is the minimum viable version of "don't
 * put it in Mongo" — it's still a plaintext env var on one machine.
 *
 * BEFORE THIS TOUCHES REAL USER FUNDS: replace `loadOperatorAccount` below
 * with a call to a real key-management service instead of reading
 * AGENT_OPERATOR_PRIVATE_KEY directly — e.g. AWS KMS / GCP KMS (sign via
 * API, key material never leaves the HSM), or a wallet-as-a-service
 * provider built for exactly this (Turnkey, Privy server wallets, Fireblocks).
 * Because the operator key is low-privilege by design, this upgrade is
 * strictly a hardening step, not a redesign — the vault contract doesn't
 * change at all.
 */
import { createWalletClient, http, type WalletClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { activeChain, rpcUrl } from "../chains";

let cachedClient: WalletClient | null = null;

export function operatorAddress(): `0x${string}` {
  const key = requireKey();
  return privateKeyToAccount(key).address;
}

export function getOperatorWalletClient(): WalletClient {
  if (cachedClient) return cachedClient;
  const key = requireKey();
  const account = privateKeyToAccount(key);
  cachedClient = createWalletClient({
    account,
    chain: activeChain(),
    transport: http(rpcUrl()),
  });
  return cachedClient;
}

function requireKey(): `0x${string}` {
  const key = process.env.AGENT_OPERATOR_PRIVATE_KEY;
  if (!key) {
    throw new Error(
      "AGENT_OPERATOR_PRIVATE_KEY is not set. Generate a fresh throwaway key for the " +
        "agent service (NOT a personal wallet), fund it with a small amount of CELO for " +
        "gas, and set its address as AGENT_OPERATOR_ADDRESS when deploying VaultFactory. " +
        "This key only pays gas and calls executeSwap — see this file's header comment."
    );
  }
  return key as `0x${string}`;
}
