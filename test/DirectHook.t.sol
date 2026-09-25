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
import {PenaltyConfig} from "../src/bag/BagTypes.sol";
import {MockBag} from "./mocks/DirectMocks.sol";

/// @notice The rate a trade pays: the part that is fixed, the platform's percent on top, the part
///         that is burning off, and the line none of them may cross.
contract DirectHookTest is Test {
    HoodLaunchHook internal hook;
    MockBag internal bag;
    address internal portal = address(this);
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
        hook = _fresh();
        hook.initialize(_params(500, 500, 5_000, 3));
    }

    function _params(uint16 buy, uint16 sell, uint16 snipe, uint32 window)
        internal
        view
        returns (HoodLaunchHook.InitParams memory p)
    {
        p = tpl;
        p.buyTaxBps = buy;
        p.sellTaxBps = sell;
        p.snipeTaxBps = snipe;
        p.snipeDecaySeconds = window;
    }

    function test_the_rate_starts_high_and_ends_at_the_launch_tax_plus_the_platforms_percent() public {
        vm.warp(hook.launchTime());
        assertEq(hook.currentTaxBps(true), 5_600, "the first instant is the tax, the percent and all of the surcharge");
        vm.warp(hook.launchTime() + 3);
        assertEq(hook.currentTaxBps(true), 600);
        assertEq(hook.currentTaxBps(false), 600, "a sell pays the same schedule and never the surcharge");
        assertEq(hook.currentSnipeBps(), 0);
    }

    /// @dev Quadratic rather than linear: half way through the window the surcharge is a quarter of
    ///      what it was, not half. A bot that waits one second of three saves most of it.
    /// @dev Absolute timestamps on purpose: under via-IR two `vm.warp(block.timestamp + x)` in a
    ///      row land on the same instant, because the second one reads a cached timestamp.
    function test_the_surcharge_falls_off_faster_than_a_straight_line() public {
        // Anchored to the hook's own clock rather than the test's, which is a different clock.
        uint256 start = hook.launchTime();
        vm.warp(start + 1);
        uint256 afterOneThird = hook.currentSnipeBps();
        uint256 twoThirdsSquared = (uint256(5_000) * 4) / 9;
        uint256 oneThirdSquared = uint256(5_000) / 9;
        assertApproxEqAbs(afterOneThird, twoThirdsSquared, 2, "two thirds remaining, squared");
        vm.warp(start + 2);
        assertApproxEqAbs(hook.currentSnipeBps(), oneThirdSquared, 2, "one third remaining, squared");
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

    function test_a_launch_cannot_be_configured_past_the_cap() public {
        HoodLaunchHook fresh = _fresh();
        // 10% + 90% is over the 99% line
        HoodLaunchHook.InitParams memory over = _params(1_000, 1_000, 9_000, 3);
        vm.expectRevert(HoodLaunchHook.BadTax.selector);
        fresh.initialize(over);
        // 10% + 89% sits on it, and at swap time the platform's percent comes off the surcharge
        fresh.initialize(_params(1_000, 1_000, 8_900, 3));
        assertEq(fresh.currentTaxBps(true), 9_900);
        // the wizard's default opening: 1% tax, 98% surcharge
        HoodLaunchHook wizard = _fresh();
        wizard.initialize(_params(100, 100, 9_800, 3));
        assertEq(wizard.currentTaxBps(true), 9_900);
    }

    /// @dev The snipe surcharge must decay within a bounded window (M3): without a ceiling on
    ///      `snipeDecaySeconds` a launch could set a 98% rate decaying over a century, a permanent
    ///      honeypot every screener reads as the base rate. This lives in the FAST suite on purpose:
    ///      mutation testing showed the bound was only covered by a fork test, and the fork job does
    ///      not gate CI, so a regression here would have slipped through.
    function test_a_launch_cannot_set_a_decay_window_past_the_ceiling() public {
        HoodLaunchHook fresh = _fresh();
        HoodLaunchHook.InitParams memory over = _params(100, 100, 500, uint32(fresh.MAX_SNIPE_DECAY_SECONDS()) + 1);
        vm.expectRevert(HoodLaunchHook.BadTax.selector);
        fresh.initialize(over);

        // and the boundary itself is allowed
        HoodLaunchHook ok = _fresh();
        ok.initialize(_params(100, 100, 500, uint32(ok.MAX_SNIPE_DECAY_SECONDS()))); // no revert
    }

    function test_a_launch_cannot_charge_more_than_a_tenth_per_side() public {
        HoodLaunchHook fresh = _fresh();
        HoodLaunchHook.InitParams memory over = _params(1_001, 500, 0, 0);
        vm.expectRevert(HoodLaunchHook.BadTax.selector);
        fresh.initialize(over);
    }

    function test_a_launch_needs_a_bag_and_penalties_under_their_ceilings() public {
        HoodLaunchHook fresh = _fresh();
        HoodLaunchHook.InitParams memory p = _params(500, 500, 0, 0);
        p.bag = address(0);
        vm.expectRevert(HoodLaunchHook.NoBag.selector);
        fresh.initialize(p);

        p.bag = address(bag);
        p.penalties = PenaltyConfig(2_501, 60, 0, 0, 0, false);
        vm.expectRevert(HoodLaunchHook.BadPenalty.selector);
        fresh.initialize(p);
        p.penalties = PenaltyConfig(0, 0, 2_501, 300, 0, false);
        vm.expectRevert(HoodLaunchHook.BadPenalty.selector);
        fresh.initialize(p);
        p.penalties = PenaltyConfig(0, 0, 0, 0, 5_001, false);
        vm.expectRevert(HoodLaunchHook.BadPenalty.selector);
        fresh.initialize(p);

        p.penalties = PenaltyConfig(2_500, 3_600, 2_500, 2_000, 5_000, true);
        fresh.initialize(p);
        (uint16 jeet, uint32 window, uint16 whale, uint24 limit, uint16 king, bool toVault) = fresh.penalties();
        assertEq(jeet, 2_500);
        assertEq(window, 3_600);
        assertEq(whale, 2_500);
        assertEq(limit, 2_000);
        assertEq(king, 5_000);
        assertTrue(toVault);
        assertEq(fresh.vault(), bag.vault(), "the vault is read off the Bag");
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
        token.initialize("T", "T", "", "", Socials("", "", "", "", ""), SUPPLY, creator, 0, 10_000, 10_000);
        splitter = new HoodRevenueSplitter(address(this), makeAddr("treasury"), makeAddr("buyback"), address(token), address(0));
        splitter.initialize(creator, makeAddr("locker"), Allocations(2_500, 2_500, 4_000, 1_000));
        splitter.exclude(pool);
        token.setLaunchAddresses(pool, address(splitter), makeAddr("locker"), makeAddr("hook"), makeAddr("buybackModule"));
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
