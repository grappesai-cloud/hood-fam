// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {HookMiner} from "@uniswap/v4-periphery/src/utils/HookMiner.sol";

import {HoodGraduationHook} from "../../src/graduation/HoodGraduationHook.sol";

/// @dev One function, the shape of HoodDirectDeployer.deployHook: a CREATE2 deployer of our own,
///      for a chain that does not carry the deterministic-deployment proxy. The salt is mined
///      against THIS contract's address, and only the account that made it may use it.
contract HoodGraduationHookDeployer {
    address public immutable owner;

    error NotOwner();

    constructor() {
        owner = msg.sender;
    }

    function deploy(bytes32 salt, IPoolManager manager, address factory, address bag, address feeRouter)
        external
        returns (address)
    {
        if (msg.sender != owner) revert NotOwner();
        return address(new HoodGraduationHook{salt: salt}(manager, factory, bag, feeRouter));
    }
}

/// @notice Mines and deploys the graduation hook. Uniswap v4 keeps a hook's permissions in the
///         low fourteen bits of its address, so the salt is searched for at deploy time until the
///         address ends in 0xCC (beforeSwap, afterSwap and both return deltas), the same bits the
///         direct machine mines for every launch hook.
/// @dev Two roads to the same address rule. `forge script` routes `new X{salt: s}` through the
///      deterministic-deployment proxy at 0x4e59..., which is on 4663 (checked, the standard
///      bytecode) and which anvil carries at genesis, so the salt is mined against the proxy. On a
///      chain without it the CREATE2 happens inside a one-function deployer contract of ours, the
///      way HoodDirectDeployer does it, and the salt is mined against that contract instead.
library GraduationHookDeploy {
    address internal constant CREATE2_PROXY = 0x4e59b44847b379578588920cA78FbF26c0B4956C;
    uint160 internal constant FLAGS = 0xCC;

    function deploy(address poolManager, address factory, address bag, address feeRouter)
        internal
        returns (address hook)
    {
        bytes memory args = abi.encode(IPoolManager(poolManager), factory, bag, feeRouter);
        address predicted;
        if (CREATE2_PROXY.code.length != 0) {
            bytes32 salt;
            (predicted, salt) = HookMiner.find(CREATE2_PROXY, FLAGS, type(HoodGraduationHook).creationCode, args);
            hook = address(new HoodGraduationHook{salt: salt}(IPoolManager(poolManager), factory, bag, feeRouter));
        } else {
            HoodGraduationHookDeployer deployer = new HoodGraduationHookDeployer();
            bytes32 salt;
            (predicted, salt) = HookMiner.find(address(deployer), FLAGS, type(HoodGraduationHook).creationCode, args);
            hook = deployer.deploy(salt, IPoolManager(poolManager), factory, bag, feeRouter);
        }
        require(hook == predicted, "graduation hook landed off its mined address");
        require(uint160(hook) & 0x3FFF == FLAGS, "graduation hook address lacks the permission bits");
    }
}
