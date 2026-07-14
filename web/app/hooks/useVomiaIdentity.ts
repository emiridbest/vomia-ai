"use client";

import { useWeb3AuthConnect, useWeb3AuthDisconnect, useWeb3AuthUser } from "@web3auth/modal/react";
import { useAccount } from "wagmi";

/**
 * The one place that turns a Web3Auth session into what the rest of the app
 * needs: the user's own wallet address (for on-chain reads/writes, and the
 * primary key for the User record in lib/db/models.ts) and, opportunistically,
 * a web3AuthSub. address comes from wagmi and is available as soon as
 * isConnected is true; web3AuthSub comes from an async getUserInfo() call
 * that can be slow or fail outright, so nothing in this app is allowed to
 * block on it — it's attached to records when available, never required.
 */
export function useVomiaIdentity() {
  const { connect, loading: connecting, isConnected } = useWeb3AuthConnect();
  const { disconnect, loading: disconnecting } = useWeb3AuthDisconnect();
  const { userInfo } = useWeb3AuthUser();
  const { address } = useAccount();

  return {
    isConnected,
    connecting,
    disconnecting,
    address,
    web3AuthSub: userInfo?.userId ?? null,
    connect,
    disconnect: () => disconnect(),
  };
}
