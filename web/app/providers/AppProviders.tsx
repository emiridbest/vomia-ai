"use client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Web3AuthProvider } from "@web3auth/modal/react";
import { WagmiProvider } from "@web3auth/modal/react/wagmi";
import { useState } from "react";
import web3AuthContextConfig from "./Web3AuthConfig";
import MiniPayAutoConnect from "./MiniPayAutoConnect";

export default function AppProviders({ children }: { children: React.ReactNode }) {
  const [queryClient] = useState(() => new QueryClient());

  return (
    <Web3AuthProvider config={web3AuthContextConfig}>
      <QueryClientProvider client={queryClient}>
        <WagmiProvider>
          {/* Auto-connects MiniPay's injected wallet when in the MiniPay app; no-op elsewhere. */}
          <MiniPayAutoConnect />
          {children}
        </WagmiProvider>
      </QueryClientProvider>
    </Web3AuthProvider>
  );
}
