// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

interface IHoodFeeRouter {
    /// @notice Books the creator leg of a fee for `token`.
    /// @dev Native pair: send value. ERC-20 pair: transfer first, then call with the same amount.
    function accrue(address token, uint256 amount) external payable;

    function accrued(address token) external view returns (uint256);

    /// @notice Permissionless. Spends everything booked for a token across its fee split.
    /// @dev Reverts when the split has a buyback leg; that one goes through `flushBuyback`.
    function flush(address token) external;

    /// @notice The same flush with a slippage floor, which applies to the buyback leg only.
    function flushBuyback(address token, uint256 minTokensOut) external;
}
