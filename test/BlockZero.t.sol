// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {BaseTest} from "./Base.t.sol";
import {HoodBlockZero} from "../src/HoodBlockZero.sol";
import {HoodCurve} from "../src/HoodCurve.sol";
import {HoodTokenLock} from "../src/HoodTokenLock.sol";
import {CurveConfig, CurveGuard, LaunchParams} from "../src/HoodTypes.sol";
import {TeamBuy} from "../src/TeamTypes.sol";

contract BlockZeroTest is BaseTest {
    HoodBlockZero internal zero;

    address internal lead = makeAddr("lead");
    address internal w1 = makeAddr("w1");
    address internal w2 = makeAddr("w2");
    address internal w3 = makeAddr("w3");

    function setUp() public override {
        super.setUp();
        zero = new HoodBlockZero(address(factory));
        vm.deal(lead, 1000 ether);
    }

    function _legs3() internal view returns (TeamBuy[] memory legs) {
        legs = new TeamBuy[](3);
        legs[0] = TeamBuy({wallet: w1, pairIn: 0.5 ether, minTokensOut: 0, lock: 0, gas: 0});
        legs[1] = TeamBuy({wallet: w2, pairIn: 0.3 ether, minTokensOut: 0, lock: 30 days, gas: 0});
        legs[2] = TeamBuy({wallet: w3, pairIn: 0.2 ether, minTokensOut: 0, lock: 0, gas: 0});
    }

    function _teamParams() internal view returns (LaunchParams memory p) {
        p = _params(_toCreator());
        p.creatorFeeRecipient = address(0);
        p.symbol = "TEAM";
        p.image = "ipfs://team";
    }

    function _go(LaunchParams memory p, TeamBuy[] memory legs, uint256 value)
        internal
        returns (address token, HoodCurve curve)
    {
        vm.prank(lead);
        (address t, address c) = zero.launch{value: value}(p, legs);
        return (t, HoodCurve(payable(c)));
    }

    function test_every_leg_buys_in_the_launch_transaction() public {
        (address token, HoodCurve curve) = _go(_teamParams(), _legs3(), LAUNCH_FEE + 1 ether);

        uint256 b1 = IERC20(token).balanceOf(w1);
        uint256 b3 = IERC20(token).balanceOf(w3);
        assertGt(b1, 0);
        assertGt(b3, 0);
        assertEq(IERC20(token).balanceOf(w2), 0, "the locked leg sits in the lock");

        // Nothing but the legs has touched the curve: the team is the whole of what was sold.
        assertEq(curve.sold(), zero.teamTokens(token));
        // Each leg pays the price the one before it left, so the first wallet gets the most per ETH.
        assertGt(b1 * 2, b3 * 5);

        HoodBlockZero.TeamWallet[] memory team = zero.teamOf(token);
        assertEq(team.length, 3);
        assertEq(team[0].wallet, w1);
        assertEq(team[0].tokens, b1);
        assertEq(team[1].unlockAt, uint64(block.timestamp) + 30 days);
        assertEq(team[1].lockId, 1);
        assertTrue(zero.isTeamWallet(token, w2));
        assertFalse(zero.isTeamWallet(token, alice));
        assertEq(zero.launcherOf(token), lead);
    }

    function test_the_launcher_gets_the_fee_stream_not_the_periphery() public {
        (address token,) = _go(_teamParams(), _legs3(), LAUNCH_FEE + 1 ether);
        assertEq(factory.creatorFeeRecipient(token), lead);
        // The registry row names the periphery as creator; the periphery names the launcher.
        assertEq(factory.getLaunch(token).creator, address(zero));
    }

    function test_an_explicit_fee_recipient_is_kept() public {
        LaunchParams memory p = _teamParams();
        p.creatorFeeRecipient = treasury;
        (address token,) = _go(p, _legs3(), LAUNCH_FEE + 1 ether);
        assertEq(factory.creatorFeeRecipient(token), treasury);
    }

    function test_a_locked_leg_opens_only_for_its_wallet_and_only_on_time() public {
        (address token,) = _go(_teamParams(), _legs3(), LAUNCH_FEE + 1 ether);
        HoodBlockZero.TeamWallet memory leg = zero.teamOf(token)[1];

        vm.prank(w2);
        vm.expectRevert(HoodTokenLock.StillLocked.selector);
        locker.withdraw(leg.lockId);

        vm.warp(block.timestamp + 30 days);
        vm.prank(lead);
        vm.expectRevert(HoodTokenLock.NotOwner.selector);
        locker.withdraw(leg.lockId);

        vm.prank(w2);
        locker.withdraw(leg.lockId);
        assertEq(IERC20(token).balanceOf(w2), leg.tokens);
    }

    function test_nothing_stays_in_the_periphery() public {
        (address token,) = _go(_teamParams(), _legs3(), LAUNCH_FEE + 1 ether);
        assertEq(address(zero).balance, 0);
        assertEq(IERC20(token).balanceOf(address(zero)), 0);
    }

    function test_a_leg_past_the_end_of_the_curve_refunds_the_launcher() public {
        TeamBuy[] memory legs = new TeamBuy[](2);
        legs[0] = TeamBuy({wallet: w1, pairIn: 1 ether, minTokensOut: 0, lock: 0, gas: 0});
        legs[1] = TeamBuy({wallet: w2, pairIn: 100 ether, minTokensOut: 0, lock: 0, gas: 0});
        uint256 before = lead.balance;
        (, HoodCurve curve) = _go(_teamParams(), legs, LAUNCH_FEE + 101 ether);

        assertEq(uint8(curve.phase()), 1, "sold out");
        // about 4.4 ETH of raise plus fees left the launcher, not 101
        assertGt(lead.balance, before - 6 ether);
        assertEq(address(zero).balance, 0);
    }

    function test_a_stray_balance_is_not_handed_to_a_launcher() public {
        vm.deal(address(zero), 3 ether);
        uint256 before = lead.balance;
        _go(_teamParams(), _legs3(), LAUNCH_FEE + 1 ether);
        assertEq(address(zero).balance, 3 ether);
        assertLt(lead.balance, before - 1 ether);
    }

    function test_dollar_legs() public {
        CurveConfig memory c = _config();
        c.pairToken = address(usd);
        c.startCap = 5_000e6;
        c.graduationCap = 50_000e6;
        vm.prank(owner);
        uint256 usdConfig = factory.addConfig(c);

        LaunchParams memory p = _teamParams();
        p.pairToken = address(usd);
        p.configId = usdConfig;

        TeamBuy[] memory legs = new TeamBuy[](2);
        legs[0] = TeamBuy({wallet: w1, pairIn: 1_000e6, minTokensOut: 0, lock: 90 days, gas: 0});
        legs[1] = TeamBuy({wallet: w2, pairIn: 500e6, minTokensOut: 0, lock: 0, gas: 0});

        usd.mint(lead, 1_500e6);
        usd.mint(address(zero), 77e6); // a stray must stay put
        vm.startPrank(lead);
        usd.approve(address(zero), 1_500e6);
        (address token,) = zero.launch{value: LAUNCH_FEE}(p, legs);
        vm.stopPrank();

        assertGt(IERC20(token).balanceOf(w2), 0);
        (, address lockOwner, uint128 amount,) = locker.locks(1);
        assertEq(lockOwner, w1);
        assertEq(amount, zero.teamOf(token)[0].tokens);
        assertEq(usd.balanceOf(address(zero)), 77e6);
        assertEq(usd.balanceOf(lead), 0);
    }

    function test_the_same_salt_from_two_launchers_does_not_collide() public {
        _go(_teamParams(), _legs3(), LAUNCH_FEE + 1 ether);

        LaunchParams memory p = _teamParams();
        p.symbol = "TEAM2";
        p.image = "ipfs://team2";
        TeamBuy[] memory legs = new TeamBuy[](1);
        legs[0] = TeamBuy({wallet: alice, pairIn: 0.1 ether, minTokensOut: 0, lock: 0, gas: 0});
        vm.prank(bob);
        (address token,) = zero.launch{value: LAUNCH_FEE + 0.1 ether}(p, legs);
        assertEq(zero.launcherOf(token), bob);
    }

    function test_a_leg_below_its_floor_reverts_the_launch() public {
        TeamBuy[] memory legs = _legs3();
        legs[0].minTokensOut = type(uint128).max;
        vm.prank(lead);
        vm.expectRevert(HoodCurve.Slippage.selector);
        zero.launch{value: LAUNCH_FEE + 1 ether}(_teamParams(), legs);
    }

    function test_refusals() public {
        LaunchParams memory p = _teamParams();
        TeamBuy[] memory legs = _legs3();

        vm.startPrank(lead);

        vm.expectRevert(HoodBlockZero.NoLegs.selector);
        zero.launch{value: LAUNCH_FEE}(p, new TeamBuy[](0));

        vm.expectRevert(HoodBlockZero.TooManyLegs.selector);
        zero.launch{value: LAUNCH_FEE}(p, new TeamBuy[](41));

        vm.expectRevert(HoodBlockZero.BadValue.selector);
        zero.launch{value: LAUNCH_FEE + 0.9 ether}(p, legs);

        vm.expectRevert(HoodBlockZero.BadValue.selector);
        zero.launch{value: LAUNCH_FEE + 1.1 ether}(p, legs);

        p.firstBuy = 1;
        vm.expectRevert(HoodBlockZero.UseLegs.selector);
        zero.launch{value: LAUNCH_FEE + 1 ether}(p, legs);
        p.firstBuy = 0;

        p.firstBuyLock = 30 days;
        vm.expectRevert(HoodBlockZero.UseLegs.selector);
        zero.launch{value: LAUNCH_FEE + 1 ether}(p, legs);
        p.firstBuyLock = 0;

        legs[2].wallet = w1;
        vm.expectRevert(HoodBlockZero.DuplicateWallet.selector);
        zero.launch{value: LAUNCH_FEE + 1 ether}(p, legs);
        legs[2].wallet = w3;

        legs[1].lock = 31 days;
        vm.expectRevert(HoodBlockZero.BadLock.selector);
        zero.launch{value: LAUNCH_FEE + 1 ether}(p, legs);
        legs[1].lock = 30 days;

        legs[2].wallet = address(0);
        vm.expectRevert(HoodBlockZero.ZeroAddress.selector);
        zero.launch{value: LAUNCH_FEE + 1 ether}(p, legs);
        legs[2].wallet = w3;

        legs[2].pairIn = 0;
        vm.expectRevert(HoodBlockZero.EmptyLeg.selector);
        zero.launch{value: LAUNCH_FEE + 0.8 ether}(p, legs);

        vm.stopPrank();
    }

    function testFuzz_legs_add_up(uint8 n, uint64 seed) public {
        n = uint8(bound(n, 1, 40));
        TeamBuy[] memory legs = new TeamBuy[](n);
        uint256 total;
        for (uint256 i; i < n; ++i) {
            uint256 amt = bound(uint256(keccak256(abi.encode(seed, i))), 0.001 ether, 0.1 ether);
            legs[i] = TeamBuy({
                wallet: address(uint160(0x1000 + i)), pairIn: amt, minTokensOut: 0, lock: i % 3 == 0 ? 7 days : 0,
                gas: i % 2 == 0 ? 0.001 ether : 0
            });
            total += amt + legs[i].gas;
        }
        (address token, HoodCurve curve) = _go(_teamParams(), legs, LAUNCH_FEE + total);

        uint256 sum;
        HoodBlockZero.TeamWallet[] memory team = zero.teamOf(token);
        for (uint256 i; i < n; ++i) {
            sum += team[i].tokens;
        }
        assertEq(sum, zero.teamTokens(token));
        assertEq(sum, curve.sold());
        assertEq(address(zero).balance, 0);
        assertEq(IERC20(token).balanceOf(address(zero)), 0);
    }
}
