// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

interface IHoodStaking {
    /// @notice Credits a reward to every staker of `token`, weighted by stake size and lock length.
    /// @dev Native pair: send value. ERC-20 pair: transfer first, then call with the same amount.
    function notifyReward(address token, uint256 amount) external payable;

    function totalWeight(address token) external view returns (uint256);
}
