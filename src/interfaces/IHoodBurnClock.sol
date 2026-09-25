// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";

/// @notice Holds the burn share of every asset and, once an hour, buys the house coin with it
///         and burns what it bought. Impact-capped like the buyback module.
/// @dev The house coin and its pool are set once by the factory owner (the Safe). Until then the
///      clock only accumulates. The keeper is appointed by the factory owner.
interface IHoodBurnClock {
    function houseCoin() external view returns (address);
    function keeper() external view returns (address);

    /// @notice Same payment convention as the Bag.
    function fund(address asset, uint256 amount) external payable;

    /// @notice Spends up to `maxSpend` of `asset` on the house coin and burns it. Reverts when
    ///         the price would move more than the impact cap or less than `minOut` comes back.
    ///         Once per hour per asset.
    function burn(address asset, uint256 maxSpend, uint256 minOut) external returns (uint256 spent, uint256 burned);

    function balanceOf(address asset) external view returns (uint256);
    function totalSpent(address asset) external view returns (uint256);
    function totalBurned() external view returns (uint256);

    event Funded(address indexed asset, uint256 amount);
    event Burned(address indexed asset, uint256 spent, uint256 coinBurned, uint64 indexed epoch);
    event HouseCoinSet(address coin);
    event KeeperSet(address keeper);
}
