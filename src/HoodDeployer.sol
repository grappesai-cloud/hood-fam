// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {HoodToken} from "./HoodToken.sol";
import {HoodCurve} from "./HoodCurve.sol";
import {HoodPot} from "./bag/HoodPot.sol";

/// @title HoodPotDeployer
/// @notice Holds the bytecode of a pot, and nothing else. Printed by HoodDeployer's constructor.
/// @dev With the pot inlined next to the token and the curve, HoodDeployer came out 24,159 bytes:
///      417 under the limit with a stub pot, and over it with the real one. Creation code counts
///      against the 24,576 of the contract that carries it, not of the one whose constructor runs
///      it, so this child holds the pot and the parent holds a call.
contract HoodPotDeployer {
    address public immutable parent;

    error NotParent();

    constructor() {
        parent = msg.sender;
    }

    function deployPot(address factory, address token, address pair) external returns (address) {
        if (msg.sender != parent) revert NotParent();
        return address(new HoodPot(factory, token, pair));
    }
}

/// @title HoodDeployer
/// @notice Holds the bytecode of a token and of a curve, and the child that holds the pot's.
/// @dev A factory that inlines `new Token()` and `new Curve()` carries both creation codes in its
///      own runtime code. Ours came out 27,037 bytes, which is 2,461 over the 24,576 an account is
///      allowed to hold, so it could not be deployed at all. Measured, not guessed: `forge build
///      --sizes`. Moving the `new` expressions here keeps the factory deployable and changes
///      nothing about what gets deployed. The pot's creation code lives one hop further, in
///      HoodPotDeployer, for the same reason.
contract HoodDeployer {
    address public factory;
    /// @dev The account that created this contract is the only one allowed to wire it. A
    ///      first-caller-wins initializer would leave a window between two deployment transactions
    ///      in which a stranger could name themselves the factory.
    address public immutable creator;
    HoodPotDeployer public immutable potDeployer;

    error AlreadyInitialized();
    error NotFactory();
    error NotCreator();

    constructor() {
        creator = msg.sender;
        potDeployer = new HoodPotDeployer();
    }

    function initialize(address factory_) external {
        if (msg.sender != creator) revert NotCreator();
        if (factory != address(0)) revert AlreadyInitialized();
        factory = factory_;
    }

    modifier onlyFactory() {
        if (msg.sender != factory) revert NotFactory();
        _;
    }

    function deployToken(
        string calldata name,
        string calldata symbol,
        string calldata image,
        string calldata description,
        uint256 supply,
        address mintTo,
        bytes32 salt
    ) external onlyFactory returns (address) {
        // The token's factory is the launchpad, not this contract: it is the launchpad that names
        // the pot afterwards.
        return address(new HoodToken{salt: salt}(name, symbol, image, description, supply, mintTo, factory));
    }

    function deployCurve(HoodCurve.InitParams calldata params, bytes32 salt)
        external
        onlyFactory
        returns (address)
    {
        return address(new HoodCurve{salt: salt}(params));
    }

    /// @notice Prints the launch's pot: the accumulator that pays `token`'s holders in `pair`.
    /// @dev Plain CREATE. Nobody picks a vanity address for a pot, and the token and the pot cannot
    ///      both be predicted from each other anyway (each one's constructor wants the other).
    function deployPot(address factory_, address token, address pair) external onlyFactory returns (address) {
        return potDeployer.deployPot(factory_, token, pair);
    }
}
