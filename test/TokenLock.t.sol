// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {HoodTokenLock} from "../src/HoodTokenLock.sol";
import {MockUSD} from "./mocks/Mocks.sol";

/// @notice The plainest contract in the repo, and the tests are about what it refuses.
contract TokenLockTest is Test {
    HoodTokenLock internal lock;
    MockUSD internal token;

    address internal creator = makeAddr("creator");
    address internal stranger = makeAddr("stranger");

    function setUp() public {
        lock = new HoodTokenLock();
        token = new MockUSD();
        token.mint(address(this), 1_000_000e6);
        token.approve(address(lock), type(uint256).max);
    }

    function test_only_the_four_lengths_are_locks() public view {
        assertTrue(lock.isTier(7 days));
        assertTrue(lock.isTier(30 days));
        assertTrue(lock.isTier(90 days));
        assertTrue(lock.isTier(180 days));
        assertFalse(lock.isTier(0));
        assertFalse(lock.isTier(10 days));
        assertFalse(lock.isTier(365 days));
    }

    function test_a_lock_is_held_and_then_given_back() public {
        uint256 id = lock.lockFor(address(token), creator, 1_000e6, 30 days);
        (address t, address owner, uint128 amount, uint64 unlockAt) = lock.locks(id);
        assertEq(t, address(token));
        assertEq(owner, creator);
        assertEq(amount, 1_000e6);
        assertEq(unlockAt, uint64(block.timestamp) + 30 days);
        assertEq(lock.held(address(token)), 1_000e6);

        vm.prank(creator);
        vm.expectRevert(HoodTokenLock.StillLocked.selector);
        lock.withdraw(id);

        vm.warp(block.timestamp + 30 days);
        vm.prank(creator);
        assertEq(lock.withdraw(id), 1_000e6);
        assertEq(token.balanceOf(creator), 1_000e6);
        assertEq(lock.held(address(token)), 0);
    }

    function test_nobody_else_can_take_it_out() public {
        uint256 id = lock.lockFor(address(token), creator, 1_000e6, 7 days);
        vm.warp(block.timestamp + 8 days);

        vm.prank(stranger);
        vm.expectRevert(HoodTokenLock.NotOwner.selector);
        lock.withdraw(id);

        // not even whoever put the tokens in
        vm.expectRevert(HoodTokenLock.NotOwner.selector);
        lock.withdraw(id);
    }

    function test_a_lock_cannot_be_taken_twice() public {
        uint256 id = lock.lockFor(address(token), creator, 500e6, 7 days);
        vm.warp(block.timestamp + 8 days);
        vm.startPrank(creator);
        lock.withdraw(id);
        vm.expectRevert(HoodTokenLock.NoLock.selector);
        lock.withdraw(id);
        vm.stopPrank();
    }

    function test_an_odd_length_is_refused() public {
        vm.expectRevert(HoodTokenLock.NotATier.selector);
        lock.lockFor(address(token), creator, 1e6, 10 days);
    }

    function test_locking_nothing_is_refused() public {
        vm.expectRevert(HoodTokenLock.ZeroAmount.selector);
        lock.lockFor(address(token), creator, 0, 7 days);
    }

    /// @dev Two locks of the same token do not see each other's tokens: the second one's withdrawal
    ///      cannot reach into the first one's principal, which is the only way this contract could
    ///      ever lose somebody's money.
    function test_two_locks_of_the_same_token_stay_apart() public {
        uint256 a = lock.lockFor(address(token), creator, 400e6, 7 days);
        uint256 b = lock.lockFor(address(token), stranger, 600e6, 180 days);
        assertEq(lock.held(address(token)), 1_000e6);

        vm.warp(block.timestamp + 8 days);
        vm.prank(creator);
        lock.withdraw(a);
        assertEq(token.balanceOf(creator), 400e6);
        assertEq(lock.held(address(token)), 600e6);
        assertEq(token.balanceOf(address(lock)), 600e6, "the other lock is untouched");

        vm.warp(block.timestamp + 180 days);
        vm.prank(stranger);
        lock.withdraw(b);
        assertEq(token.balanceOf(stranger), 600e6);
    }
}
