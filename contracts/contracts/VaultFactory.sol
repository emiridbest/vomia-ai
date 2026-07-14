// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";
import {AgentVault} from "./AgentVault.sol";

/// @title VaultFactory
/// @notice Deploys one cheap EIP-1167 minimal-proxy clone of AgentVault per
///         user (a few thousand gas instead of a full contract deploy — this
///         is what makes "one vault per user" viable at hackathon/live-demo
///         speed on Celo). Each user calls `createVault` once from their own
///         Web3Auth-controlled address, which becomes that vault's `owner`.
contract VaultFactory {
    address public immutable implementation;
    address public factoryOwner;
    address public defaultOperator; // the Vomia agent service's operator address

    mapping(address => address) public vaultOf; // user => their vault
    address[] public allVaults;

    event VaultCreated(address indexed user, address indexed vault, address operator);
    event DefaultOperatorUpdated(address indexed operator);

    error VaultAlreadyExists();
    error NotFactoryOwner();
    error ZeroAddress();

    constructor(address _implementation, address _defaultOperator) {
        if (_implementation == address(0)) revert ZeroAddress();
        implementation = _implementation;
        defaultOperator = _defaultOperator;
        factoryOwner = msg.sender;
    }

    /// @param operator pass address(0) to use the factory's `defaultOperator`
    ///        (the Vomia agent service), or a different address if the user
    ///        wants to point their vault at their own agent instance.
    function createVault(address operator) external returns (address vault) {
        if (vaultOf[msg.sender] != address(0)) revert VaultAlreadyExists();
        address chosenOperator = operator == address(0) ? defaultOperator : operator;

        vault = Clones.clone(implementation);
        AgentVault(vault).initialize(msg.sender, chosenOperator);

        vaultOf[msg.sender] = vault;
        allVaults.push(vault);
        emit VaultCreated(msg.sender, vault, chosenOperator);
    }

    function setDefaultOperator(address operator) external {
        if (msg.sender != factoryOwner) revert NotFactoryOwner();
        defaultOperator = operator;
        emit DefaultOperatorUpdated(operator);
    }

    function vaultCount() external view returns (uint256) {
        return allVaults.length;
    }
}
