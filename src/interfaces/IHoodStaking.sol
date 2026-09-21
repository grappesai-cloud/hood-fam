// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

interface IHoodStaking {
    /// @notice The one token this vault accepts. Zero until the owner has named it.
    function houseToken() external view returns (address);

    /// @notice Credits a reward to everyone who locked the house coin, weighted by size and lock.
    /// @dev Native asset: send value. ERC-20: transfer first, then call with the same amount.
    ///      The asset is whatever the paying launch trades against, so one vault holds several.
    function notifyReward(address asset, uint256 amount) external payable;

    function totalWeight() external view returns (uint256);

    /// @notice Locks the house coin in somebody else's name: they earn from minute one and cannot
    ///         sell before the lock ends, and the caller keeps nothing.
    function stakeFor(address beneficiary, uint256 amount, uint64 lockDuration) external returns (uint256 id);

    /// @notice Whether `lockDuration` is exactly one of the vault's tiers.
    function isTier(uint64 lockDuration) external view returns (bool);
}
