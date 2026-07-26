"use client";

import { useVomiaIdentity } from "../hooks/useVomiaIdentity";
import { useIsMiniPay } from "../hooks/useMiniPay";

export default function ConnectWalletButton() {
  const { isConnected, connecting, disconnecting, address, connect, disconnect } = useVomiaIdentity();
  const isMiniPay = useIsMiniPay();

  if (isConnected && address) {
    // In MiniPay the wallet is the user's implicit MiniPay account — show it,
    // but no "log out" (disconnecting the injected provider isn't meaningful).
    if (isMiniPay) {
      return <span className="btn btn-ghost" aria-disabled>{`${address.slice(0, 6)}…${address.slice(-4)}`}</span>;
    }
    return (
      <button className="btn btn-ghost" onClick={disconnect} disabled={disconnecting}>
        {disconnecting ? "Logging out…" : `${address.slice(0, 6)}…${address.slice(-4)}`}
      </button>
    );
  }

  // Inside MiniPay the connection is implicit (auto-connecting the injected
  // wallet) — per the MiniPay docs, hide the Connect button entirely.
  if (isMiniPay) return null;

  return (
    <button className="btn btn-primary" onClick={() => connect()} disabled={connecting}>
      {connecting ? "Connecting…" : "Connect wallet"}
    </button>
  );
}
