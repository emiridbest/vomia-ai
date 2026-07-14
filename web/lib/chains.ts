import { defineChain } from "viem";
import { celo } from "viem/chains";

export { celo };

/** Celo's public testnet (the docs' token list now calls it "Celo Sepolia"). */
export const celoSepolia = defineChain({
  id: 11142220,
  name: "Celo Sepolia",
  nativeCurrency: { name: "CELO", symbol: "CELO", decimals: 18 },
  rpcUrls: {
    default: { http: [process.env.CELO_SEPOLIA_RPC_URL || "https://forno.celo-sepolia.celo-testnet.org"] },
  },
  blockExplorers: {
    default: { name: "Celo Sepolia Explorer", url: "https://celo-sepolia.blockscout.com" },
  },
  testnet: true,
});

export function activeChain() {
  return process.env.NEXT_PUBLIC_NETWORK === "testnet" ? celoSepolia : celo;
}

export function rpcUrl() {
  return process.env.NEXT_PUBLIC_NETWORK === "testnet"
    ? process.env.CELO_SEPOLIA_RPC_URL || "https://forno.celo-sepolia.celo-testnet.org"
    : process.env.CELO_RPC_URL || "https://forno.celo.org";
}
