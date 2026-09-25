// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";

import {HoodLaunchHook} from "./HoodLaunchHook.sol";
import {HoodLocker} from "./HoodLocker.sol";
import {HoodRevenueSplitter} from "./HoodRevenueSplitter.sol";

/// @dev Holds the splitter's bytecode. Created by HoodDirectDeployer in its constructor, so the
///      splitter's creation code lives in this contract's runtime and not in the deployer's.
contract HoodSplitterDeployer {
    address public immutable owner;

    error NotOwner();

    constructor() {
        owner = msg.sender;
    }

    function deploy(address portal, address treasury, address buybackModule, address token, address quote, bytes32 salt)
        external
        returns (address)
    {
        if (msg.sender != owner) revert NotOwner();
        return address(new HoodRevenueSplitter{salt: salt}(portal, treasury, buybackModule, token, quote));
    }
}

/// @dev Holds the locker's bytecode, same arrangement.
contract HoodLockerDeployer {
    address public immutable owner;

    error NotOwner();

    constructor() {
        owner = msg.sender;
    }

    function deploy(
        address portal,
        address poolManager,
        address positionManager,
        address token,
        address quote,
        address splitter,
        bytes32 salt
    ) external returns (address) {
        if (msg.sender != owner) revert NotOwner();
        return address(new HoodLocker{salt: salt}(portal, poolManager, positionManager, token, quote, splitter));
    }
}

/// @title HoodDirectDeployer
/// @notice Holds the bytecode of a hook, hands the splitter and the locker to two helpers it
///         created, and clones tokens.
/// @dev Same reason as the curve side: a portal that inlines three `new` expressions carries three
///      creation codes in its own runtime code and stops fitting in an account. The hook's
///      creation code has grown to where this deployer cannot carry the other two beside it
///      either, so those live in helpers created here; only the hook is still deployed from this
///      address, which is the one that matters: a v4 hook's permissions live in the low bits of
///      its address, so the salt has to be mined against a deployer that never changes.
contract HoodDirectDeployer {
    address public portal;
    /// @dev Same rule as HoodDeployer: only the account that created this contract may wire it.
    address public immutable creator;
    HoodSplitterDeployer public immutable splitterDeployer;
    HoodLockerDeployer public immutable lockerDeployer;

    error AlreadyInitialized();
    error NotPortal();
    error NotCreator();

    constructor() {
        creator = msg.sender;
        splitterDeployer = new HoodSplitterDeployer();
        lockerDeployer = new HoodLockerDeployer();
    }

    function initialize(address portal_) external {
        if (msg.sender != creator) revert NotCreator();
        if (portal != address(0)) revert AlreadyInitialized();
        portal = portal_;
    }

    modifier onlyPortal() {
        if (msg.sender != portal) revert NotPortal();
        _;
    }

    function cloneToken(address implementation, bytes32 salt) external onlyPortal returns (address) {
        return Clones.cloneDeterministic(implementation, salt);
    }

    function deploySplitter(address treasury, address buybackModule, address token, address quote, bytes32 salt)
        external
        onlyPortal
        returns (address)
    {
        return splitterDeployer.deploy(portal, treasury, buybackModule, token, quote, salt);
    }

    function deployHook(address poolManager, bytes32 salt) external onlyPortal returns (address) {
        return address(new HoodLaunchHook{salt: salt}(IPoolManager(poolManager), portal));
    }

    function deployLocker(
        address poolManager,
        address positionManager,
        address token,
        address quote,
        address splitter,
        bytes32 salt
    ) external onlyPortal returns (address) {
        return lockerDeployer.deploy(portal, poolManager, positionManager, token, quote, splitter, salt);
    }

    /// @notice The address a creator's hook salt will produce. The portal binds every hook salt to
    ///         the creator (`keccak256(abi.encode(creator, salt))`) before CREATE2, so two people
    ///         mining from zero at the same moment never land on the same address, and nobody can
    ///         spend somebody else's salt by watching the mempool. The miner runs this off chain;
    ///         this is here so a caller can check the answer on chain before spending a launch on it.
    function hookAddressFor(address poolManager, address creator_, bytes32 salt) external view returns (address) {
        bytes32 initHash = keccak256(
            abi.encodePacked(type(HoodLaunchHook).creationCode, abi.encode(IPoolManager(poolManager), portal))
        );
        bytes32 bound = keccak256(abi.encode(creator_, salt));
        return address(uint160(uint256(keccak256(abi.encodePacked(bytes1(0xff), address(this), bound, initHash)))));
    }

    /// @notice The hash a miner needs. Mining is
    ///         `keccak256(0xff ++ deployer ++ keccak256(abi.encode(creator, salt)) ++ this)`.
    function hookInitCodeHash(address poolManager) external view returns (bytes32) {
        return keccak256(
            abi.encodePacked(type(HoodLaunchHook).creationCode, abi.encode(IPoolManager(poolManager), portal))
        );
    }
}
