// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {BaseTest} from "./Base.t.sol";
import {HoodCurve} from "../src/HoodCurve.sol";
import {HoodFactory} from "../src/HoodFactory.sol";
import {CurveConfig, FeeModel, Launch, LaunchParams} from "../src/HoodTypes.sol";

contract FactoryTest is BaseTest {
    /// @dev This one is here because it already bit: the factory inlined the token and the curve
    ///      bytecode and came out 2,461 bytes over what an account may hold, so it could not be
    ///      deployed at all. The bytecode lives in HoodDeployer now.
    function test_every_contract_fits_in_an_account() public view {
        assertLt(address(factory).code.length, 24_576, "factory");
        assertLt(address(staking).code.length, 24_576, "staking");
        assertLt(address(router).code.length, 24_576, "fee router");
        assertLt(address(factory.deployer()).code.length, 24_576, "deployer");
    }

    function test_launch_fee_goes_to_the_treasury() public {
        uint256 before = treasury.balance;
        _launch(FeeModel.CreatorKeep);
        assertEq(treasury.balance - before, LAUNCH_FEE);
    }

    /// @dev The refund after a creator's first buy is what the curve handed back, not whatever the
    ///      factory happens to hold: it has a `receive`, so strays accumulate, and sweeping the
    ///      balance would pay them out to whoever launches next.
    function test_a_first_buy_refunds_its_own_change_and_not_the_factorys_balance() public {
        vm.deal(address(this), 5 ether);
        (bool ok,) = address(factory).call{value: 5 ether}("");
        assertTrue(ok, "a stray donation lands in the factory");

        LaunchParams memory p = _params(FeeModel.CreatorKeep);
        uint256 before = creator.balance;
        vm.prank(creator);
        factory.launch{value: LAUNCH_FEE + 1 ether}(p);

        // the creator paid the fee and one ether of first buy, and got back only the curve's change
        assertGe(before - creator.balance, LAUNCH_FEE, "the launch fee was paid");
        assertLe(before - creator.balance, LAUNCH_FEE + 1 ether, "and never more than what was sent");
        assertEq(address(factory).balance, 5 ether, "the stray is still sitting there, untouched");
    }

    function test_launch_needs_the_fee() public {
        LaunchParams memory p = _params(FeeModel.CreatorKeep);
        vm.prank(creator);
        vm.expectRevert(HoodFactory.BadFee.selector);
        factory.launch{value: LAUNCH_FEE - 1}(p);
    }

    function test_the_creator_can_take_the_first_buy_in_the_same_transaction() public {
        LaunchParams memory p = _params(FeeModel.CreatorKeep);
        uint256 before = creator.balance;

        vm.prank(creator);
        (address token,, uint256 bought) = factory.launch{value: LAUNCH_FEE + 1 ether}(p);

        assertGt(bought, 0);
        assertEq(IERC20(token).balanceOf(creator), bought);
        assertEq(before - creator.balance, LAUNCH_FEE + 1 ether);
        assertEq(address(factory).balance, 0);
    }

    function test_an_oversized_first_buy_comes_back_to_the_creator() public {
        LaunchParams memory p = _params(FeeModel.CreatorKeep);
        uint256 before = creator.balance;

        vm.prank(creator);
        (, address curve,) = factory.launch{value: LAUNCH_FEE + 100 ether}(p);

        assertEq(uint8(HoodCurve(payable(curve)).phase()), 1); // sold out in one go
        // about 4.4 ETH of raise plus fee left the creator's pocket, not 100
        assertGt(creator.balance, before - 6 ether);
        assertEq(address(factory).balance, 0);
    }

    function test_economics_are_pinned_by_the_creator() public {
        LaunchParams memory p = _params(FeeModel.CreatorKeep);
        p.econ = factory.previewLaunchEconomics(configId, address(0));

        // the launchpad moves its fee between the quote and the signature
        vm.prank(owner);
        factory.setLaunchFee(1 ether);

        vm.prank(creator);
        vm.expectRevert(HoodFactory.BadEconomics.selector);
        factory.launch{value: 1 ether}(p);
    }

    function test_a_disabled_preset_cannot_be_used_but_live_tokens_keep_trading() public {
        (, HoodCurve curve) = _launch(FeeModel.CreatorKeep);
        vm.prank(owner);
        factory.setConfigEnabled(configId, false);

        LaunchParams memory p = _params(FeeModel.CreatorKeep);
        p.salt = bytes32(uint256(99));
        vm.prank(bob);
        vm.expectRevert(HoodFactory.ConfigDisabled.selector);
        factory.launch{value: LAUNCH_FEE}(p);

        // the token that already launched is untouched
        assertGt(_buy(curve, alice, 1 ether), 0);
    }

    function test_a_preset_must_leave_the_liquidity_in_the_pool() public {
        CurveConfig memory c = _config();
        c.liquidityBps = 5000; // half the raise walking out at graduation
        vm.prank(owner);
        vm.expectRevert(HoodFactory.BadConfig.selector);
        factory.addConfig(c);
    }

    function test_a_preset_cannot_charge_more_than_five_percent() public {
        CurveConfig memory c = _config();
        c.creatorFeeBps = 600;
        vm.prank(owner);
        vm.expectRevert(HoodFactory.BadFee.selector);
        factory.addConfig(c);
    }

    function test_only_an_allowed_pair_can_be_launched_against() public {
        LaunchParams memory p = _params(FeeModel.CreatorKeep);
        p.pairToken = address(0xdead);
        vm.prank(creator);
        vm.expectRevert(HoodFactory.PairNotAllowed.selector);
        factory.launch{value: LAUNCH_FEE}(p);
    }

    function test_a_working_ticker_locks_out_the_copycats() public {
        vm.prank(owner);
        factory.setPair(address(0), true, 1 ether);

        (address token, HoodCurve curve) = _launch(FeeModel.CreatorKeep);
        assertTrue(factory.isSymbolAvailable("FAM"));

        _buy(curve, alice, 2 ether); // crosses the 24h volume threshold

        assertFalse(factory.isSymbolAvailable("FAM"));
        assertFalse(factory.isSymbolAvailable("fam"), "case does not get you around it");
        assertEq(factory.symbolLockOwner(factory.symbolHash("FAM")), token);

        LaunchParams memory p = _params(FeeModel.CreatorKeep);
        p.salt = bytes32(uint256(2));
        vm.prank(bob);
        vm.expectRevert(HoodFactory.TickerLockedError.selector);
        factory.launch{value: LAUNCH_FEE}(p);

        // same artwork, different ticker, still blocked
        p.symbol = "FAM2";
        vm.prank(bob);
        vm.expectRevert(HoodFactory.ImageLockedError.selector);
        factory.launch{value: LAUNCH_FEE}(p);

        // and the lock lets go once the volume is history
        vm.warp(block.timestamp + 48 hours + 1);
        assertTrue(factory.isSymbolAvailable("FAM"));
        vm.prank(bob);
        factory.launch{value: LAUNCH_FEE}(p);
    }

    function test_a_quiet_token_never_locks_its_ticker() public {
        vm.prank(owner);
        factory.setPair(address(0), true, 1 ether);
        (, HoodCurve curve) = _launch(FeeModel.CreatorKeep);
        _buy(curve, alice, 0.1 ether);
        assertTrue(factory.isSymbolAvailable("FAM"));
    }

    function test_only_the_current_recipient_moves_the_fee_stream() public {
        (address token,) = _launch(FeeModel.CreatorKeep);
        vm.prank(bob);
        vm.expectRevert(HoodFactory.NotRecipient.selector);
        factory.transferCreatorFeeRecipient(token, bob);

        vm.prank(creator);
        factory.transferCreatorFeeRecipient(token, bob);
        assertEq(factory.creatorFeeRecipient(token), bob);

        vm.prank(creator);
        vm.expectRevert(HoodFactory.NotRecipient.selector);
        factory.transferCreatorFeeRecipient(token, creator);
    }

    function test_volume_is_only_recorded_by_the_curve_that_owns_the_token() public {
        (address token,) = _launch(FeeModel.CreatorKeep);
        vm.expectRevert(HoodFactory.NotACurve.selector);
        factory.recordVolume(token, 1 ether);
    }

    function test_modules_are_wired_once_and_the_handler_only_changes_for_new_launches() public {
        (, HoodCurve curve) = _launch(FeeModel.CreatorKeep);
        address pinned = curve.graduationHandler();

        vm.prank(owner);
        vm.expectRevert(HoodFactory.ModulesAlreadySet.selector);
        factory.setModules(address(router), address(staking), address(graduator));

        vm.prank(owner);
        factory.setGraduationHandler(address(0xBEEF));
        assertEq(curve.graduationHandler(), pinned, "a live curve keeps the handler it was born with");
    }

    function test_a_launch_against_an_erc20_pair_trades_and_graduates() public {
        CurveConfig memory c = _config();
        c.startCap = 5_000e6; // dollars, six decimals
        c.graduationCap = 50_000e6;
        vm.prank(owner);
        uint256 usdConfig = factory.addConfig(c);

        LaunchParams memory p = _params(FeeModel.CreatorKeep);
        p.pairToken = address(usd);
        p.configId = usdConfig;
        p.symbol = "USDFAM";
        p.image = "ipfs://other";

        vm.prank(creator);
        (address token, address curveAddr,) = factory.launch{value: LAUNCH_FEE}(p);
        HoodCurve curve = HoodCurve(payable(curveAddr));

        usd.mint(alice, 100_000e6);
        vm.startPrank(alice);
        usd.approve(address(curve), type(uint256).max);
        uint256 out = curve.buy(10_000e6, 0, alice);
        vm.stopPrank();

        assertGt(out, 0);
        assertEq(IERC20(token).balanceOf(alice), out);
        assertEq(usd.balanceOf(address(curve)), curve.reserve() + curve.protocolClaimable());
        assertGt(curve.protocolClaimable(), 0);
        curve.claimProtocol();
        assertGt(usd.balanceOf(treasury), 0);
        assertGt(router.accrued(token), 0);

        // sell back
        vm.startPrank(alice);
        IERC20(token).approve(address(curve), out);
        uint256 back = curve.sell(out, 0, alice);
        vm.stopPrank();
        assertGt(back, 0);
        assertLt(back, 10_000e6);

        // and the creator's fee stream pays out in dollars
        uint256 creatorBefore = usd.balanceOf(creator);
        router.flush(token);
        assertGt(usd.balanceOf(creator) - creatorBefore, 0);
    }
}
