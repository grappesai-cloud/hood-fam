// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

interface IHoodTokenLock {
    /// @notice Whether `lockDuration` is one of the lengths this contract accepts.
    function isTier(uint64 lockDuration) external pure returns (bool);

    /// @notice Takes `amount` of `token` and holds it for `beneficiary` until the lock is over.
    /// @dev Approve first. Returns the lock id, which is what the launch records.
    function lockFor(address token, address beneficiary, uint256 amount, uint64 lockDuration)
        external
        returns (uint256 id);

    /// @notice Returns a lock's tokens to its owner, once the time has passed.
    function withdraw(uint256 id) external returns (uint256 amount);
}
