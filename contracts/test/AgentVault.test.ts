import { expect } from "chai";
import { ethers } from "hardhat";
import { AgentVault, VaultFactory, MockERC20, MockRouter } from "../typechain-types";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

describe("AgentVault", function () {
  let owner: HardhatEthersSigner;
  let operator: HardhatEthersSigner;
  let stranger: HardhatEthersSigner;

  let factory: VaultFactory;
  let vault: AgentVault;
  let tokenIn: MockERC20;
  let tokenOut: MockERC20;
  let router: MockRouter;

  const ONE = ethers.parseUnits("1", 18);

  beforeEach(async () => {
    [owner, operator, stranger] = await ethers.getSigners();

    const AgentVaultFactory = await ethers.getContractFactory("AgentVault");
    const implementation = await AgentVaultFactory.deploy();
    await implementation.waitForDeployment();

    const VaultFactoryFactory = await ethers.getContractFactory("VaultFactory");
    factory = await VaultFactoryFactory.deploy(await implementation.getAddress(), operator.address);
    await factory.waitForDeployment();

    // owner creates their vault, using the factory's default operator
    const tx = await factory.connect(owner).createVault(ethers.ZeroAddress);
    await tx.wait();
    const vaultAddress = await factory.vaultOf(owner.address);
    vault = AgentVaultFactory.attach(vaultAddress) as AgentVault;

    const MockERC20Factory = await ethers.getContractFactory("MockERC20");
    tokenIn = (await MockERC20Factory.deploy("Mento Dollar", "USDm")) as MockERC20;
    tokenOut = (await MockERC20Factory.deploy("Mento Kenyan Shilling", "KESm")) as MockERC20;
    await tokenIn.waitForDeployment();
    await tokenOut.waitForDeployment();

    const MockRouterFactory = await ethers.getContractFactory("MockRouter");
    router = (await MockRouterFactory.deploy()) as MockRouter;
    await router.waitForDeployment();
    await router.setRate(129, 1); // 1 USDm -> 129 KESm, matching the real-world quote order of magnitude

    // fund owner with tokenIn, fund router with tokenOut so it can pay out swaps
    await tokenIn.mint(owner.address, ethers.parseUnits("1000", 18));
    await tokenOut.mint(await router.getAddress(), ethers.parseUnits("1000000", 18));

    // owner allow-lists both tokens + the router, deposits, sets caps
    await vault.connect(owner).setTokenPolicy(await tokenIn.getAddress(), true, ethers.parseUnits("50", 18), ethers.parseUnits("200", 18));
    await vault.connect(owner).setTokenPolicy(await tokenOut.getAddress(), true, ethers.parseUnits("50000", 18), ethers.parseUnits("200000", 18));
    await vault.connect(owner).setTargetAllowed(await router.getAddress(), true);

    await tokenIn.connect(owner).approve(await vault.getAddress(), ethers.parseUnits("1000", 18));
    await vault.connect(owner).deposit(await tokenIn.getAddress(), ethers.parseUnits("500", 18));
  });

  it("sets owner and operator correctly on init", async () => {
    expect(await vault.owner()).to.equal(owner.address);
    expect(await vault.operator()).to.equal(operator.address);
  });

  it("lets the owner deposit and withdraw freely", async () => {
    const balBefore = await tokenIn.balanceOf(owner.address);
    await vault.connect(owner).withdraw(await tokenIn.getAddress(), ethers.parseUnits("10", 18), owner.address);
    const balAfter = await tokenIn.balanceOf(owner.address);
    expect(balAfter - balBefore).to.equal(ethers.parseUnits("10", 18));
  });

  it("blocks withdrawal from anyone but the owner", async () => {
    await expect(
      vault.connect(stranger).withdraw(await tokenIn.getAddress(), 1, stranger.address)
    ).to.be.revertedWithCustomError(vault, "NotOwner");
  });

  it("lets the operator execute a swap within caps", async () => {
    const amountIn = ethers.parseUnits("20", 18); // under the 50-token single-trade cap
    const expectedOut = ethers.parseUnits("20", 18) * 129n;
    const minOut = (expectedOut * 99n) / 100n; // 1% slippage tolerance

    const iface = new ethers.Interface(["function swap(address,address,uint256) returns (uint256)"]);
    const callData = iface.encodeFunctionData("swap", [await tokenIn.getAddress(), await tokenOut.getAddress(), amountIn]);

    const actionId = ethers.id("action-1");
    await expect(
      vault
        .connect(operator)
        .executeSwap(actionId, await tokenIn.getAddress(), await tokenOut.getAddress(), amountIn, minOut, await router.getAddress(), callData)
    ).to.emit(vault, "AgentAction");

    expect(await tokenOut.balanceOf(await vault.getAddress())).to.equal(expectedOut);
  });

  it("rejects a trade over the single-trade cap", async () => {
    const amountIn = ethers.parseUnits("51", 18); // cap is 50
    const iface = new ethers.Interface(["function swap(address,address,uint256) returns (uint256)"]);
    const callData = iface.encodeFunctionData("swap", [await tokenIn.getAddress(), await tokenOut.getAddress(), amountIn]);

    await expect(
      vault
        .connect(operator)
        .executeSwap(ethers.id("action-cap"), await tokenIn.getAddress(), await tokenOut.getAddress(), amountIn, 0, await router.getAddress(), callData)
    ).to.be.revertedWithCustomError(vault, "OverSingleTradeCap");
  });

  it("rejects cumulative trades once the rolling daily cap is exceeded", async () => {
    const iface = new ethers.Interface(["function swap(address,address,uint256) returns (uint256)"]);
    const amountIn = ethers.parseUnits("50", 18); // exactly at single-trade cap, under daily cap of 200

    for (let i = 0; i < 4; i++) {
      const callData = iface.encodeFunctionData("swap", [await tokenIn.getAddress(), await tokenOut.getAddress(), amountIn]);
      await vault
        .connect(operator)
        .executeSwap(ethers.id(`daily-${i}`), await tokenIn.getAddress(), await tokenOut.getAddress(), amountIn, 0, await router.getAddress(), callData);
    }
    // 4 * 50 = 200 == the full daily cap already spent; a 5th trade of any size should revert
    const callData5 = iface.encodeFunctionData("swap", [await tokenIn.getAddress(), await tokenOut.getAddress(), amountIn]);
    await expect(
      vault
        .connect(operator)
        .executeSwap(ethers.id("daily-5"), await tokenIn.getAddress(), await tokenOut.getAddress(), amountIn, 0, await router.getAddress(), callData5)
    ).to.be.revertedWithCustomError(vault, "OverDailySpendCap");
  });

  it("rejects a target that isn't allow-listed", async () => {
    const MockRouterFactory = await ethers.getContractFactory("MockRouter");
    const rogueRouter = await MockRouterFactory.deploy();
    await rogueRouter.waitForDeployment();

    const iface = new ethers.Interface(["function swap(address,address,uint256) returns (uint256)"]);
    const callData = iface.encodeFunctionData("swap", [await tokenIn.getAddress(), await tokenOut.getAddress(), ONE]);

    await expect(
      vault
        .connect(operator)
        .executeSwap(ethers.id("rogue"), await tokenIn.getAddress(), await tokenOut.getAddress(), ONE, 0, await rogueRouter.getAddress(), callData)
    ).to.be.revertedWithCustomError(vault, "TargetNotAllowed");
  });

  it("refuses to execute the same actionId twice (idempotency)", async () => {
    const amountIn = ethers.parseUnits("5", 18);
    const iface = new ethers.Interface(["function swap(address,address,uint256) returns (uint256)"]);
    const callData = iface.encodeFunctionData("swap", [await tokenIn.getAddress(), await tokenOut.getAddress(), amountIn]);
    const actionId = ethers.id("replay-me");

    await vault
      .connect(operator)
      .executeSwap(actionId, await tokenIn.getAddress(), await tokenOut.getAddress(), amountIn, 0, await router.getAddress(), callData);

    await expect(
      vault
        .connect(operator)
        .executeSwap(actionId, await tokenIn.getAddress(), await tokenOut.getAddress(), amountIn, 0, await router.getAddress(), callData)
    ).to.be.revertedWithCustomError(vault, "ActionAlreadyExecuted");
  });

  it("blocks the operator from trading while paused, but the owner can always emergency-withdraw", async () => {
    await vault.connect(owner).setPaused(true);

    const iface = new ethers.Interface(["function swap(address,address,uint256) returns (uint256)"]);
    const callData = iface.encodeFunctionData("swap", [await tokenIn.getAddress(), await tokenOut.getAddress(), ONE]);
    await expect(
      vault.connect(operator).executeSwap(ethers.id("while-paused"), await tokenIn.getAddress(), await tokenOut.getAddress(), ONE, 0, await router.getAddress(), callData)
    ).to.be.revertedWithCustomError(vault, "VaultPaused");

    // owner's escape hatch still works while paused
    const balBefore = await tokenIn.balanceOf(owner.address);
    await vault.connect(owner).emergencyWithdrawAll(await tokenIn.getAddress());
    const balAfter = await tokenIn.balanceOf(owner.address);
    expect(balAfter).to.be.greaterThan(balBefore);
  });

  it("lets the operator trip the breaker but never lift it", async () => {
    await vault.connect(operator).setPaused(true);
    expect(await vault.paused()).to.equal(true);

    await expect(vault.connect(operator).setPaused(false)).to.be.revertedWithCustomError(vault, "OperatorCannotUnpause");

    await vault.connect(owner).setPaused(false);
    expect(await vault.paused()).to.equal(false);
  });

  it("blocks a random address from ever calling executeSwap", async () => {
    const iface = new ethers.Interface(["function swap(address,address,uint256) returns (uint256)"]);
    const callData = iface.encodeFunctionData("swap", [await tokenIn.getAddress(), await tokenOut.getAddress(), ONE]);
    await expect(
      vault.connect(stranger).executeSwap(ethers.id("stranger"), await tokenIn.getAddress(), await tokenOut.getAddress(), ONE, 0, await router.getAddress(), callData)
    ).to.be.revertedWithCustomError(vault, "NotOperator");
  });
});
