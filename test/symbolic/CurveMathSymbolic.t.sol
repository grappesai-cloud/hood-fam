// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {CurveMath} from "../../src/libraries/CurveMath.sol";

/// @notice Symbolic proofs of the curve's money-critical math. Run with `halmos`, these hold for
///         EVERY input in the bounded ranges, not just the ones a fuzzer happened to try. The bounds
///         are the ranges the factory actually deploys into (a config's caps and supply), narrowed
///         only enough to keep the solver inside a decidable space.
/// @dev `check_` prefix is what halmos runs; `forge test` skips them, so this file is symbolic-only.
contract CurveMathSymbolic is Test {
    // The curve is described by p0 (price at the first token), p1 (price at the last), and supply.
    // These bounds cover the deployed presets with room to spare: prices from 1 gwei to 1e9 gwei per
    // token, supply from a million to a trillion tokens.
    function _assume(uint256 p0, uint256 p1, uint256 supply) internal pure {
        vm.assume(p0 >= 1e9 && p0 <= 1e18);
        vm.assume(p1 >= p0 && p1 <= 1e21);
        vm.assume(supply >= 1e24 && supply <= 1e30);
    }

    /// @notice No free lunch on splitting: buying `a` then `b` never costs less than buying `a+b` in
    ///         one go. If it did, a bot would slice every buy into a machine. `cost` rounds up, so
    ///         the split should cost at least as much, to the wei.
    function check_splittingABuyNeverGetsCheaper(uint256 p0, uint256 p1, uint256 supply, uint256 s, uint256 a, uint256 b)
        public
    {
        _assume(p0, p1, supply);
        vm.assume(s <= supply);
        vm.assume(a <= supply - s);
        vm.assume(b <= supply - s - a);
        vm.assume(a > 0 && b > 0);

        uint256 whole = CurveMath.cost(p0, p1, supply, s, a + b, true);
        uint256 first = CurveMath.cost(p0, p1, supply, s, a, true);
        uint256 second = CurveMath.cost(p0, p1, supply, s + a, b, true);
        assert(first + second >= whole);
    }

    /// @notice A buy costs at least as much as the same span sells for. This is the spread that keeps
    ///         the reserve solvent: buying rounds up, selling rounds down, over the identical move, so
    ///         a buy-then-sell round trip can never take out more than it put in.
    function check_buyCostsAtLeastWhatItSellsFor(uint256 p0, uint256 p1, uint256 supply, uint256 s, uint256 d)
        public
    {
        _assume(p0, p1, supply);
        vm.assume(s <= supply);
        vm.assume(d > 0 && d <= supply - s);

        uint256 buyCost = CurveMath.cost(p0, p1, supply, s, d, true);
        uint256 sellGross = CurveMath.cost(p0, p1, supply, s, d, false);
        assert(buyCost >= sellGross);
    }

    /// @notice Price rises monotonically with supply sold: selling more can never make the marginal
    ///         price go down. A non-monotone curve would let someone buy cheaper after buying dear.
    function check_priceIsMonotone(uint256 p0, uint256 p1, uint256 supply, uint256 a, uint256 b) public {
        _assume(p0, p1, supply);
        vm.assume(a <= b && b <= supply);
        assert(CurveMath.priceAt(p0, p1, supply, b) >= CurveMath.priceAt(p0, p1, supply, a));
    }

    /// @notice `tokensForPair` never returns tokens that cost more than the budget it was given. This
    ///         is the property the buy path leans on: whatever the search returns, the caller can
    ///         afford. It also never exceeds the cap it was handed.
    function check_tokensForPairStaysWithinBudget(
        uint256 p0, uint256 p1, uint256 supply, uint256 s, uint256 budget, uint256 maxOut
    ) public {
        _assume(p0, p1, supply);
        vm.assume(s < supply);
        vm.assume(maxOut <= supply - s);
        vm.assume(budget <= 1e30);

        uint256 got = CurveMath.tokensForPair(p0, p1, supply, s, budget, maxOut);
        assert(got <= maxOut);
        if (got > 0) {
            assert(CurveMath.cost(p0, p1, supply, s, got, true) <= budget);
        }
    }
}
