import { HardhatUserConfig } from "hardhat/config";
import "@nomicfoundation/hardhat-toolbox";
import * as dotenv from "dotenv";

dotenv.config();

// Deployer key for CONTRACT DEPLOYMENT ONLY (not the agent operator key, not any
// user key). Keep this in .env, never commit it. A throwaway deployer wallet
// funded with a small amount of CELO for gas is enough.
const DEPLOYER_KEY = process.env.DEPLOYER_PRIVATE_KEY || "0x" + "11".repeat(32);

const config: HardhatUserConfig = {
  solidity: {
    version: "0.8.24",
    settings: {
      optimizer: { enabled: true, runs: 200 },
    },
  },
  networks: {
    hardhat: {
      // local in-memory chain used by `hardhat test` — no external RPC needed
    },
    celo: {
      url: process.env.CELO_RPC_URL || "https://forno.celo.org",
      chainId: 42220,
      accounts: [DEPLOYER_KEY],
    },
    // Celo's current public testnet (replaced Alfajores in the docs' token list;
    // kept the alias since most existing tooling/tutorials still say "alfajores")
    alfajores: {
      url: process.env.CELO_SEPOLIA_RPC_URL || "https://forno.celo-sepolia.celo-testnet.org",
      chainId: 11142220,
      accounts: [DEPLOYER_KEY],
    },
  },
  etherscan: {
    // Etherscan v2 unified API key — one key covers every supported chain,
    // including Celo/Celoscan. Needed only for `hardhat verify`, never for
    // deploys. (The old per-explorer v1 endpoints were retired mid-2025;
    // this hardhat-verify version doesn't know chainId 42220 natively, so
    // the v2 endpoint is wired up via customChains with the chainid param.)
    apiKey: {
      celo: process.env.CELOSCAN_API_KEY || "",
    },
    customChains: [
      {
        network: "celo",
        chainId: 42220,
        urls: { apiURL: "https://api.etherscan.io/v2/api?chainid=42220", browserURL: "https://celoscan.io" },
      },
    ],
  },
  // Sourcify verification needs no API key and is read by Blockscout's Celo
  // explorer — a useful fallback when the Etherscan v2 endpoint is flaky.
  sourcify: {
    enabled: true,
  },
};

export default config;
