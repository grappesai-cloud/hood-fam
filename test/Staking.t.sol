// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {BaseTest} from "./Base.t.sol";
import {HoodCurve} from "../src/HoodCurve.sol";
import {HoodStaking} from "../src/HoodStaking.sol";

/// @notice Proof of belief: longer locks take a larger share of the same fee stream.
contract StakingTest is BaseTest {
    address internal token;
    HoodCurve internal curve;

    function setUp() public override {
        super.setUp();
        (token, curve) = _launch(_toStakers());
        _buy(curve, alice, 1 ether);
        _buy(curve, bob, 1 ether);
    }

    function _stake(address who, uint256 amount, uint64 lock) internal returns (uint256 id) {
        vm.startPrank(who);
        IERC20(token).approve(address(staking), amount);
        id = staking.stake(token, amount, lock);
        vm.stopPrank();
    }

    function _reward(uint256 amount) internal {
        vm.deal(address(this), amount);
        staking.notifyReward{value: amount}(token, amount);
    }

    /// @dev A direct launch pays its holders out of its own splitter, by balance. Locking those
    ///      tokens here would hand their dividend share to this contract, which cannot pass it on
    ///      and cannot give it back, and the position would earn nothing because nothing routes a
    ///      direct launch's fees here. So the vault refuses them at the door.
    function test_a_direct_launch_cannot_be_staked_here() public {
        address direct = makeAddr("directToken");
        vm.prank(owner);
        factory.setPortal(address(this));
        factory.registerDirectLaunch(direct, creator, address(0), makeAddr("hook"), makeAddr("splitter"), makeAddr("locker"), "DIRECT", "");

        vm.expectRevert(HoodStaking.NotACurveLaunch.selector);
        staking.stake(direct, 1e18, 0);
    }

    function test_lock_length_sets_the_multiplier() public view {
        assertEq(staking.weightFor(0), 10_000);
        assertEq(staking.weightFor(7 days), 12_500);
        assertEq(staking.weightFor(30 days), 15_000);
        assertEq(staking.weightFor(90 days), 20_000);
        assertEq(staking.weightFor(180 days), 25_000);
        assertEq(staking.weightFor(400 days), 25_000);
    }

    function test_rewards_split_by_weight_not_by_size() public {
        uint256 amount = 1_000_000e18;
        uint256 flexible = _stake(alice, amount, 0); // 1x
        uint256 locked = _stake(bob, amount, 180 days); // 2.5x

        _reward(3.5 ether);

        assertApproxEqAbs(staking.pending(flexible), 1 ether, 10);
        assertApproxEqAbs(staking.pending(locked), 2.5 ether, 10);
    }

    function test_a_stake_that_arrives_later_does_not_take_earlier_rewards() public {
        uint256 first = _stake(alice, 1_000_000e18, 0);
        _reward(1 ether);
        uint256 second = _stake(bob, 1_000_000e18, 0);

        assertApproxEqAbs(staking.pending(first), 1 ether, 10);
        assertEq(staking.pending(second), 0);

        _reward(1 ether);
        assertApproxEqAbs(staking.pending(first), 1.5 ether, 10);
        assertApproxEqAbs(staking.pending(second), 0.5 ether, 10);
    }

    function test_rewards_that_arrive_before_the_first_staker_are_not_lost() public {
        _reward(1 ether);
        assertEq(staking.orphanRewards(token), 1 ether);

        uint256 id = _stake(alice, 1_000_000e18, 0);
        assertEq(staking.orphanRewards(token), 0);
        assertApproxEqAbs(staking.pending(id), 1 ether, 10);
    }

    function test_send_a_stake_gives_the_upside_without_the_exit() public {
        uint256 amount = 500_000e18;
        vm.startPrank(alice);
        IERC20(token).approve(address(staking), amount);
        uint256 id = staking.stakeFor(token, bob, amount, 90 days);
        vm.stopPrank();

        (, address positionOwner,,,,) = staking.positions(id);
        assertEq(positionOwner, bob);

        _reward(1 ether);
        uint256 before = bob.balance;
        staking.claim(id);
        assertApproxEqAbs(bob.balance - before, 1 ether, 10);

        // and neither of them can pull the tokens out early
        vm.prank(bob);
        vm.expectRevert(HoodStaking.StillLocked.selector);
        staking.unstake(id);
        vm.prank(alice);
        vm.expectRevert(HoodStaking.NotOwner.selector);
        staking.unstake(id);

        vm.warp(block.timestamp + 90 days);
        uint256 tokensBefore = IERC20(token).balanceOf(bob);
        vm.prank(bob);
        (uint256 principal,) = staking.unstake(id);
        assertEq(principal, amount);
        assertEq(IERC20(token).balanceOf(bob) - tokensBefore, amount);
    }

    function test_an_expired_lock_stops_earning_the_long_lock_share() public {
        uint256 flexible = _stake(alice, 1_000_000e18, 0);
        uint256 locked = _stake(bob, 1_000_000e18, 7 days);
        assertEq(staking.totalWeight(token), 1_000_000e18 + (1_000_000e18 * 12_500) / 10_000);

        _reward(2.25 ether);
        vm.warp(block.timestamp + 8 days);

        // anybody can call it; it pays out what was earned at the old weight first
        uint256 before = bob.balance;
        staking.demote(locked);
        assertApproxEqAbs(bob.balance - before, 1.25 ether, 10);
        assertEq(staking.totalWeight(token), 2_000_000e18);
        assertEq(staking.pending(locked), 0);

        _reward(2 ether);
        assertApproxEqAbs(staking.pending(locked), 1 ether, 20);
        assertApproxEqAbs(staking.pending(flexible), 2 ether, 20);
    }

    function test_demote_waits_for_the_lock() public {
        uint256 id = _stake(alice, 1_000e18, 30 days);
        vm.expectRevert(HoodStaking.StillLocked.selector);
        staking.demote(id);
    }

    function test_unstake_returns_the_principal_and_the_rewards() public {
        uint256 amount = 1_000_000e18;
        uint256 id = _stake(alice, amount, 0);
        _reward(1 ether);

        uint256 ethBefore = alice.balance;
        vm.prank(alice);
        (uint256 principal, uint256 rewards) = staking.unstake(id);

        assertEq(principal, amount);
        assertApproxEqAbs(rewards, 1 ether, 10);
        assertApproxEqAbs(alice.balance - ethBefore, 1 ether, 10);
        assertEq(staking.totalWeight(token), 0);
    }
}
