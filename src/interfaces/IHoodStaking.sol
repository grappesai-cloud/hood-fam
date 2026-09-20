// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

interface IHoodStaking {
    /// @notice Credits a reward to every staker of `token`, weighted by stake size and lock length.
    /// @dev Native pair: send value. ERC-20 pair: transfer first, then call with the same amount.
    function notifyReward(address token, uint256 amount) external payable;

    function totalWeight(address token) external view returns (uint256);

    /// @notice Locks tokens in somebody else's name: they earn from minute one and cannot sell
    ///         before the lock ends, and the caller keeps nothing.
    function stakeFor(address token, address beneficiary, uint256 amount, uint64 lockDuration)
        external
        returns (uint256 id);

    /// @notice Whether `lockDuration` is exactly one of the vault's tiers.
    function isTier(uint64 lockDuration) external view returns (bool);
}
