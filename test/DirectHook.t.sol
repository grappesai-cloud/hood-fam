// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {BaseHook} from "@uniswap/v4-periphery/src/utils/BaseHook.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";

import {HoodLaunchHook} from "../src/direct/HoodLaunchHook.sol";
import {HoodLaunchToken} from "../src/direct/HoodLaunchToken.sol";
import {HoodRevenueSplitter} from "../src/direct/HoodRevenueSplitter.sol";
import {Allocations, Socials} from "../src/direct/DirectTypes.sol";

/// @dev A hook's constructor checks that its own address carries the right permission bits, which
///      is exactly what we do not want while testing the arithmetic. Overriding the check is what
///      the base contract makes virtual for.
contract HookHarness is HoodLaunchHook {
    constructor(IPoolManager manager, address portal_) HoodLaunchHook(manager, portal_) {}

    function validateHookAddress(BaseHook) internal pure override {}
}

/// @notice The rate a trade pays: the part that is fixed, the part that is burning off, and the
///         line neither of them may cross.
contract DirectHookTest is Test {
    HookHarness internal hook;
    address internal portal = address(this);

    function setUp() public {
        hook = new HookHarness(IPoolManager(makeAddr("poolManager")), portal);
        PoolKey memory key = PoolKey({
            currency0: Currency.wrap(address(0)),
            currency1: Currency.wrap(makeAddr("token")),
            fee: 10_000,
            tickSpacing: 200,
            hooks: IHooks(address(hook))
        });
        HoodLaunchHook.InitParams memory p;
        p.token = makeAddr("token");
        p.quote = address(0);
        p.splitter = makeAddr("splitter");
        p.factory = address(0);
        p.tokenIsZero = false;
        p.buyTaxBps = 500;
        p.sellTaxBps = 500;
        p.snipeTaxBps = 5_000;
        p.snipeDecaySeconds = 3;
        p.tickBond = 161_200;
        p.key = key;
        hook.initialize(p);
    }

    function test_the_rate_starts_high_and_ends_at_the_launch_tax() public {
        vm.warp(hook.launchTime());
        assertEq(hook.currentTaxBps(true), 5_500, "the first instant is the launch tax plus all of the surcharge");
        vm.warp(hook.launchTime() + 3);
        assertEq(hook.currentTaxBps(true), 500);
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
        HookHarness fresh = new HookHarness(IPoolManager(makeAddr("pm2")), portal);
        HoodLaunchHook.InitParams memory p;
        p.token = makeAddr("token");
        p.quote = address(0);
        p.splitter = makeAddr("splitter");
        p.buyTaxBps = 1_000;
        p.sellTaxBps = 1_000;
        p.snipeTaxBps = 9_000; // 10% + 90% is over the 99% line
        p.snipeDecaySeconds = 3;
        vm.expectRevert(HoodLaunchHook.BadTax.selector);
        fresh.initialize(p);
    }

    /// @dev The snipe surcharge must decay within a bounded window (M3): without a ceiling on
    ///      `snipeDecaySeconds` a launch could set a 98% rate decaying over a century, a permanent
    ///      honeypot every screener reads as the base rate. This lives in the FAST suite on purpose:
    ///      mutation testing showed the bound was only covered by a fork test, and the fork job does
    ///      not gate CI, so a regression here would have slipped through.
    function test_a_launch_cannot_set_a_decay_window_past_the_ceiling() public {
        HookHarness fresh = new HookHarness(IPoolManager(makeAddr("pmDecay")), portal);
        HoodLaunchHook.InitParams memory p;
        p.token = makeAddr("token");
        p.splitter = makeAddr("splitter");
        p.buyTaxBps = 100;
        p.sellTaxBps = 100;
        p.snipeTaxBps = 500;
        p.snipeDecaySeconds = uint32(fresh.MAX_SNIPE_DECAY_SECONDS()) + 1;
        vm.expectRevert(HoodLaunchHook.BadTax.selector);
        fresh.initialize(p);

        // and the boundary itself is allowed
        HookHarness ok = new HookHarness(IPoolManager(makeAddr("pmDecayOk")), portal);
        p.snipeDecaySeconds = uint32(ok.MAX_SNIPE_DECAY_SECONDS());
        ok.initialize(p); // no revert
    }

    function test_a_launch_cannot_charge_more_than_a_tenth_per_side() public {
        HookHarness fresh = new HookHarness(IPoolManager(makeAddr("pm3")), portal);
        HoodLaunchHook.InitParams memory p;
        p.token = makeAddr("token");
        p.splitter = makeAddr("splitter");
        p.buyTaxBps = 1_001;
        p.sellTaxBps = 500;
        vm.expectRevert(HoodLaunchHook.BadTax.selector);
        fresh.initialize(p);
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
