// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Initializable} from "@openzeppelin/contracts/proxy/utils/Initializable.sol";

/// @title AgentVault
/// @notice A single user's non-custodial vault. The user (`owner`) always
///         controls their funds outright. A separate, deliberately weak
///         `operator` key — held by the off-chain agent service, NOT the
///         user's real wallet key — may trigger swaps, but only:
///           1. between tokens the owner has allow-listed,
///           2. through router/broker contracts the owner has allow-listed,
///           3. under a per-trade cap and a rolling 24h cap the owner sets,
///           4. respecting a minimum-output the operator itself supplies
///              (the contract cannot compute "fair value" on its own; the
///              off-chain scanner is responsible for only ever submitting a
///              trade it believes is profitable — see SECURITY.md),
///           5. once per unique actionId (idempotent — a retried or replayed
///              off-chain call cannot double-execute).
///
///         Compromise of the operator key therefore cannot drain the vault —
///         its blast radius is bounded by whatever limits the owner set here.
///         Only the owner can withdraw, change those limits, or change the
///         operator. The owner can always pull all funds out, even while the
///         circuit breaker is tripped.
///
///         This contract is a clone target: deploy one implementation, then
///         use VaultFactory + OpenZeppelin Clones to create one cheap proxy
///         per user, each calling `initialize` exactly once.
contract AgentVault is Initializable {
    using SafeERC20 for IERC20;

    // ---------------------------------------------------------------------
    // Errors
    // ---------------------------------------------------------------------
    error NotOwner();
    error NotOperator();
    error NotOwnerOrOperator();
    error VaultPaused();
    error TokenNotAllowed(address token);
    error TargetNotAllowed(address target);
    error OverSingleTradeCap(uint256 requested, uint256 cap);
    error OverDailySpendCap(address token, uint256 requested, uint256 remaining);
    error SlippageExceeded(uint256 minOut, uint256 actualOut);
    error ActionAlreadyExecuted(bytes32 actionId);
    error ZeroAddress();
    error OutOfRange();
    error OperatorCannotUnpause();
    error Reentrancy();

    // ---------------------------------------------------------------------
    // Events — every one of these is also what the "live feed" / attribution
    // layer in the web app reads back to show a human-readable trail.
    // ---------------------------------------------------------------------
    event Deposited(address indexed token, uint256 amount, address indexed from);
    event Withdrawn(address indexed token, uint256 amount, address indexed to);
    event EmergencyWithdrawAll(address indexed token, uint256 amount);
    event OperatorUpdated(address indexed operator);
    event PauseStateChanged(bool paused, address indexed by);
    event TokenPolicyUpdated(address indexed token, bool allowed, uint256 maxSingleTrade, uint256 dailyCap);
    event TargetAllowlisted(address indexed target, bool allowed);
    event RiskParamsUpdated(uint256 maxSlippageBps, uint256 minProfitBpsHint);
    event AgentAction(
        bytes32 indexed actionId,
        address indexed tokenIn,
        address indexed tokenOut,
        uint256 amountIn,
        uint256 amountOut,
        address target
    );

    // ---------------------------------------------------------------------
    // Storage
    // ---------------------------------------------------------------------
    address public owner; // the end user's Web3Auth-controlled address — the only address that can ever move funds out
    address public operator; // the agent service's scoped hot key — can only call executeSwap, within limits below
    bool public paused; // circuit breaker

    /// @dev Informational only — the contract has no price oracle and cannot
    ///      verify a trade was actually profitable. The off-chain scanner is
    ///      expected to only submit trades that clear this margin; the
    ///      contract enforces `minAmountOut` (slippage) and the caps below,
    ///      which is everything it *can* verify on-chain.
    uint256 public minProfitBpsHint;
    uint256 public maxSlippageBps = 100; // 1% default

    mapping(address => bool) public allowedTokens;
    mapping(address => bool) public allowedTargets; // e.g. Mento Broker, Uniswap Router, Squid/LiFi entrypoint

    mapping(address => uint256) public maxSingleTrade; // per token, in that token's own decimals
    mapping(address => uint256) public dailyCap; // per token, in that token's own decimals
    mapping(address => uint256) public spentToday; // per token, resets on rolling 24h window
    mapping(address => uint256) public windowStart; // per token, start of current 24h window

    mapping(bytes32 => bool) public executedActions; // idempotency guard

    uint256 private _locked; // simple reentrancy guard (avoids pulling in the upgradeable OZ package just for this)

    // ---------------------------------------------------------------------
    // Modifiers
    // ---------------------------------------------------------------------
    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    modifier onlyOperator() {
        if (msg.sender != operator) revert NotOperator();
        _;
    }

    modifier onlyOwnerOrOperator() {
        if (msg.sender != owner && msg.sender != operator) revert NotOwnerOrOperator();
        _;
    }

    modifier whenNotPaused() {
        if (paused) revert VaultPaused();
        _;
    }

    modifier nonReentrant() {
        if (_locked == 1) revert Reentrancy();
        _locked = 1;
        _;
        _locked = 0;
    }

    /// @notice Called once by VaultFactory immediately after cloning.
    function initialize(address _owner, address _operator) external initializer {
        if (_owner == address(0)) revert ZeroAddress();
        owner = _owner;
        operator = _operator;
        emit OperatorUpdated(_operator);
    }

    // ---------------------------------------------------------------------
    // Owner actions
    // ---------------------------------------------------------------------

    /// @notice Deposit an allow-listed token into the vault. Anyone can call
    ///         this on the owner's behalf (e.g. a relayer), but only the
    ///         owner can ever take funds back out.
    function deposit(address token, uint256 amount) external nonReentrant {
        if (!allowedTokens[token]) revert TokenNotAllowed(token);
        IERC20(token).safeTransferFrom(msg.sender, address(this), amount);
        emit Deposited(token, amount, msg.sender);
    }

    function withdraw(address token, uint256 amount, address to) external onlyOwner nonReentrant {
        if (to == address(0)) revert ZeroAddress();
        IERC20(token).safeTransfer(to, amount);
        emit Withdrawn(token, amount, to);
    }

    /// @notice Escape hatch. Works even while `paused` — the circuit breaker
    ///         protects against the operator/agent, never against the owner
    ///         getting their own money back.
    function emergencyWithdrawAll(address token) external onlyOwner nonReentrant {
        uint256 bal = IERC20(token).balanceOf(address(this));
        if (bal > 0) IERC20(token).safeTransfer(owner, bal);
        emit EmergencyWithdrawAll(token, bal);
    }

    function setOperator(address newOperator) external onlyOwner {
        operator = newOperator;
        emit OperatorUpdated(newOperator);
    }

    /// @notice The operator MAY trip the breaker on itself (e.g. its own
    ///         anomaly check fires), but only the owner may lift it — an
    ///         agent that decides to pause can never be the one to un-pause.
    function setPaused(bool newPaused) external onlyOwnerOrOperator {
        if (msg.sender == operator && !newPaused) revert OperatorCannotUnpause();
        paused = newPaused;
        emit PauseStateChanged(newPaused, msg.sender);
    }

    /// @param token the token this policy applies to
    /// @param allowed whether the operator may trade this token at all
    /// @param maxSingleTradeAmount cap per individual executeSwap call, in token units
    /// @param dailyCapAmount cap across a rolling 24h window, in token units
    function setTokenPolicy(
        address token,
        bool allowed,
        uint256 maxSingleTradeAmount,
        uint256 dailyCapAmount
    ) external onlyOwner {
        if (token == address(0)) revert ZeroAddress();
        allowedTokens[token] = allowed;
        maxSingleTrade[token] = maxSingleTradeAmount;
        dailyCap[token] = dailyCapAmount;
        emit TokenPolicyUpdated(token, allowed, maxSingleTradeAmount, dailyCapAmount);
    }

    function setTargetAllowed(address target, bool allowed) external onlyOwner {
        if (target == address(0)) revert ZeroAddress();
        allowedTargets[target] = allowed;
        emit TargetAllowlisted(target, allowed);
    }

    function setRiskParams(uint256 _maxSlippageBps, uint256 _minProfitBpsHint) external onlyOwner {
        if (_maxSlippageBps > 2000) revert OutOfRange(); // hard ceiling: owner can't accidentally allow >20% slippage
        maxSlippageBps = _maxSlippageBps;
        minProfitBpsHint = _minProfitBpsHint;
        emit RiskParamsUpdated(_maxSlippageBps, _minProfitBpsHint);
    }

    // ---------------------------------------------------------------------
    // Operator action — the ONLY privileged call the agent's server-side key
    // can ever make. Everything here is enforced on-chain, not "trusted".
    // ---------------------------------------------------------------------

    /// @param actionId unique id the off-chain agent generates per intended trade (idempotency key)
    /// @param tokenIn token being sold out of the vault
    /// @param tokenOut token expected back into the vault
    /// @param amountIn amount of tokenIn to send to `target`
    /// @param minAmountOut minimum tokenOut the operator will accept — the operator
    ///        (off-chain) is responsible for deriving this from a live quote minus
    ///        `maxSlippageBps`; the contract just enforces whatever value is passed
    ///        is actually met.
    /// @param target the allow-listed router/broker contract to call
    /// @param callData ABI-encoded calldata for the swap call on `target`
    function executeSwap(
        bytes32 actionId,
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 minAmountOut,
        address target,
        bytes calldata callData
    ) external onlyOperator whenNotPaused nonReentrant returns (uint256 amountOut) {
        if (executedActions[actionId]) revert ActionAlreadyExecuted(actionId);
        executedActions[actionId] = true;

        if (!allowedTokens[tokenIn]) revert TokenNotAllowed(tokenIn);
        if (!allowedTokens[tokenOut]) revert TokenNotAllowed(tokenOut);
        if (!allowedTargets[target]) revert TargetNotAllowed(target);

        if (amountIn > maxSingleTrade[tokenIn]) {
            revert OverSingleTradeCap(amountIn, maxSingleTrade[tokenIn]);
        }

        _rollWindowIfNeeded(tokenIn);
        uint256 remaining = dailyCap[tokenIn] > spentToday[tokenIn]
            ? dailyCap[tokenIn] - spentToday[tokenIn]
            : 0;
        if (amountIn > remaining) revert OverDailySpendCap(tokenIn, amountIn, remaining);
        spentToday[tokenIn] += amountIn;

        uint256 outBalBefore = IERC20(tokenOut).balanceOf(address(this));

        IERC20(tokenIn).forceApprove(target, amountIn);
        (bool ok, bytes memory ret) = target.call(callData);
        if (!ok) {
            // bubble up the revert reason from the router for easier debugging
            if (ret.length > 0) {
                assembly {
                    revert(add(ret, 32), mload(ret))
                }
            }
            revert("SWAP_CALL_FAILED");
        }
        IERC20(tokenIn).forceApprove(target, 0);

        uint256 outBalAfter = IERC20(tokenOut).balanceOf(address(this));
        amountOut = outBalAfter - outBalBefore;

        if (amountOut < minAmountOut) revert SlippageExceeded(minAmountOut, amountOut);

        emit AgentAction(actionId, tokenIn, tokenOut, amountIn, amountOut, target);
    }

    function _rollWindowIfNeeded(address token) internal {
        if (block.timestamp >= windowStart[token] + 1 days) {
            windowStart[token] = block.timestamp;
            spentToday[token] = 0;
        }
    }

    // ---------------------------------------------------------------------
    // Views
    // ---------------------------------------------------------------------

    function remainingDailyAllowance(address token) external view returns (uint256) {
        if (block.timestamp >= windowStart[token] + 1 days) return dailyCap[token];
        if (spentToday[token] >= dailyCap[token]) return 0;
        return dailyCap[token] - spentToday[token];
    }

    function tokenBalance(address token) external view returns (uint256) {
        return IERC20(token).balanceOf(address(this));
    }
}
