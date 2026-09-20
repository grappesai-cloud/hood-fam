// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {BaseTest} from "./Base.t.sol";
import {HoodCurve} from "../src/HoodCurve.sol";
import {HoodFactory} from "../src/HoodFactory.sol";
import {HoodFeeRouter} from "../src/HoodFeeRouter.sol";
import {CurveConfig, FeeSplit, LaunchParams} from "../src/HoodTypes.sol";

/// @notice The four roads the creator leg of the trading fee can take, and the split that decides
///         how much of it takes each one.
contract FeeSplitTest is BaseTest {
    // ---------------------------------------------------------------- one road at a time

    function test_staking_rewards_go_to_the_people_who_locked() public {
        (address token, HoodCurve curve) = _launch(_toStakers());

        _buy(curve, alice, 1 ether);
        uint256 amount = IERC20(token).balanceOf(alice);
        vm.startPrank(alice);
        IERC20(token).approve(address(staking), amount);
        uint256 id = staking.stake(token, amount, 30 days);
        vm.stopPrank();

        _buy(curve, bob, 1 ether);
        uint256 booked = router.accrued(token);
        assertGt(booked, 0);

        router.flush(token);
        assertEq(router.accrued(token), 0);
        // the accumulator keeps a wei of dust; everything else reaches the staker
        assertApproxEqAbs(staking.pending(id), booked, 2);

        uint256 before = alice.balance;
        staking.claim(id); // anybody can push the payout
        assertApproxEqAbs(alice.balance - before, booked, 2);
    }

    function test_buyback_and_burn_takes_supply_off_the_table() public {
        (address token, HoodCurve curve) = _launch(_toBuyback());
        _buy(curve, alice, 2 ether);

        uint256 supplyBefore = IERC20(token).totalSupply();
        uint256 booked = router.accrued(token);
        // A buy on the curve moves the curve's price, so a floorless buyback is somebody else's
        // sandwich whether the token has graduated or not: both paths go through flushBuyback.
        vm.expectRevert(HoodFeeRouter.NeedsSwapFloor.selector);
        router.flush(token);
        router.flushBuyback(token, 1);

        assertLt(IERC20(token).totalSupply(), supplyBefore, "the bought tokens are gone");
        assertEq(IERC20(token).balanceOf(address(router)), 0);
        // the buyback itself pays a fee, which books the next round
        assertLt(router.accrued(token), booked);
    }

    function test_liquidity_compounding_deepens_what_the_token_graduates_into() public {
        (address token, HoodCurve curve) = _launch(_toLiquidity());
        _buy(curve, alice, 2 ether);

        uint256 booked = router.accrued(token);
        router.flush(token);
        assertEq(curve.bonus(), booked);

        _graduate(curve);
        (, uint256 pairReserve,) = graduator.pools(token);
        assertGt(pairReserve, (curve.raiseTarget() * 9000) / 10_000);
    }

    function test_creator_keep_pays_the_recipient_and_only_the_recipient() public {
        (address token, HoodCurve curve) = _launch(_toCreator());
        _buy(curve, alice, 2 ether);

        uint256 booked = router.accrued(token);
        uint256 before = creator.balance;
        router.flush(token);
        assertEq(creator.balance - before, booked);

        // the stream can be handed over, in one step, by whoever holds it
        vm.prank(creator);
        factory.transferCreatorFeeRecipient(token, bob);
        _buy(curve, alice, 1 ether);
        uint256 bobBefore = bob.balance;
        router.flush(token);
        assertGt(bob.balance, bobBefore);
    }

    /// @dev There is no leg for "charge nothing": a launch that wants traders to pay the protocol
    ///      and nobody else picks a preset whose creator fee is zero, and then nothing is booked.
    function test_a_preset_with_no_creator_fee_never_books_anything_to_split() public {
        CurveConfig memory c = _config();
        c.creatorFeeBps = 0;
        vm.prank(owner);
        uint256 freeConfig = factory.addConfig(c);

        LaunchParams memory p = _params(_toStakers());
        p.configId = freeConfig;
        (address token, HoodCurve curve) = _launch(_toStakers(), p, LAUNCH_FEE);
        assertEq(curve.creatorFeeBps(), 0);
        assertEq(curve.protocolFeeBps(), 30);

        uint256 treasuryBefore = treasury.balance;
        _buy(curve, alice, 1 ether);
        assertEq(router.accrued(token), 0, "nothing is ever booked when the creator leg is zero");
        // the protocol's leg is booked on the curve and pulled out by anybody
        assertApproxEqRel(curve.protocolClaimable(), 0.003 ether, 0.01e18);
        curve.claimProtocol();
        assertApproxEqRel(treasury.balance - treasuryBefore, 0.003 ether, 0.01e18);
    }

    // ---------------------------------------------------------------- the split

    function test_a_split_that_is_not_the_whole_thing_is_refused() public {
        _expectBadSplit(_split(5000, 0, 0, 4000)); // short
        _expectBadSplit(_split(5000, 5000, 0, 1)); // long
        _expectBadSplit(_split(0, 0, 0, 0)); // nowhere at all
    }

    function _expectBadSplit(FeeSplit memory split) internal {
        LaunchParams memory p = _params(split);
        vm.prank(creator);
        vm.expectRevert(HoodFactory.BadSplit.selector);
        factory.launch{value: LAUNCH_FEE}(p);
    }

    /// @dev Every leg is floored, so the four can only add up to less than what was booked. The
    ///      remainder is handed to the last leg with a share, and this is the proof that nothing
    ///      is ever left behind in the router, for any split and any amount.
    function testFuzz_the_legs_always_add_up_to_what_was_booked(uint16 a, uint16 b, uint256 amount) public {
        uint16 stakersBps = uint16(bound(a, 0, 10_000));
        uint16 liquidityBps = uint16(bound(b, 0, 10_000 - stakersBps));
        uint16 creatorBps = uint16(10_000 - stakersBps - liquidityBps);
        amount = bound(amount, 1, 100 ether);

        (address token, HoodCurve curve) = _launch(_split(stakersBps, 0, liquidityBps, creatorBps));
        // Booked straight rather than traded for, so the amount is exactly the awkward number this
        // run picked. Booking is permissionless and the funds have to arrive with the call.
        vm.deal(address(this), amount);
        router.accrue{value: amount}(token, amount);

        uint256 stakingBefore = address(staking).balance;
        uint256 bonusBefore = curve.bonus();
        uint256 creatorBefore = creator.balance;
        router.flush(token);

        uint256 toStakers = address(staking).balance - stakingBefore;
        uint256 toLiquidity = curve.bonus() - bonusBefore;
        uint256 toCreator = creator.balance - creatorBefore;
        assertEq(toStakers + toLiquidity + toCreator, amount, "every wei booked left along a leg");
        // Every leg is floored and one of them also carries the remainder, which four floored legs
        // can leave as much as three wei of.
        assertApproxEqAbs(toStakers, (amount * stakersBps) / 10_000, 3, "stakers pro rata");
        assertApproxEqAbs(toLiquidity, (amount * liquidityBps) / 10_000, 3, "liquidity pro rata");
        assertApproxEqAbs(toCreator, (amount * creatorBps) / 10_000, 3, "creator pro rata");
        assertEq(router.accrued(token), 0);
        assertEq(address(router).balance, router.accounted(address(0)), "the router holds what it booked");
    }

    /// @dev Three legs at a third each and ten wei to share: three wei each and one left over.
    function test_the_last_leg_with_a_share_takes_the_remainder() public {
        (address token, HoodCurve curve) = _launch(_split(3333, 0, 3333, 3334));
        vm.deal(address(this), 10);
        router.accrue{value: 10}(token, 10);

        uint256 stakingBefore = address(staking).balance;
        uint256 creatorBefore = creator.balance;
        router.flush(token);

        assertEq(address(staking).balance - stakingBefore, 3);
        assertEq(curve.bonus(), 3);
        assertEq(creator.balance - creatorBefore, 4, "the creator is last and takes the odd wei");
    }

    /// @dev And when the creator has no share the remainder walks back up the legs.
    function test_the_remainder_skips_a_leg_with_no_share() public {
        (address token, HoodCurve curve) = _launch(_split(5000, 0, 5000, 0));
        vm.deal(address(this), 3);
        router.accrue{value: 3}(token, 3);

        uint256 stakingBefore = address(staking).balance;
        uint256 creatorBefore = creator.balance;
        router.flush(token);

        assertEq(address(staking).balance - stakingBefore, 1);
        assertEq(curve.bonus(), 2, "liquidity is the last leg with a share");
        assertEq(creator.balance, creatorBefore, "a leg at zero is paid nothing at all");
    }

    function test_a_whole_split_pays_all_four_roads_before_graduation() public {
        (address token, HoodCurve curve) = _launch(_split(2500, 2500, 2500, 2500));
        _buy(curve, alice, 2 ether);

        uint256 booked = router.accrued(token);
        uint256 supplyBefore = IERC20(token).totalSupply();
        uint256 stakingBefore = address(staking).balance;
        uint256 creatorBefore = creator.balance;
        router.flushBuyback(token, 1);

        assertEq(address(staking).balance - stakingBefore, booked / 4, "a quarter to the stakers");
        assertEq(curve.bonus(), booked / 4, "a quarter into the raise");
        assertEq(creator.balance - creatorBefore, booked - 3 * (booked / 4), "a quarter, and the dust, to the creator");
        assertLt(IERC20(token).totalSupply(), supplyBefore, "and a quarter bought back and burned");
        assertEq(address(router).balance, router.accounted(address(0)), "the router holds what it booked");
    }

    function test_a_whole_split_pays_all_four_roads_after_graduation() public {
        (address token, HoodCurve curve) = _launch(_split(2500, 2500, 2500, 2500));
        _graduate(curve);

        // fees the pool earned come back through the handler
        uint256 booked = router.accrued(token);
        graduator.seedFees(token, 1 ether, 0);
        vm.deal(address(graduator), 1 ether);
        graduator.collect(token);
        booked += 1 ether;

        uint256 supplyBefore = IERC20(token).totalSupply();
        uint256 stakingBefore = address(staking).balance;
        uint256 creatorBefore = creator.balance;
        uint256 compoundedBefore = graduator.compounded(token);
        router.flushBuyback(token, 1);

        assertEq(address(staking).balance - stakingBefore, booked / 4);
        assertEq(graduator.compounded(token) - compoundedBefore, booked / 4, "compounded into the locked position");
        assertEq(creator.balance - creatorBefore, booked - 3 * (booked / 4));
        assertLt(IERC20(token).totalSupply(), supplyBefore, "bought out of the pool and burned");
        assertEq(router.accrued(token), 0, "a graduated buyback hands no change back");
    }

    /// @dev The floor is asked for because of the buyback leg, and it is applied to that leg only:
    ///      the other three do in a `flushBuyback` exactly what they do in a plain flush.
    function test_only_a_split_that_buys_needs_a_floor() public {
        (address withBuyback, HoodCurve c1) = _launch(_split(5000, 5000, 0, 0));
        _buy(c1, alice, 1 ether);
        vm.expectRevert(HoodFeeRouter.NeedsSwapFloor.selector);
        router.flush(withBuyback);
        router.flushBuyback(withBuyback, 1);

        LaunchParams memory p = _params(_split(5000, 0, 2500, 2500));
        p.symbol = "NOBUY";
        p.image = "ipfs://nobuy";
        p.salt = bytes32(uint256(7));
        (address noBuyback, HoodCurve c2) = _launch(_split(5000, 0, 2500, 2500), p, LAUNCH_FEE);
        _buy(c2, alice, 1 ether);
        uint256 booked = router.accrued(noBuyback);
        router.flush(noBuyback); // no buyback leg, no floor to ask for
        assertEq(router.accrued(noBuyback), 0);
        assertEq(c2.bonus(), booked / 4);
    }

    /// @dev A direct launch has no curve, and every path out of the router reads one. Booking
    ///      money against one would be booking money that can never leave.
    function test_a_direct_launch_cannot_book_fees_in_the_router() public {
        address direct = makeAddr("directToken");
        vm.prank(owner);
        factory.setPortal(address(this));
        factory.registerDirectLaunch(direct, creator, address(0), makeAddr("hook"), makeAddr("splitter"), makeAddr("locker"), "DIRECT2", "");

        vm.deal(address(this), 1 ether);
        vm.expectRevert(HoodFeeRouter.NotACurveLaunch.selector);
        router.accrue{value: 1 ether}(direct, 1 ether);
    }

    function test_flush_needs_something_to_flush() public {
        (address token,) = _launch(_toCreator());
        vm.expectRevert(HoodFeeRouter.NothingToFlush.selector);
        router.flush(token);
    }

    function test_buyback_after_graduation_needs_a_slippage_floor() public {
        (address token, HoodCurve curve) = _launch(_toBuyback());
        _graduate(curve);

        // fees the pool earned come back through the handler
        uint256 bookedBefore = router.accrued(token);
        graduator.seedFees(token, 1 ether, 0);
        vm.deal(address(graduator), 1 ether);
        graduator.collect(token);
        assertEq(router.accrued(token) - bookedBefore, 1 ether);

        vm.expectRevert(HoodFeeRouter.NeedsSwapFloor.selector);
        router.flush(token);

        uint256 supplyBefore = IERC20(token).totalSupply();
        router.flushBuyback(token, 1);
        assertLt(IERC20(token).totalSupply(), supplyBefore);
        assertEq(router.accrued(token), 0);
    }

    function test_collected_pool_fees_burn_the_token_side() public {
        (address token, HoodCurve curve) = _launch(_toStakers());
        _graduate(curve);

        uint256 supplyBefore = IERC20(token).totalSupply();
        uint256 bookedBefore = router.accrued(token);
        graduator.seedFees(token, 0.5 ether, 1_000e18);
        vm.deal(address(graduator), 0.5 ether);
        graduator.collect(token);

        assertEq(supplyBefore - IERC20(token).totalSupply(), 1_000e18);
        assertEq(router.accrued(token) - bookedBefore, 0.5 ether);
    }

    function test_compounding_after_graduation_goes_into_the_position() public {
        (address token, HoodCurve curve) = _launch(_toLiquidity());
        _graduate(curve);

        uint256 bookedBefore = router.accrued(token);
        graduator.seedFees(token, 0.5 ether, 0);
        vm.deal(address(graduator), 0.5 ether);
        graduator.collect(token);
        router.flush(token);

        assertEq(graduator.compounded(token), 0.5 ether + bookedBefore);
    }

    /// @dev The dollar-paired curve runs the ERC-20 branch of the fee router: the router has to
    ///      approve the curve and the curve has to pull, for both the buyback and the donation.
    function test_the_legs_work_when_the_pair_is_a_dollar() public {
        CurveConfig memory c = _config();
        c.startCap = 5_000e6;
        c.graduationCap = 50_000e6;
        vm.prank(owner);
        uint256 usdConfig = factory.addConfig(c);

        usd.mint(alice, 1_000_000e6);
        FeeSplit[2] memory splits = [_toBuyback(), _toLiquidity()];
        for (uint256 i; i < 2; ++i) {
            LaunchParams memory p = _params(splits[i]);
            p.pairToken = address(usd);
            p.configId = usdConfig;
            p.symbol = i == 0 ? "USDBURN" : "USDDEEP";
            p.image = i == 0 ? "ipfs://a" : "ipfs://b";
            p.salt = bytes32(uint256(100 + i));
            (address token, HoodCurve curve) = _launch(splits[i], p, LAUNCH_FEE);

            vm.startPrank(alice);
            usd.approve(address(curve), type(uint256).max);
            curve.buy(5_000e6, 0, alice);
            vm.stopPrank();
            assertGt(router.accrued(token), 0, "dollars booked for the split");

            if (splits[i].buybackBps != 0) {
                uint256 supplyBefore = IERC20(token).totalSupply();
                router.flushBuyback(token, 1);
                assertLt(IERC20(token).totalSupply(), supplyBefore, "bought back with dollars and burned");
            } else {
                uint256 bonusBefore = curve.bonus();
                router.flush(token);
                assertGt(curve.bonus(), bonusBefore, "dollars donated into the raise");
            }
            // the buyback is itself a trade and pays the creator leg like any other; what the
            // router holds is exactly what it has booked, never more
            // (the router's dollar balance spans every dollar-paired token, so the invariant is on
            // the asset, not on this one token)
            assertEq(router.accounted(address(usd)), usd.balanceOf(address(router)), "every dollar in the router is booked");
        }
    }

    function test_a_sold_out_curve_must_be_finalized_before_the_next_buyback() public {
        (address token, HoodCurve curve) = _launch(_toBuyback());
        uint256 left = curve.remaining();
        (uint256 needed,) = curve.quoteBuyExactOut(left);
        vm.deal(bob, needed);
        vm.prank(bob);
        curve.buyExactOut{value: needed}(left, needed, bob);

        vm.expectRevert(HoodFeeRouter.NeedsFinalize.selector);
        router.flushBuyback(token, 1);

        curve.finalize();
        router.flushBuyback(token, 1);
    }
}
