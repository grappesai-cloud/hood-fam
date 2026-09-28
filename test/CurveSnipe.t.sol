// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {BaseTest} from "./Base.t.sol";
import {HoodCurve} from "../src/HoodCurve.sol";
import {HoodFactory} from "../src/HoodFactory.sol";
import {LaunchParams} from "../src/HoodTypes.sol";
import {IHoodPot} from "../src/interfaces/IHoodPot.sol";

/// @notice The curve's opening tax: the Pons schedule, who pays it, and where it goes.
contract CurveSnipeTest is BaseTest {
    address internal token;
    HoodCurve internal curve;
    address internal team = makeAddr("team");
    uint256 internal start;

    function setUp() public override {
        super.setUp();
        LaunchParams memory p = _params(_toCreator());
        p.exempt = new address[](1);
        p.exempt[0] = team;
        (token, curve) = _launch(_toCreator(), p, LAUNCH_FEE);
        start = curve.launchedAt();
        vm.deal(team, 100 ether);
        vm.warp(start);
    }

    function _tax(uint256 pairIn, uint256 bps) internal pure returns (uint256) {
        // charged on what was bought, as bps of the whole: the curve takes the tax off the top
        return (pairIn * bps + 9_999) / 10_000;
    }

    function test_the_schedule_is_99_then_6_18_then_0_19_then_nothing() public {
        assertEq(curve.currentSnipeTaxBps(alice), 9_900);
        vm.warp(start + 1);
        assertEq(curve.currentSnipeTaxBps(alice), 618);
        vm.warp(start + 2);
        assertEq(curve.currentSnipeTaxBps(alice), 19);
        vm.warp(start + 3);
        assertEq(curve.currentSnipeTaxBps(alice), 0);
        vm.warp(start + 1 days);
        assertEq(curve.currentSnipeTaxBps(alice), 0);
    }

    function test_the_exemption_is_keyed_on_the_wallet_that_receives_the_tokens() public {
        assertEq(curve.currentSnipeTaxBps(creator), 0, "the launcher");
        assertEq(curve.currentSnipeTaxBps(team), 0, "a named wallet");

        // a stranger buying FOR the team wallet pays nothing: the tokens are the team's
        (uint256 quotedForTeam,,) = curve.quoteBuyFor(1 ether, team);
        vm.prank(alice);
        uint256 got = curve.buy{value: 1 ether}(1 ether, 0, team);
        assertEq(got, quotedForTeam);

        // the team wallet buying for a stranger pays the tax: the tokens are the stranger's
        (uint256 quotedForBob,,) = curve.quoteBuyFor(1 ether, bob);
        assertLt(quotedForBob, got / 50, "99% of the buy is gone");
        vm.prank(team);
        assertEq(curve.buy{value: 1 ether}(1 ether, 0, bob), quotedForBob);
    }

    function test_a_buy_in_the_launch_second_pays_99_percent_and_it_is_trading_fee() public {
        uint256 protocolBefore = curve.protocolClaimable();
        uint256 creatorBefore = router.accrued(token);
        IHoodPot pot = IHoodPot(factory.getLaunch(token).pot);

        vm.expectEmit(true, true, true, false, address(curve));
        emit HoodCurve.Sniped(alice, alice, 0);
        vm.prank(alice);
        uint256 got = curve.buy{value: 1 ether}(1 ether, 0, alice);
        assertGt(got, 0);

        uint256 protocolLeg = curve.protocolClaimable() - protocolBefore;
        uint256 creatorLeg = router.accrued(token) - creatorBefore;
        uint256 taken = protocolLeg + creatorLeg;
        assertApproxEqRel(taken, 0.99 ether + 0.0001 ether, 0.001e18, "99% plus the 1% fee on what was left");
        assertApproxEqRel(creatorLeg * 30, protocolLeg * 70, 0.001e18, "split 70/30 like the trading fee");
        assertEq(pot.totalDeposited(), 0, "nothing goes to the pot: it is fee, not a penalty");
        assertEq(alice.balance, 1000 ether - 1 ether, "the whole input was spent");
    }

    function test_exact_output_pays_the_same_tax() public {
        uint256 want = 1_000e18;
        (uint256 pairIn, uint256 fee) = curve.quoteBuyExactOut(want);
        (uint256 teamIn,) = curve.quoteBuyExactOutFor(want, team);
        assertGt(pairIn, teamIn * 90, "an outsider pays about a hundred times what the team pays");
        vm.prank(alice);
        curve.buyExactOut{value: pairIn}(want, pairIn, alice);
        assertEq(IERC20(token).balanceOf(alice), want);
        assertGt(fee, (pairIn * 98) / 100);
    }

    function test_one_second_in_the_tax_is_6_18_percent() public {
        vm.warp(start + 1);
        uint256 protocolBefore = curve.protocolClaimable();
        uint256 creatorBefore = router.accrued(token);
        vm.prank(alice);
        curve.buy{value: 1 ether}(1 ether, 0, alice);
        uint256 taken = curve.protocolClaimable() - protocolBefore + router.accrued(token) - creatorBefore;
        // 6.18% off the top, then the 1% fee on the rest
        assertApproxEqRel(taken, 0.0618 ether + (0.9382 ether / 100), 0.001e18);
    }

    function test_the_launch_transaction_s_own_first_buy_pays_nothing() public {
        LaunchParams memory p = _params(_toCreator());
        p.symbol = "FIRST";
        p.salt = bytes32(uint256(99));
        p.creatorFeeRecipient = bob; // so the launcher is exempt only as the launcher
        vm.prank(creator);
        (address t,, uint256 bought) = factory.launch{value: LAUNCH_FEE + 1 ether}(p);
        assertEq(IERC20(t).balanceOf(creator), bought);
        // 1 ETH at the opening price buys a big slice of the curve, not the crumbs 1% would buy
        assertGt(bought, 100_000_000e18);
    }

    function test_after_the_window_everyone_pays_the_same_fee() public {
        vm.warp(start + 3);
        (uint256 forAlice,,) = curve.quoteBuyFor(1 ether, alice);
        (uint256 forTeam,,) = curve.quoteBuyFor(1 ether, team);
        assertEq(forAlice, forTeam);
    }

    function test_a_list_past_32_is_refused() public {
        LaunchParams memory p = _params(_toCreator());
        p.symbol = "LONG";
        p.salt = bytes32(uint256(100));
        p.exempt = new address[](33);
        vm.prank(creator);
        vm.expectRevert(HoodFactory.ExemptionListTooLong.selector);
        factory.launch{value: LAUNCH_FEE}(p);
    }
}
