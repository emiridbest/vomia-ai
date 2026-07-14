import { ethers } from "hardhat";

async function main() {
  const [deployer] = await ethers.getSigners();
  console.log("Deploying with:", deployer.address);

  const operatorAddress = process.env.AGENT_OPERATOR_ADDRESS;
  if (!operatorAddress) {
    throw new Error(
      "Set AGENT_OPERATOR_ADDRESS in .env first — this is the agent service's " +
        "own low-privilege wallet address (see web/.env.example: AGENT_OPERATOR_ADDRESS). " +
        "It is NOT your personal wallet and NOT the deployer key."
    );
  }

  const AgentVault = await ethers.getContractFactory("AgentVault");
  const implementation = await AgentVault.deploy();
  await implementation.waitForDeployment();
  console.log("AgentVault implementation:", await implementation.getAddress());

  const VaultFactory = await ethers.getContractFactory("VaultFactory");
  const factory = await VaultFactory.deploy(await implementation.getAddress(), operatorAddress);
  await factory.waitForDeployment();
  console.log("VaultFactory:", await factory.getAddress());

  console.log("\nNext steps:");
  console.log("1. Put these two addresses into web/.env.local as NEXT_PUBLIC_VAULT_FACTORY_ADDRESS and VAULT_IMPLEMENTATION_ADDRESS.");
  console.log("2. Each user calls factory.createVault(0x0) once — from THEIR wallet — to get their own vault.");
  console.log("3. Get a security review before pointing this at mainnet with real user funds — see SECURITY.md.");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
