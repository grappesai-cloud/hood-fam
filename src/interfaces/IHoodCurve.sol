// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Phase} from "../HoodTypes.sol";

interface IHoodCurve {
    function token() external view returns (address);
    function pairToken() external view returns (address);
    function phase() external view returns (Phase);
    function graduationHandler() external view returns (address);
    /// @notice The Bag every protocol leg of this curve is paid into, pinned at launch.
    function bag() external view returns (address);
    function sold() external view returns (uint256);
    function reserve() external view returns (uint256);
    function bonus() external view returns (uint256);
    function curveSupply() external view returns (uint256);
    function raiseTarget() external view returns (uint256);
    function lpSupply() external view returns (uint256);

    function quoteBuy(uint256 pairIn) external view returns (uint256 tokensOut, uint256 pairSpent, uint256 fee);
    /// @notice Same, with the tokens going to `to` (an exempt wallet pays no opening tax).
    function quoteBuyFor(uint256 pairIn, address to)
        external
        view
        returns (uint256 tokensOut, uint256 pairSpent, uint256 fee);
    /// @notice The opening tax on a buy whose tokens go to `recipient`, in bps (SnipeSchedule).
    function currentSnipeTaxBps(address recipient) external view returns (uint256);
    function quoteSell(uint256 tokensIn) external view returns (uint256 pairOut, uint256 fee);

    function buy(uint256 pairIn, uint256 minTokensOut, address to) external payable returns (uint256 tokensOut);
    function buyExactOut(uint256 tokensOut, uint256 maxPairIn, address to) external payable returns (uint256 pairSpent);
    function sell(uint256 tokensIn, uint256 minPairOut, address to) external returns (uint256 pairOut);

    /// @notice Adds pair funds to the liquidity that this token graduates into. Nobody can take them out.
    function donate(uint256 amount) external payable;

    /// @notice Permissionless. Moves a sold-out curve into its pool.
    function finalize() external;
}
