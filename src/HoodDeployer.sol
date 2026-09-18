// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {HoodToken} from "./HoodToken.sol";
import {HoodCurve} from "./HoodCurve.sol";

/// @title HoodDeployer
/// @notice Holds the bytecode of a token and of a curve, and nothing else.
/// @dev A factory that inlines `new Token()` and `new Curve()` carries both creation codes in its
///      own runtime code. Ours came out 27,037 bytes, which is 2,461 over the 24,576 an account is
///      allowed to hold, so it could not be deployed at all. Measured, not guessed: `forge build
///      --sizes`. Moving the two `new` expressions here keeps the factory deployable and changes
///      nothing about what gets deployed.
contract HoodDeployer {
    address public factory;
    /// @dev The account that created this contract is the only one allowed to wire it. A
    ///      first-caller-wins initializer would leave a window between two deployment transactions
    ///      in which a stranger could name themselves the factory.
    address public immutable creator;

    error AlreadyInitialized();
    error NotFactory();
    error NotCreator();

    constructor() {
        creator = msg.sender;
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
        return address(new HoodToken{salt: salt}(name, symbol, image, description, supply, mintTo));
    }

    function deployCurve(HoodCurve.InitParams calldata params, bytes32 salt)
        external
        onlyFactory
        returns (address)
    {
        return address(new HoodCurve{salt: salt}(params));
    }
}
