"use client";

import { useVomiaIdentity } from "../hooks/useVomiaIdentity";

export default function ConnectWalletButton() {
  const { isConnected, connecting, disconnecting, address, connect, disconnect } = useVomiaIdentity();

  if (isConnected && address) {
    return (
      <button className="btn btn-ghost" onClick={disconnect} disabled={disconnecting}>
        {disconnecting ? "Logging out…" : `${address.slice(0, 6)}…${address.slice(-4)}`}
      </button>
    );
  }

  return (
    <button className="btn btn-primary" onClick={() => connect()} disabled={connecting}>
      {connecting ? "Connecting…" : "Connect wallet"}
    </button>
  );
}
