// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

/// @title CurveMath
/// @notice The bonding curve every launch trades on: price rises linearly with the supply sold.
/// @dev Prices are quoted in pair units per 1e18 token wei, so a price is the fully diluted
///      valuation divided by the token count. The curve is described by three numbers: the price
///      at the first token (`p0`), the price at the last curve token (`p1`) and how many tokens
///      sit on the curve (`supply`).
///
///      price(s) = p0 + (p1 - p0) * s / supply
///      cost(s -> s + d) = [ p0 * d + (p1 - p0) * d * (2s + d) / (2 * supply) ] / 1e18
///
///      Buys round up and sells round down, always in the curve's favour, so the reserve can only
///      drift above the closed-form integral and a sell can never be short of funds.
library CurveMath {
    uint256 internal constant WAD = 1e18;

    /// @notice Price per 1e18 token wei once `s` token wei have been sold.
    function priceAt(uint256 p0, uint256 p1, uint256 supply, uint256 s) internal pure returns (uint256) {
        return p0 + Math.mulDiv(p1 - p0, s, supply);
    }

    /// @notice Pair cost of moving the sold amount from `s` to `s + d`.
    /// @dev One division, so the result is the exact floor (or ceiling) of the true integral.
    ///      That matters more than it looks: with two roundings in sequence, splitting a trade
    ///      into pieces could come out a wei cheaper than doing it at once, and a wei that leaks
    ///      per call is a machine somebody will run.
    ///
    ///      cost = d * [ 2 * p0 * supply + (p1 - p0) * (2s + d) ] / (2 * supply * 1e18)
    function cost(uint256 p0, uint256 p1, uint256 supply, uint256 s, uint256 d, bool up)
        internal
        pure
        returns (uint256)
    {
        if (d == 0) return 0;
        uint256 slope = 2 * p0 * supply + (p1 - p0) * (2 * s + d);
        return Math.mulDiv(slope, d, 2 * supply * WAD, up ? Math.Rounding.Ceil : Math.Rounding.Floor);
    }

    /// @notice Largest token amount buyable with `budget`, never more than `maxOut`.
    /// @dev Bounded search. The bounds come from the price at the start and at the end of the
    ///      move, which brackets the answer tightly, so the loop normally runs a handful of times.
    function tokensForPair(uint256 p0, uint256 p1, uint256 supply, uint256 s, uint256 budget, uint256 maxOut)
        internal
        pure
        returns (uint256)
    {
        if (budget == 0 || maxOut == 0) return 0;

        uint256 hi = Math.mulDiv(budget, WAD, priceAt(p0, p1, supply, s));
        if (hi > maxOut) hi = maxOut;
        if (hi == 0) return 0;

        uint256 lo = Math.mulDiv(budget, WAD, priceAt(p0, p1, supply, s + hi));
        if (lo > hi) lo = hi;
        if (lo != 0 && cost(p0, p1, supply, s, lo, true) > budget) lo = 0;

        while (lo < hi) {
            uint256 mid = (lo + hi + 1) / 2;
            if (cost(p0, p1, supply, s, mid, true) <= budget) {
                lo = mid;
            } else {
                hi = mid - 1;
            }
        }
        return lo;
    }
}
