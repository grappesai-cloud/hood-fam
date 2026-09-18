// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {CurveMath} from "../src/libraries/CurveMath.sol";

/// @notice The curve arithmetic on its own, where an exploit would be a rounding hole.
contract CurveMathTest is Test {
    uint256 internal constant P0 = 1e9;
    uint256 internal constant P1 = 1e10;
    uint256 internal constant SUPPLY = 800_000_000e18;

    function test_price_runs_from_the_start_cap_to_the_graduation_cap() public pure {
        assertEq(CurveMath.priceAt(P0, P1, SUPPLY, 0), P0);
        assertEq(CurveMath.priceAt(P0, P1, SUPPLY, SUPPLY), P1);
        assertEq(CurveMath.priceAt(P0, P1, SUPPLY, SUPPLY / 2), (P0 + P1) / 2);
    }

    function test_the_whole_curve_raises_the_area_under_it() public pure {
        uint256 raise = CurveMath.cost(P0, P1, SUPPLY, 0, SUPPLY, false);
        assertEq(raise, (SUPPLY * (P0 + P1)) / 2 / 1e18);
        assertApproxEqRel(raise, 4.4 ether, 0.0001e18);
    }

    function testFuzz_cost_grows_with_size(uint256 s, uint256 d1, uint256 extra) public pure {
        s = bound(s, 0, SUPPLY - 2);
        d1 = bound(d1, 1, SUPPLY - s - 1);
        extra = bound(extra, 1, SUPPLY - s - d1);
        assertGt(
            CurveMath.cost(P0, P1, SUPPLY, s, d1 + extra, true), 0, "any non-zero buy costs at least one wei"
        );
        assertGe(
            CurveMath.cost(P0, P1, SUPPLY, s, d1 + extra, false), CurveMath.cost(P0, P1, SUPPLY, s, d1, false)
        );
    }

    /// @dev The dust attack: buy in a thousand small pieces and hope each one rounds your way.
    ///      Splitting must never be cheaper than one buy of the same size.
    function testFuzz_splitting_a_buy_never_makes_it_cheaper(uint256 s, uint256 d1, uint256 d2) public pure {
        s = bound(s, 0, SUPPLY / 2);
        d1 = bound(d1, 1, SUPPLY / 4);
        d2 = bound(d2, 1, SUPPLY / 4);
        uint256 together = CurveMath.cost(P0, P1, SUPPLY, s, d1 + d2, true);
        uint256 apart =
            CurveMath.cost(P0, P1, SUPPLY, s, d1, true) + CurveMath.cost(P0, P1, SUPPLY, s + d1, d2, true);
        assertGe(apart, together);
    }

    /// @dev And the mirror image: selling in pieces must never pay more than selling at once.
    function testFuzz_splitting_a_sell_never_pays_more(uint256 s, uint256 d1, uint256 d2) public pure {
        d1 = bound(d1, 1, SUPPLY / 4);
        d2 = bound(d2, 1, SUPPLY / 4);
        s = bound(s, d1 + d2, SUPPLY);
        uint256 together = CurveMath.cost(P0, P1, SUPPLY, s - d1 - d2, d1 + d2, false);
        uint256 apart = CurveMath.cost(P0, P1, SUPPLY, s - d1, d1, false)
            + CurveMath.cost(P0, P1, SUPPLY, s - d1 - d2, d2, false);
        assertLe(apart, together);
    }

    function testFuzz_a_buy_never_costs_less_than_it_pays_for(uint256 s, uint256 budget) public pure {
        s = bound(s, 0, SUPPLY - 1);
        budget = bound(budget, 1, 100 ether);
        uint256 d = CurveMath.tokensForPair(P0, P1, SUPPLY, s, budget, SUPPLY - s);
        if (d == 0) return;
        uint256 spent = CurveMath.cost(P0, P1, SUPPLY, s, d, true);
        assertLe(spent, budget, "never spends more than the budget");
        if (d < SUPPLY - s) {
            assertGt(CurveMath.cost(P0, P1, SUPPLY, s, d + 1, true), budget, "and never leaves a token on the table");
        }
    }

    function testFuzz_buying_then_selling_the_same_amount_loses_money(uint256 s, uint256 d) public pure {
        s = bound(s, 0, SUPPLY - 1);
        d = bound(d, 1, SUPPLY - s);
        uint256 paid = CurveMath.cost(P0, P1, SUPPLY, s, d, true);
        uint256 back = CurveMath.cost(P0, P1, SUPPLY, s, d, false);
        assertLe(back, paid);
    }
}
