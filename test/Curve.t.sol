// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {BaseTest} from "./Base.t.sol";
import {HoodCurve} from "../src/HoodCurve.sol";
import {CurveMath} from "../src/libraries/CurveMath.sol";
import {Phase} from "../src/HoodTypes.sol";

contract CurveTest is BaseTest {
    address internal token;
    HoodCurve internal curve;

    function setUp() public override {
        super.setUp();
        (token, curve) = _launch(_toCreator());
    }

    function test_launch_puts_every_token_on_the_curve() public view {
        assertEq(IERC20(token).totalSupply(), 1_000_000_000e18);
        assertEq(IERC20(token).balanceOf(address(curve)), 1_000_000_000e18);
        assertEq(curve.curveSupply(), 800_000_000e18);
        assertEq(curve.lpSupply(), 200_000_000e18);
        assertEq(uint8(curve.phase()), uint8(Phase.Curve));
    }

    function test_price_starts_at_the_start_cap() public view {
        // 1 ETH of fully diluted valuation over a billion tokens
        assertEq(curve.price(), 1e9);
        assertEq(CurveMath.priceAt(curve.p0(), curve.p1(), curve.curveSupply(), curve.curveSupply()), 1e10);
    }

    function test_buy_moves_the_price_up_and_pays_the_fee_legs() public {
        uint256 treasuryBefore = treasury.balance;
        uint256 out = _buy(curve, alice, 1 ether);

        assertGt(out, 0);
        assertEq(IERC20(token).balanceOf(alice), out);
        assertEq(curve.sold(), out);
        assertGt(curve.price(), 1e9);

        // 1% total fee, split 30/70 between the protocol and the creator leg. The protocol's leg is
        // booked rather than sent: a treasury that cannot take a transfer must not be able to stop
        // a trade, and this one is an immutable.
        assertEq(treasury.balance, treasuryBefore, "nothing is pushed at the treasury");
        assertApproxEqRel(curve.protocolClaimable(), 0.003 ether, 0.01e18);
        assertApproxEqRel(router.accrued(token), 0.007 ether, 0.01e18);
        // everything the buyer paid is either reserve or fee
        assertEq(address(curve).balance, curve.reserve() + curve.protocolClaimable());
        assertApproxEqRel(curve.reserve(), 0.99 ether, 0.001e18);

        // and anybody can pull it out to the treasury afterwards
        uint256 booked = curve.protocolClaimable();
        curve.claimProtocol();
        assertEq(treasury.balance - treasuryBefore, booked);
        assertEq(curve.protocolClaimable(), 0);
    }

    function test_buy_then_sell_never_returns_more_than_it_cost() public {
        uint256 spentBefore = alice.balance;
        uint256 out = _buy(curve, alice, 1 ether);
        vm.startPrank(alice);
        IERC20(token).approve(address(curve), out);
        curve.sell(out, 0, alice);
        vm.stopPrank();
        assertLt(alice.balance, spentBefore, "round trip must cost the trader, not the curve");
        assertEq(curve.sold(), 0);
        assertLe(curve.reserve(), 1); // dust at most
    }

    function test_sell_pays_out_of_the_reserve_and_the_reserve_stays_solvent() public {
        _buy(curve, alice, 0.3 ether);
        _buy(curve, bob, 0.7 ether);

        uint256 aliceTokens = IERC20(token).balanceOf(alice);
        vm.startPrank(alice);
        IERC20(token).approve(address(curve), aliceTokens);
        uint256 got = curve.sell(aliceTokens, 0, alice);
        vm.stopPrank();

        assertGt(got, 0);
        // the balance is the reserve plus the protocol's booked legs, which are pulled, not pushed
        assertEq(address(curve).balance, curve.reserve() + curve.protocolClaimable());
        assertGe(curve.reserve(), CurveMath.cost(curve.p0(), curve.p1(), curve.curveSupply(), 0, curve.sold(), false));
    }

    function test_buy_refunds_what_the_curve_cannot_absorb() public {
        // ask for far more than the whole curve is worth
        uint256 before = alice.balance;
        _buy(curve, alice, 500 ether);
        assertEq(curve.sold(), curve.curveSupply());
        assertEq(uint8(curve.phase()), uint8(Phase.Sold));
        // the raise is about 4.4 ETH plus fee, the rest came back
        assertGt(alice.balance, before - 5 ether);
    }

    function test_buy_exact_out_charges_the_quote() public {
        (uint256 quoted,) = curve.quoteBuyExactOut(1_000_000e18);
        uint256 before = alice.balance;
        vm.prank(alice);
        uint256 spent = curve.buyExactOut{value: quoted + 1 ether}(1_000_000e18, quoted, alice);
        assertEq(spent, quoted);
        assertEq(before - alice.balance, quoted, "the overpay must come back");
        assertEq(IERC20(token).balanceOf(alice), 1_000_000e18);
    }

    function test_quote_matches_the_trade() public {
        (uint256 tokensOut, uint256 pairSpent,) = curve.quoteBuy(2 ether);
        uint256 actual = _buy(curve, alice, 2 ether);
        assertEq(actual, tokensOut);
        assertLe(pairSpent, 2 ether);
    }

    function test_slippage_floor_is_enforced() public {
        (uint256 tokensOut,,) = curve.quoteBuy(1 ether);
        vm.prank(alice);
        vm.expectRevert(HoodCurve.Slippage.selector);
        curve.buy{value: 1 ether}(1 ether, tokensOut + 1, alice);
    }

    function test_trading_stops_when_the_curve_sells_out() public {
        _buy(curve, alice, 500 ether);
        vm.prank(bob);
        vm.expectRevert(HoodCurve.NotTrading.selector);
        curve.buy{value: 1 ether}(1 ether, 0, bob);
    }

    function test_finalize_moves_the_liquidity_into_the_pool() public {
        _buy(curve, alice, 500 ether);
        uint256 reserve = curve.reserve();
        uint256 treasuryBefore = treasury.balance;

        curve.finalize();

        assertEq(uint8(curve.phase()), uint8(Phase.Graduated));
        (uint256 tokenReserve, uint256 pairReserve, bool exists) = graduator.pools(token);
        assertTrue(exists);
        assertEq(tokenReserve, curve.lpSupply());
        assertEq(pairReserve, (reserve * 9000) / 10_000);
        // the remaining tenth is the graduation fee, booked like every other protocol leg
        assertEq(treasury.balance, treasuryBefore);
        uint256 booked = curve.protocolClaimable();
        curve.claimProtocol();
        assertEq(treasury.balance - treasuryBefore, booked);
        assertGe(booked, reserve - pairReserve);
        assertEq(address(curve).balance, 0, "and then the curve is empty");
        assertEq(IERC20(token).balanceOf(address(curve)), 0);
    }

    function test_finalize_needs_a_sold_out_curve() public {
        vm.expectRevert(HoodCurve.NotSoldOut.selector);
        curve.finalize();
    }

    function test_donations_go_to_the_pool_and_never_come_back() public {
        _buy(curve, alice, 1 ether);
        vm.prank(bob);
        curve.donate{value: 2 ether}(2 ether);
        assertEq(curve.bonus(), 2 ether);

        // a donation does not move the price and cannot be sold back out
        (uint256 quoted,) = curve.quoteSell(IERC20(token).balanceOf(alice));
        assertLt(quoted, 1 ether);

        _graduate(curve);
        (, uint256 pairReserve,) = graduator.pools(token);
        assertGt(pairReserve, 2 ether);
    }

    function test_reserve_covers_every_holder_selling_back(uint256 a, uint256 b, uint256 c) public {
        // the whole curve raises about 4.4 ETH, so keep the three buys under it
        a = bound(a, 0.001 ether, 1 ether);
        b = bound(b, 0.001 ether, 1 ether);
        c = bound(c, 0.001 ether, 1 ether);
        _buy(curve, alice, a);
        _buy(curve, bob, b);
        _buy(curve, alice, c);

        uint256 aliceTokens = IERC20(token).balanceOf(alice);
        uint256 bobTokens = IERC20(token).balanceOf(bob);

        vm.startPrank(alice);
        IERC20(token).approve(address(curve), aliceTokens);
        curve.sell(aliceTokens, 0, alice);
        vm.stopPrank();

        vm.startPrank(bob);
        IERC20(token).approve(address(curve), bobTokens);
        curve.sell(bobTokens, 0, bob);
        vm.stopPrank();

        assertEq(curve.sold(), 0);
        assertEq(address(curve).balance, curve.reserve() + curve.protocolClaimable());
        assertLe(curve.reserve(), 10); // only rounding dust may stay behind
    }
}
