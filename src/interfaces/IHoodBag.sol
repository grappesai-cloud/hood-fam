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
    /// @notice 70 bps of a trade: 30 Vault, 10 Payday, 10 burn, 20 house (in bps of the trade).
    function takeTradeFee(address asset, uint256 amount, address token) external payable;
    /// @notice A curve's graduation fee: 50 house, 25 Confetti into `pot`, 25 Vault.
    function takeGraduationFee(address asset, uint256 amount, address token, address pot) external payable;
    /// @notice The Bag's 20% of a penalty: 10 house, 5 Payday, 5 burn (in bps of the penalty).
    function takePenaltyCut(address asset, uint256 amount, address token) external payable;
    /// @notice Launch fees and boost slots: all to the house.
    function takeHouseFee(address asset, uint256 amount, address token) external payable;
    /// @notice The house coin's own creator leg: half Vault, half burn.
    function takeHouseCoinLeg(address asset, uint256 amount) external payable;

    /// @notice Vault and burn shares are held here until the house coin exists; then anyone
    ///         can release them.
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
