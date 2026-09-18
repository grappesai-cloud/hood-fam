// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {BaseTest} from "./Base.t.sol";
import {HoodCurve} from "../src/HoodCurve.sol";
import {HoodFeeRouter} from "../src/HoodFeeRouter.sol";
import {CurveConfig, FeeModel, LaunchParams} from "../src/HoodTypes.sol";

/// @notice The five things a creator can do with the creator leg of the trading fee.
contract FeeModelsTest is BaseTest {
    function test_staking_rewards_go_to_the_people_who_locked() public {
        (address token, HoodCurve curve) = _launch(FeeModel.StakingRewards);

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
        (address token, HoodCurve curve) = _launch(FeeModel.BuybackBurn);
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
        (address token, HoodCurve curve) = _launch(FeeModel.LiquidityCompound);
        _buy(curve, alice, 2 ether);

        uint256 booked = router.accrued(token);
        router.flush(token);
        assertEq(curve.bonus(), booked);

        _graduate(curve);
        (, uint256 pairReserve,) = graduator.pools(token);
        assertGt(pairReserve, (curve.raiseTarget() * 9000) / 10_000);
    }

    function test_creator_keep_pays_the_recipient_and_only_the_recipient() public {
        (address token, HoodCurve curve) = _launch(FeeModel.CreatorKeep);
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

    function test_zero_fee_means_traders_only_pay_the_protocol_leg() public {
        (address token, HoodCurve curve) = _launch(FeeModel.ZeroFee);
        assertEq(curve.creatorFeeBps(), 0);
        assertEq(curve.protocolFeeBps(), 30);

        uint256 treasuryBefore = treasury.balance;
        _buy(curve, alice, 1 ether);
        assertEq(router.accrued(token), 0, "nothing is ever booked for a zero-fee token");
        // the protocol's leg is booked on the curve and pulled out by anybody
        assertApproxEqRel(curve.protocolClaimable(), 0.003 ether, 0.01e18);
        curve.claimProtocol();
        assertApproxEqRel(treasury.balance - treasuryBefore, 0.003 ether, 0.01e18);
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
        (address token,) = _launch(FeeModel.CreatorKeep);
        vm.expectRevert(HoodFeeRouter.NothingToFlush.selector);
        router.flush(token);
    }

    function test_buyback_after_graduation_needs_a_slippage_floor() public {
        (address token, HoodCurve curve) = _launch(FeeModel.BuybackBurn);
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
        (address token, HoodCurve curve) = _launch(FeeModel.StakingRewards);
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
        (address token, HoodCurve curve) = _launch(FeeModel.LiquidityCompound);
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
    function test_the_fee_models_work_when_the_pair_is_a_dollar() public {
        CurveConfig memory c = _config();
        c.startCap = 5_000e6;
        c.graduationCap = 50_000e6;
        vm.prank(owner);
        uint256 usdConfig = factory.addConfig(c);

        usd.mint(alice, 1_000_000e6);
        address[2] memory tokens;
        FeeModel[2] memory models = [FeeModel.BuybackBurn, FeeModel.LiquidityCompound];
        for (uint256 i; i < 2; ++i) {
            LaunchParams memory p = _params(models[i]);
            p.pairToken = address(usd);
            p.configId = usdConfig;
            p.symbol = i == 0 ? "USDBURN" : "USDDEEP";
            p.image = i == 0 ? "ipfs://a" : "ipfs://b";
            p.salt = bytes32(uint256(100 + i));
            (address token, HoodCurve curve) = _launch(models[i], p, LAUNCH_FEE);
            tokens[i] = token;

            vm.startPrank(alice);
            usd.approve(address(curve), type(uint256).max);
            curve.buy(5_000e6, 0, alice);
            vm.stopPrank();
            assertGt(router.accrued(token), 0, "dollars booked for the model");

            if (models[i] == FeeModel.BuybackBurn) {
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
        (address token, HoodCurve curve) = _launch(FeeModel.BuybackBurn);
        uint256 left = curve.remaining();
        (uint256 needed,) = curve.quoteBuyExactOut(left);
        vm.deal(bob, needed);
        vm.prank(bob);
        curve.buyExactOut{value: needed}(left, needed, bob);

        vm.expectRevert(HoodFeeRouter.NeedsFinalize.selector);
        router.flush(token);

        curve.finalize();
        router.flushBuyback(token, 1);
    }
}
