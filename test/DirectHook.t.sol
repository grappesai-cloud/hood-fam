// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";

import {HoodLaunchHook} from "../src/direct/HoodLaunchHook.sol";
import {HoodLaunchToken} from "../src/direct/HoodLaunchToken.sol";
import {HoodRevenueSplitter} from "../src/direct/HoodRevenueSplitter.sol";
import {Allocations, Socials} from "../src/direct/DirectTypes.sol";
import {SnipeSchedule} from "../src/libraries/SnipeSchedule.sol";
import {MockBag} from "./mocks/DirectMocks.sol";

/// @notice The rate a trade pays: the part that is fixed, the platform's percent on top, the opening
///         tax that every launch runs, and the line none of them may cross.
contract DirectHookTest is Test {
    HoodLaunchHook internal hook;
    MockBag internal bag;
    address internal portal = address(this);
    address internal launcher = makeAddr("launcher");
    address internal team = makeAddr("team");
    uint160 internal nextHook = 0x444400CC;

    /// @dev A real hook reads its permissions off its own address, so each one is etched at an
    ///      address whose low bits say beforeSwap, afterSwap and both return deltas.
    function _fresh() internal returns (HoodLaunchHook h) {
        address at = address(nextHook);
        nextHook += 0x10000;
        deployCodeTo("HoodLaunchHook.sol:HoodLaunchHook", abi.encode(IPoolManager(makeAddr("poolManager")), portal), at);
        h = HoodLaunchHook(payable(at));
    }

    /// @dev A storage template, copied per call: building the whole struct in one frame is one
    ///      variable too many for the compiler.
    HoodLaunchHook.InitParams internal tpl;

    function setUp() public {
        bag = new MockBag();
        tpl.token = makeAddr("token");
        tpl.splitter = makeAddr("splitter");
        tpl.bag = address(bag);
        tpl.tickBond = 161_200;
        tpl.key.currency1 = Currency.wrap(makeAddr("token"));
        tpl.key.fee = 10_000;
        tpl.key.tickSpacing = 200;
        tpl.exempt.push(launcher);
        tpl.exempt.push(team);
        hook = _fresh();
        hook.initialize(_params(500, 500));
    }

    function _params(uint16 buy, uint16 sell) internal view returns (HoodLaunchHook.InitParams memory p) {
        p = tpl;
        p.buyTaxBps = buy;
        p.sellTaxBps = sell;
    }

    /// @dev Absolute timestamps on purpose: under via-IR two `vm.warp(block.timestamp + x)` in a
    ///      row land on the same instant, because the second one reads a cached timestamp.
    function test_the_open_runs_the_pons_schedule_then_settles_at_the_tax_plus_the_platforms_percent() public {
        uint256 start = hook.launchTime();
        vm.warp(start);
        assertEq(hook.currentTaxBps(true), 9_900, "99% in the launch's own second, capped all in");
        assertEq(hook.currentSnipeTaxBps(address(0xB0B)), 9_900);
        vm.warp(start + 1);
        assertEq(hook.currentTaxBps(true), 600 + 618);
        vm.warp(start + 2);
        assertEq(hook.currentTaxBps(true), 600 + 19);
        vm.warp(start + 3);
        assertEq(hook.currentTaxBps(true), 600);
        assertEq(hook.currentTaxBps(false), 600, "a sell pays the same schedule and never the opening tax");
        assertEq(hook.currentSnipeTaxBps(address(0xB0B)), 0);
    }

    function test_named_wallets_pay_no_opening_tax() public {
        vm.warp(hook.launchTime());
        assertEq(hook.currentSnipeTaxBps(launcher), 0);
        assertEq(hook.currentSnipeTaxBps(team), 0);
        assertTrue(hook.snipeExempt(team));
        assertFalse(hook.snipeExempt(address(0xB0B)));
    }

    function test_the_table_is_the_one_pons_charges() public pure {
        assertEq(SnipeSchedule.bpsAt(0), 9_900);
        assertEq(SnipeSchedule.bpsAt(1), 618);
        assertEq(SnipeSchedule.bpsAt(2), 19);
        assertEq(SnipeSchedule.bpsAt(3), 0);
        assertEq(SnipeSchedule.bpsAt(type(uint64).max), 0);
    }

    function testFuzz_the_rate_never_passes_the_cap(uint32 elapsed, bool isBuy) public {
        vm.warp(block.timestamp + bound(elapsed, 0, 10_000));
        assertLe(hook.currentTaxBps(isBuy), hook.MAX_COMBINED_BPS());
    }

    function testFuzz_the_rate_only_ever_falls(uint32 a, uint32 b) public {
        uint256 first = bound(a, 0, 100);
        uint256 second = bound(b, first, 100);
        uint256 start = hook.launchTime();

        vm.warp(start + first);
        uint256 early = hook.currentTaxBps(true);
        vm.warp(start + second);
        assertLe(hook.currentTaxBps(true), early);
    }

    function test_a_launch_cannot_charge_more_than_a_tenth_per_side() public {
        HoodLaunchHook fresh = _fresh();
        HoodLaunchHook.InitParams memory over = _params(1_001, 500);
        vm.expectRevert(HoodLaunchHook.BadTax.selector);
        fresh.initialize(over);
        over = _params(500, 99);
        vm.expectRevert(HoodLaunchHook.BadTax.selector);
        fresh.initialize(over);
    }

    function test_a_launch_needs_a_bag_and_initializes_once() public {
        HoodLaunchHook fresh = _fresh();
        HoodLaunchHook.InitParams memory p = _params(500, 500);
        p.bag = address(0);
        vm.expectRevert(HoodLaunchHook.NoBag.selector);
        fresh.initialize(p);

        p.bag = address(bag);
        fresh.initialize(p);
        vm.expectRevert(HoodLaunchHook.AlreadyInitialized.selector);
        fresh.initialize(p);
        HoodLaunchHook other = _fresh();
        vm.prank(makeAddr("stranger"));
        vm.expectRevert(HoodLaunchHook.NotPortal.selector);
        other.initialize(p);
    }
}

