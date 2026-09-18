// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {CurveConfig, FeeModel, Launch, LaunchParams} from "../HoodTypes.sol";

interface IHoodFactory {
    function treasury() external view returns (address);
    function feeRouter() external view returns (address);
    function staking() external view returns (address);
    function graduationHandler() external view returns (address);

    function getLaunch(address token) external view returns (Launch memory);
    function getConfig(uint256 configId) external view returns (CurveConfig memory);
    function creatorFeeRecipient(address token) external view returns (address);
    function feeModel(address token) external view returns (FeeModel);

    /// @notice Called by a curve on every trade, so the factory can run the copycat lock window.
    function recordVolume(address token, uint256 pairAmount) external;
}
