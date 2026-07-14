"use client";

import { useWeb3AuthConnect, useWeb3AuthDisconnect, useWeb3AuthUser } from "@web3auth/modal/react";
import { useAccount } from "wagmi";

/**
 * The one place that turns a Web3Auth session into what the rest of the app
 * needs: the user's own wallet address (for on-chain reads/writes) and a
 * stable web3AuthSub (for the User record in lib/db/models.ts). Neither
 * value is ever generated or held server-side — both come straight out of
 * this client-side session.
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
