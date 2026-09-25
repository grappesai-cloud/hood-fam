// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

interface IHoodReferrals {
    /// @notice The referral leg of `amount`, where `amount` is the protocol's share of `token`'s fees.
    /// @return to who is paid; address(0) when the launch has no referral
    /// @return cut how much of `amount` they take; zero when the launch has no referral
    function split(address token, uint256 amount) external view returns (address to, uint256 cut);
}
