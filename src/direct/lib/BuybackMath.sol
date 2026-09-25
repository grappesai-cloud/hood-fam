// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {SqrtPriceMath} from "@uniswap/v4-core/src/libraries/SqrtPriceMath.sol";
import {StateLibrary} from "@uniswap/v4-core/src/libraries/StateLibrary.sol";

/// @title BuybackMath
/// @notice The price-impact arithmetic the buyback module and the launch hook share: how much
///         quote a buy may spend before the price moves a given number of ticks, and how much
///         quote a sell can take out before it does.
/// @dev Both read the liquidity in range at this instant and assume the swap stays inside it,
///      which is exact for a launch whose whole supply sits in one position and an estimate
///      once strangers add ranges of their own. The price limit stays on the swap as the backstop.
library BuybackMath {
    using StateLibrary for IPoolManager;
    using PoolIdLibrary for PoolKey;

    /// @notice How far one buyback may move the price, in ticks: about three percent.
    int24 internal constant MAX_IMPACT_TICKS = 296;
    uint256 internal constant BPS = 10_000;
    uint256 internal constant PIPS = 1_000_000;

    /// @notice The quote a buy may spend before the price moves `maxTicks`, grossed up for the
    ///         pool's fee and for a `taxBps` hook tax on the input, and the price limit itself.
    /// @dev A fresh launch quoted in the chain's own currency sits exactly on the position's upper
    ///      edge, where nothing is in range until the first buy crosses in. The tick's own net
    ///      liquidity is what the pool will pick up on that crossing.
    function sizeToCap(IPoolManager pm, PoolKey memory key, bool zeroForOne, uint256 taxBps, int24 maxTicks)
        internal
        view
        returns (uint256 amountIn, uint160 sqrtLimit)
    {
        PoolId id = key.toId();
        (uint160 sqrtP, int24 tick,,) = pm.getSlot0(id);
        sqrtLimit = TickMath.getSqrtPriceAtTick(_limitTick(tick, zeroForOne, maxTicks));

        uint128 liquidity = pm.getLiquidity(id);
        if (liquidity == 0 && zeroForOne) {
            (, int128 net) = pm.getTickLiquidity(id, tick);
            if (net < 0) liquidity = uint128(-net);
        }
        if (liquidity == 0) return (0, sqrtLimit);

        uint256 needed = zeroForOne
            ? SqrtPriceMath.getAmount0Delta(sqrtLimit, sqrtP, liquidity, true)
            : SqrtPriceMath.getAmount1Delta(sqrtP, sqrtLimit, liquidity, true);
        if (needed == 0) return (0, sqrtLimit);
        uint256 gross = (needed * PIPS) / (PIPS - key.fee);
        amountIn = (gross * BPS) / (BPS - taxBps) + 1;
    }

    /// @notice The quote a sell can take out of the pool before the price moves `ticks`.
    /// @return available the quote inside the limit
    /// @return known false when nothing is in range, in which case there is nothing to measure
    function quoteWithinTicks(IPoolManager pm, PoolKey memory key, bool zeroForOne, int24 ticks)
        internal
        view
        returns (uint256 available, bool known)
    {
        PoolId id = key.toId();
        uint128 liquidity = pm.getLiquidity(id);
        if (liquidity == 0) return (0, false);
        (uint160 sqrtP, int24 tick,,) = pm.getSlot0(id);
        uint160 sqrtLimit = TickMath.getSqrtPriceAtTick(_limitTick(tick, zeroForOne, ticks));
        available = zeroForOne
            ? SqrtPriceMath.getAmount1Delta(sqrtLimit, sqrtP, liquidity, false)
            : SqrtPriceMath.getAmount0Delta(sqrtP, sqrtLimit, liquidity, false);
        known = true;
    }

    function _limitTick(int24 tick, bool zeroForOne, int24 ticks) private pure returns (int24 limitTick) {
        limitTick = zeroForOne ? tick - ticks : tick + ticks;
        if (limitTick < TickMath.MIN_TICK + 1) limitTick = TickMath.MIN_TICK + 1;
        if (limitTick > TickMath.MAX_TICK - 1) limitTick = TickMath.MAX_TICK - 1;
    }
}
