// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/// @dev Test-only stand-in for Mento's Broker / a Uniswap router. Swaps
/// tokenIn for tokenOut at a fixed rate the test sets, pulling tokenIn via
/// the allowance AgentVault grants it and pushing tokenOut back to the
/// caller (the vault). Not part of the deployment.
contract MockRouter {
    using SafeERC20 for IERC20;

    // rate is expressed as: amountOut = amountIn * rateNumerator / rateDenominator
    uint256 public rateNumerator = 1;
    uint256 public rateDenominator = 1;

    function setRate(uint256 numerator, uint256 denominator) external {
        rateNumerator = numerator;
        rateDenominator = denominator;
    }

    /// @dev Mirrors the shape of a real router call: pull tokenIn from
    /// msg.sender (the vault, which must have approved this contract),
    /// mint/transfer tokenOut back. In tests the router is pre-funded with
    /// tokenOut via MockERC20.mint.
    function swap(address tokenIn, address tokenOut, uint256 amountIn) external returns (uint256 amountOut) {
        IERC20(tokenIn).safeTransferFrom(msg.sender, address(this), amountIn);
        amountOut = (amountIn * rateNumerator) / rateDenominator;
        IERC20(tokenOut).safeTransfer(msg.sender, amountOut);
    }
}