/// @notice The accountant must never be able to freeze the token it accounts for.
contract DividendSafetyTest is Test {
    HoodLaunchToken internal token;
    HoodRevenueSplitter internal splitter;
    address internal pool = makeAddr("poolManager");
    address internal creator = makeAddr("creator");

    uint256 internal constant SUPPLY = 1_000_000_000e18;

    function setUp() public {
        token = HoodLaunchToken(Clones.clone(address(new HoodLaunchToken())));
        token.initialize("T", "T", "", "", Socials("", "", "", "", ""), SUPPLY, creator);
        splitter = new HoodRevenueSplitter(address(this), makeAddr("treasury"), makeAddr("buyback"), address(token), address(0));
        splitter.initialize(creator, makeAddr("locker"), Allocations(2_500, 2_500, 4_000, 1_000));
        splitter.exclude(pool);
        token.setLaunchAddresses(pool, address(splitter));
        token.transfer(pool, SUPPLY);
    }

    function testFuzz_transfers_keep_working_whatever_the_accumulator_is_doing(
        uint96 firstBuy,
        uint96 reward,
        uint96 move
    ) public {
        uint256 bought = bound(firstBuy, 1e18, SUPPLY / 2);
        address alice = makeAddr("alice");
        address bob = makeAddr("bob");

        vm.prank(pool);
        token.transfer(alice, bought);

        vm.deal(address(splitter), bound(reward, 0, 100 ether));
        splitter.sweep();

        uint256 moved = bound(move, 0, bought);
        vm.prank(alice);
        token.transfer(bob, moved);

        assertEq(token.balanceOf(alice), bought - moved);
        assertEq(token.balanceOf(bob), moved);
        // and the books still add up
        assertLe(splitter.accounted(), address(splitter).balance);
        assertEq(splitter.eligibleSupply(), token.balanceOf(alice) + token.balanceOf(bob));
    }

    function test_a_holder_who_sells_everything_keeps_what_they_earned() public {
        address alice = makeAddr("alice");
        vm.prank(pool);
        token.transfer(alice, SUPPLY / 2);

        vm.deal(address(splitter), 10 ether);
        splitter.sweep();
        uint256 owed = splitter.pendingDividends(alice);
        assertGt(owed, 0);

        vm.prank(alice);
        token.transfer(pool, SUPPLY / 2);

        assertEq(splitter.pendingDividends(alice), owed, "selling does not forfeit what was already earned");
        splitter.claimDividends(alice);
        assertEq(alice.balance, owed);
    }
}
