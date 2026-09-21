// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {BaseTest} from "./Base.t.sol";
import {HoodCurve} from "../src/HoodCurve.sol";
import {HoodStaking} from "../src/HoodStaking.sol";
import {HoodFactory} from "../src/HoodFactory.sol";
import {LaunchParams} from "../src/HoodTypes.sol";

/// @notice One vault, one coin: locking the house coin earns the stakers leg of every launch.
contract StakingTest is BaseTest {
    address internal token;
    HoodCurve internal curve;

    function setUp() public override {
        super.setUp();
        (token, curve) = _house();
    }

    /// @dev Balances handed out rather than bought, so two positions can be the same size and the
    ///      weight is the only thing telling them apart.
    function _lock(address who, uint256 amount, uint64 lock) internal returns (uint256 id) {
        deal(token, who, amount);
        vm.startPrank(who);
        IERC20(token).approve(address(staking), amount);
        id = staking.stake(amount, lock);
        vm.stopPrank();
    }

    function _reward(uint256 amount) internal {
        vm.deal(address(this), amount);
        staking.notifyReward{value: amount}(address(0), amount);
    }

    function _rewardUsd(uint256 amount) internal {
        usd.mint(address(this), amount);
        usd.transfer(address(staking), amount);
        staking.notifyReward(address(usd), amount);
    }

    // ---------------------------------------------------------------- the coin

    function test_the_house_coin_is_named_once_and_only_by_the_owner() public {
        assertEq(staking.houseToken(), token);

        vm.prank(alice);
        vm.expectRevert(HoodStaking.NotOwner.selector);
        staking.setHouseToken(makeAddr("other"));

        vm.prank(owner);
        vm.expectRevert(HoodStaking.HouseTokenAlreadySet.selector);
        staking.setHouseToken(makeAddr("other"));
    }

    /// @dev The whole point of the change: a launch's own token is not lockable anywhere, so a
    ///      creator cannot invent a staking economy around their own coin. There is one.
    function test_nothing_can_be_locked_before_the_coin_is_named() public {
        HoodStaking fresh = new HoodStaking(address(factory));
        vm.expectRevert(HoodStaking.NoHouseToken.selector);
        fresh.stake(1e18, 0);
    }

    /// @dev And a launch cannot promise a share to a room nobody can enter.
    function test_a_stakers_leg_is_refused_until_the_coin_exists() public {
        HoodFactory bare = new HoodFactory(owner, treasury, makeAddr("deployer"));
        HoodStaking vault = new HoodStaking(address(bare));
        vm.startPrank(owner);
        bare.setModules(address(router), address(vault), address(graduator));
        bare.setLaunchFee(LAUNCH_FEE);
        bare.addConfig(_config());
        bare.setPair(address(0), true, 0);
        vm.stopPrank();

        vm.prank(creator);
        vm.expectRevert(HoodFactory.NoHouseToken.selector);
        bare.launch{value: LAUNCH_FEE}(_params(_toStakers()));
    }

    // ---------------------------------------------------------------- weights

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
        uint256 flexible = _lock(alice, amount, 0); // 1x
        uint256 locked = _lock(bob, amount, 180 days); // 2.5x

        _reward(3.5 ether);

        assertApproxEqAbs(staking.pending(flexible, address(0)), 1 ether, 10);
        assertApproxEqAbs(staking.pending(locked, address(0)), 2.5 ether, 10);
    }

    function test_a_stake_that_arrives_later_does_not_take_earlier_rewards() public {
        uint256 first = _lock(alice, 1_000_000e18, 0);
        _reward(1 ether);
        uint256 second = _lock(bob, 1_000_000e18, 0);

        assertApproxEqAbs(staking.pending(first, address(0)), 1 ether, 10);
        assertEq(staking.pending(second, address(0)), 0);

        _reward(1 ether);
        assertApproxEqAbs(staking.pending(first, address(0)), 1.5 ether, 10);
        assertApproxEqAbs(staking.pending(second, address(0)), 0.5 ether, 10);
    }

    function test_rewards_that_arrive_before_the_first_staker_are_not_lost() public {
        _reward(1 ether);
        assertEq(staking.orphanRewards(address(0)), 1 ether);

        uint256 id = _lock(alice, 1_000_000e18, 0);
        assertEq(staking.orphanRewards(address(0)), 0);
        assertApproxEqAbs(staking.pending(id, address(0)), 1 ether, 10);
    }

    // ---------------------------------------------------------------- several assets

    /// @dev One vault now takes rewards from launches paired against different things. The streams
    ///      are separate: a stablecoin reward must never be handed out as if it were the chain's
    ///      own currency, and a position that opened later must not reach back into either.
    function test_two_assets_are_two_streams() public {
        uint256 alicePos = _lock(alice, 1_000_000e18, 0);
        _reward(2 ether);
        _rewardUsd(1_000e6);

        assertApproxEqAbs(staking.pending(alicePos, address(0)), 2 ether, 10);
        assertApproxEqAbs(staking.pending(alicePos, address(usd)), 1_000e6, 10);

        uint256 bobPos = _lock(bob, 1_000_000e18, 0);
        assertEq(staking.pending(bobPos, address(0)), 0, "nothing from before it existed");
        assertEq(staking.pending(bobPos, address(usd)), 0);

        _rewardUsd(1_000e6);
        assertApproxEqAbs(staking.pending(bobPos, address(usd)), 500e6, 10);

        uint256 ethBefore = alice.balance;
        uint256 usdBefore = usd.balanceOf(alice);
        staking.claim(alicePos);
        assertApproxEqAbs(alice.balance - ethBefore, 2 ether, 10);
        assertApproxEqAbs(usd.balanceOf(alice) - usdBefore, 1_500e6, 10);

        (address[] memory assets,) = staking.pendingAll(alicePos);
        assertEq(assets.length, 2);
    }

    // ---------------------------------------------------------------- positions

    function test_send_a_stake_gives_the_upside_without_the_exit() public {
        uint256 amount = 500_000e18;
        deal(token, alice, amount);
        vm.startPrank(alice);
        IERC20(token).approve(address(staking), amount);
        uint256 id = staking.stakeFor(bob, amount, 90 days);
        vm.stopPrank();

        (address positionOwner,,,) = staking.positions(id);
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
        uint256 principal = staking.unstake(id);
        assertEq(principal, amount);
        assertEq(IERC20(token).balanceOf(bob) - tokensBefore, amount);
    }

    function test_an_expired_lock_stops_earning_the_long_lock_share() public {
        uint256 flexible = _lock(alice, 1_000_000e18, 0);
        uint256 locked = _lock(bob, 1_000_000e18, 7 days);
        assertEq(staking.totalWeight(), 1_000_000e18 + (1_000_000e18 * 12_500) / 10_000);

        _reward(2.25 ether);
        vm.warp(block.timestamp + 8 days);

        // anybody can call it; it pays out what was earned at the old weight first
        uint256 before = bob.balance;
        staking.demote(locked);
        assertApproxEqAbs(bob.balance - before, 1.25 ether, 10);
        assertEq(staking.totalWeight(), 2_000_000e18);
        assertEq(staking.pending(locked, address(0)), 0);

        _reward(2 ether);
        assertApproxEqAbs(staking.pending(locked, address(0)), 1 ether, 20);
        assertApproxEqAbs(staking.pending(flexible, address(0)), 2 ether, 20);
    }

    function test_demote_waits_for_the_lock() public {
        uint256 id = _lock(alice, 1_000e18, 30 days);
        vm.expectRevert(HoodStaking.StillLocked.selector);
        staking.demote(id);
    }

    function test_unstake_returns_the_principal_and_the_rewards() public {
        uint256 amount = 1_000_000e18;
        uint256 id = _lock(alice, amount, 0);
        _reward(1 ether);

        uint256 ethBefore = alice.balance;
        vm.prank(alice);
        uint256 principal = staking.unstake(id);

        assertEq(principal, amount);
        assertApproxEqAbs(alice.balance - ethBefore, 1 ether, 10);
        assertEq(staking.totalWeight(), 0);
    }

    // ---------------------------------------------------------------- the whole board

    /// @dev The reason the vault changed: one position, paid by launches it has nothing to do with.
    function test_every_launch_pays_the_same_room() public {
        uint256 id = _lock(alice, 1_000_000e18, 0);

        (address first, HoodCurve firstCurve) = _launch(_toStakers());
        _buy(firstCurve, bob, 1 ether);
        router.flush(first);
        uint256 afterFirst = staking.pending(id, address(0));
        assertGt(afterFirst, 0, "a launch alice never touched pays her");

        LaunchParams memory p = _params(_toStakers());
        p.name = "Second";
        p.symbol = "SECOND";
        p.salt = bytes32(uint256(22));
        (address second, HoodCurve secondCurve) = _launch(_toStakers(), p, LAUNCH_FEE);
        _buy(secondCurve, bob, 1 ether);
        router.flush(second);
        assertGt(staking.pending(id, address(0)), afterFirst, "and so does the next one");
    }
}
