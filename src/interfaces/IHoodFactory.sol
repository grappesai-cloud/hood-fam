// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {CurveConfig, FeeSplit, Launch, LaunchParams} from "../HoodTypes.sol";
import {PenaltyConfig} from "../bag/BagTypes.sol";

interface IHoodFactory {
    function owner() external view returns (address);
    function treasury() external view returns (address);
    function feeRouter() external view returns (address);
    function staking() external view returns (address);
    function graduationHandler() external view returns (address);
    /// @notice The referral registry both machines read; address(0) means no referral leg anywhere.
    function referrals() external view returns (address);
    /// @notice The Bag: the one router every platform fee is paid into. Set once by the owner.
    function bag() external view returns (address);

    function getLaunch(address token) external view returns (Launch memory);
    function getConfig(uint256 configId) external view returns (CurveConfig memory);
    function creatorFeeRecipient(address token) external view returns (address);
    function feeSplit(address token) external view returns (FeeSplit memory);
    /// @notice The post-graduation penalties a curve launch chose. All zero for a direct launch
    ///         (those keep theirs in the hook) and for a launch that chose none.
    function penaltiesOf(address token) external view returns (PenaltyConfig memory);

    /// @notice Called by a curve on every trade, so the factory can run the copycat lock window.
    function recordVolume(address token, uint256 pairAmount) external;
}
