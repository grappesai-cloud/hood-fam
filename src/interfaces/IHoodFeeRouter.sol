// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

interface IHoodFeeRouter {
    /// @notice Books the creator leg of a fee for `token`.
    /// @dev Native pair: send value. ERC-20 pair: transfer first, then call with the same amount.
    function accrue(address token, uint256 amount) external payable;

    function accrued(address token) external view returns (uint256);

    /// @notice Permissionless. Applies the token's fee model to everything booked for it.
    function flush(address token) external;
}
