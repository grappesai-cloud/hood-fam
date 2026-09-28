// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @title SnipeSchedule
/// @notice The opening tax every launch runs, on both machines: 99% of a buy in the launch's own
///         second, then 6.18%, then 0.19%, then nothing. It is not a setting. Every coin opens
///         the same way, so a buyer never has to read a launch's config to know what the first
///         seconds cost.
/// @dev The numbers are Pons v2's, read off its live curves block by block (28 Sep 2026:
///      `currentSnipeTaxBps` returned 9900, 618, 19 and 0 at elapsed seconds 0, 1, 2 and 3 on two
///      separate launches). Block timestamps are whole seconds, so a table is the exact schedule
///      and not an approximation of a curve.
///
///      Buys only. A seller is never charged. The launching wallet, the creator fee recipient and
///      up to MAX_EXEMPT wallets the creator names at launch pay nothing for the whole window; so
///      does every buy made inside the launch transaction itself.
library SnipeSchedule {
    /// @notice The most extra wallets a creator may exempt at launch.
    uint256 internal constant MAX_EXEMPT = 32;

    /// @notice Seconds after the launch during which the tax can be nonzero.
    uint256 internal constant WINDOW = 3;

    /// @notice The tax, in bps of the buy, `elapsed` seconds after the launch block.
    function bpsAt(uint256 elapsed) internal pure returns (uint256) {
        if (elapsed == 0) return 9_900;
        if (elapsed == 1) return 618;
        if (elapsed == 2) return 19;
        return 0;
    }
}
