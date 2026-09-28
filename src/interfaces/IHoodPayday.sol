// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @notice The hourly distributor. The Bag funds the current hour; after the hour closes the
///         keeper pays it out by points, and sends a slice into the last ten launches' pots.
/// @dev Epochs are `block.timestamp / 1 hours`. Money that is not paid carries into the next
///      epoch. The keeper is appointed by the factory owner (the Safe) and can only choose who
///      gets paid, never how much in total.
interface IHoodPayday {
    function epoch() external view returns (uint64);
    function keeper() external view returns (address);

    /// @notice Same payment convention as the Bag. Credits the current epoch.
    function fund(address asset, uint256 amount) external payable;
    /// @notice Same, for a named epoch that has not closed yet (the current one or later). A boost
    ///         bought for the next hour pays that hour's traders.
    function fundEpoch(address asset, uint256 amount, uint64 epoch_) external payable;

    /// @notice Pays a closed epoch. `wallets` and `amounts` are the hour's points holders,
    ///         `pots` are up to ten launch pots that share the launch slice (at most
    ///         PAYDAY_LAUNCH_SLICE_BPS of the epoch's pot). Whatever is left carries forward.
    function pay(
        uint64 epoch_,
        address asset,
        address[] calldata wallets,
        uint256[] calldata amounts,
        address[] calldata pots,
        uint256[] calldata potAmounts
    ) external;

    function funded(uint64 epoch_, address asset) external view returns (uint256);
    function paid(uint64 epoch_, address asset) external view returns (uint256);
    function carried(address asset) external view returns (uint256);

    event Funded(uint64 indexed epoch, address indexed asset, uint256 amount);
    event Paid(uint64 indexed epoch, address indexed asset, address indexed wallet, uint256 amount);
    event LaunchSlice(uint64 indexed epoch, address indexed asset, address indexed pot, uint256 amount);
    event EpochPaid(uint64 indexed epoch, address indexed asset, uint256 toWallets, uint256 toLaunches, uint256 carried);
    event KeeperSet(address keeper);
}
