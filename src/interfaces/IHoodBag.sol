// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {BagSource, BagOutlet} from "../bag/BagTypes.sol";

/// @notice The one router every platform fee passes through. No owner, no withdrawal, splits
///         fixed at deploy. The house is paid first on every intake.
/// @dev Payment convention for every `take*` function: `asset == address(0)` is native and
///      `msg.value` must equal `amount`; any other asset is an ERC-20 the caller has approved
///      for `amount` and the Bag pulls it (PairTransfer.pull). `token` is the launch the money
///      relates to, or address(0) when it relates to none.
interface IHoodBag {
    /// @notice 30 bps of a trade: 10 Vault, 10 Payday, 10 house (in bps of the trade). When
    ///         `token` is the house coin all of it goes to the Vault.
    function takeTradeFee(address asset, uint256 amount, address token) external payable;
    /// @notice A curve's graduation fee: 23% to the launch's creator fee recipient (`dev`), 77% to
    ///         the burn clock, which buys the house coin with it and burns it.
    function takeGraduationFee(address asset, uint256 amount, address token, address dev) external payable;
    /// @notice A boost slot's price, all of it to the Payday of the hour the boost runs.
    function takeBoost(address asset, uint256 amount, address token, uint64 epoch) external payable;
    /// @notice Launch fees: all to the house.
    function takeHouseFee(address asset, uint256 amount, address token) external payable;
    /// @notice The house coin's own creator leg: half Vault, half house.
    function takeHouseCoinLeg(address asset, uint256 amount) external payable;

    /// @notice Vault, burn and dev shares that could not leave yet are held here; anyone can
    ///         release them once they can (the Vault needs the house coin to exist).
    function releaseHeld(address asset) external;

    function house() external view returns (address);
    function vault() external view returns (address);
    function payday() external view returns (address);
    function burnClock() external view returns (address);
    function totalIn(address asset, BagSource source) external view returns (uint256);
    function totalOut(address asset, BagOutlet outlet) external view returns (uint256);
    function heldForVault(address asset) external view returns (uint256);
    function heldForBurn(address asset) external view returns (uint256);

    event BagIn(BagSource indexed source, address indexed asset, uint256 amount, address indexed token);
    event BagOut(BagOutlet indexed outlet, address indexed asset, uint256 amount, address indexed to);
    event Held(BagOutlet indexed outlet, address indexed asset, uint256 amount);
}
