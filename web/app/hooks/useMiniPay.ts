"use client";

import { useEffect, useRef, useState } from "react";
import { useAccount, useConnect } from "wagmi";

/**
 * MiniPay compatibility.
 *
 * Inside MiniPay's in-app browser the wallet is INJECTED (window.ethereum
 * with isMiniPay === true) and the connection is implicit — the user has
 * already unlocked their wallet, so there is no wallet-picker and no
 * "Connect" step (per docs.celo.org/build-on-celo/build-on-minipay). Web3Auth
 * social login (popups/redirects) does not work in that webview, so the
 * injected provider is the only path there. Outside MiniPay this all no-ops
 * and the normal Web3Auth flow is untouched.
 */

/** True only when running inside the MiniPay in-app browser. SSR-safe. */
export function useIsMiniPay(): boolean {
  const [isMiniPay, setIsMiniPay] = useState(false);
  useEffect(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    if (typeof window !== "undefined" && (window as any).ethereum?.isMiniPay === true) {
      setIsMiniPay(true);
    }
  }, []);
  return isMiniPay;
}

/**
 * When inside MiniPay and not yet connected, auto-connect the injected
 * provider (wagmi discovers MiniPay's announced/injected provider as a
 * connector). Best-effort and tried once; if no injected connector is
 * present it simply does nothing.
 */
export function useMiniPayAutoConnect(): void {
  const isMiniPay = useIsMiniPay();
  const { isConnected } = useAccount();
  const { connect, connectors } = useConnect();
  const tried = useRef(false);

  useEffect(() => {
    if (!isMiniPay || isConnected || tried.current) return;
    const injected = connectors.find(
      (c) => c.type === "injected" || c.id === "injected" || /minipay|injected/i.test(c.name)
    );
    if (injected) {
      tried.current = true;
      connect({ connector: injected });
    }
  }, [isMiniPay, isConnected, connectors, connect]);
}
