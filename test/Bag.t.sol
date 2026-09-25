// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";

import {HoodBag} from "../src/bag/HoodBag.sol";
import {HoodPayday} from "../src/bag/HoodPayday.sol";
import {HoodBurnClock} from "../src/bag/HoodBurnClock.sol";
import {BagSource, BagOutlet, BagReasons, BagSplits} from "../src/bag/BagTypes.sol";
import {IHoodBag} from "../src/interfaces/IHoodBag.sol";
import {PairTransfer} from "../src/libraries/PairTransfer.sol";
import {
    BagUSD, MockVault, MockPot, MockBagFactory, ToggleReceiver, ReentrantHouse, MockSink
} from "./mocks/BagMocks.sol";

/// @notice The Bag's four rules, house first, held money, and the payment convention.
contract BagTest is Test {
    uint256 internal constant BPS = 10_000;

    MockBagFactory internal factory;
    MockVault internal vault;
    HoodPayday internal payday;
    HoodBurnClock internal burnClock;
    ToggleReceiver internal house;
    HoodBag internal bag;
    BagUSD internal usd;

    address internal token = makeAddr("token");
    address internal trader = makeAddr("trader");
    address internal coin = makeAddr("houseCoin");

    function setUp() public {
        factory = new MockBagFactory(address(this));
        vault = new MockVault();
        payday = new HoodPayday(address(factory));
        burnClock = new HoodBurnClock(address(factory), makeAddr("poolManager"));
        house = new ToggleReceiver();
        bag = new HoodBag(address(house), address(vault), address(payday), address(burnClock));
        usd = new BagUSD();
        vm.deal(trader, 1_000 ether);
        usd.mint(trader, 1_000_000e6);
        vm.prank(trader);
        usd.approve(address(bag), type(uint256).max);
    }

    // ---------------------------------------------------------------- helpers

    function _tradeLegs(uint256 amount)
        internal
        pure
        returns (uint256 toVault, uint256 toPayday, uint256 toBurn, uint256 toHouse)
    {
        toVault = (amount * BagSplits.TRADE_VAULT_BPS) / BPS;
        toPayday = (amount * BagSplits.TRADE_PAYDAY_BPS) / BPS;
        toBurn = (amount * BagSplits.TRADE_BURN_BPS) / BPS;
        toHouse = amount - toVault - toPayday - toBurn;
    }

    function _takeTrade(uint256 amount) internal {
        vm.prank(trader);
        bag.takeTradeFee{value: amount}(address(0), amount, token);
    }

    // ---------------------------------------------------------------- trades

    function test_trade_fee_native_splits_house_payday_burn_and_holds_the_vault_leg() public {
        uint256 amount = 7e15;
        (uint256 toVault, uint256 toPayday, uint256 toBurn, uint256 toHouse) = _tradeLegs(amount);
        uint64 e = payday.epoch();

        vm.expectEmit(true, true, true, true, address(bag));
        emit IHoodBag.BagIn(BagSource.Trade, address(0), amount, token);
        vm.expectEmit(true, true, true, true, address(bag));
        emit IHoodBag.BagOut(BagOutlet.House, address(0), toHouse, address(house));
        vm.expectEmit(true, true, true, true, address(bag));
        emit IHoodBag.Held(BagOutlet.Vault, address(0), toVault);
        _takeTrade(amount);

        assertEq(toVault + toPayday + toBurn + toHouse, amount, "the four legs add up exactly");
        assertEq(address(house).balance, toHouse, "house");
        assertEq(bag.heldForVault(address(0)), toVault, "vault leg held: no house coin yet");
        assertEq(payday.funded(e, address(0)), toPayday, "payday");
        assertEq(burnClock.balanceOf(address(0)), toBurn, "burn clock");
        assertEq(address(bag).balance, toVault, "only the held leg stays in the bag");
        // the rules in bps of the trade: 30 / 10 / 10 / 20 of the 70
        assertApproxEqRel(toVault, (amount * 30) / 70, 1e15);
        assertApproxEqRel(toPayday, (amount * 10) / 70, 1e15);
        assertApproxEqRel(toBurn, (amount * 10) / 70, 1e15);
        assertApproxEqRel(toHouse, (amount * 20) / 70, 1e15);

        assertEq(bag.totalIn(address(0), BagSource.Trade), amount);
        assertEq(bag.totalOut(address(0), BagOutlet.House), toHouse);
        assertEq(bag.totalOut(address(0), BagOutlet.Payday), toPayday);
        assertEq(bag.totalOut(address(0), BagOutlet.Burn), toBurn);
        assertEq(bag.totalOut(address(0), BagOutlet.Vault), 0, "held is not out");
    }

    function test_trade_fee_pays_the_vault_once_the_house_coin_exists() public {
        vault.setHouseToken(coin);
        uint256 amount = 1 ether;
        (uint256 toVault,,,) = _tradeLegs(amount);
        vm.expectEmit(true, true, true, true, address(bag));
        emit IHoodBag.BagOut(BagOutlet.Vault, address(0), toVault, address(vault));
        _takeTrade(amount);
        assertEq(vault.notified(address(0)), toVault);
        assertEq(address(vault).balance, toVault);
        assertEq(bag.heldForVault(address(0)), 0);
        assertEq(bag.totalOut(address(0), BagOutlet.Vault), toVault);
        assertEq(address(bag).balance, 0, "nothing stays behind");
    }

    function test_trade_fee_erc20_splits_the_same_way() public {
        uint256 amount = 70e6;
        (uint256 toVault, uint256 toPayday, uint256 toBurn, uint256 toHouse) = _tradeLegs(amount);
        uint64 e = payday.epoch();
        vm.prank(trader);
        bag.takeTradeFee(address(usd), amount, token);
        assertEq(usd.balanceOf(address(house)), toHouse);
        assertEq(bag.heldForVault(address(usd)), toVault);
        assertEq(payday.funded(e, address(usd)), toPayday);
        assertEq(burnClock.balanceOf(address(usd)), toBurn);
        assertEq(usd.balanceOf(address(bag)), toVault);
        assertEq(bag.totalIn(address(usd), BagSource.Trade), amount);
    }

    function test_trade_fee_erc20_pays_the_vault_through_push_then_notify() public {
        vault.setHouseToken(coin);
        uint256 amount = 70e6;
        (uint256 toVault,,,) = _tradeLegs(amount);
        vm.prank(trader);
        bag.takeTradeFee(address(usd), amount, token);
        assertEq(usd.balanceOf(address(vault)), toVault);
        assertEq(vault.notified(address(usd)), toVault);
        assertEq(usd.balanceOf(address(bag)), 0);
    }

    function testFuzz_trade_fee_legs_add_up(uint96 raw) public {
        uint256 amount = bound(uint256(raw), 1, 1e24);
        vm.deal(trader, amount);
        uint64 e = payday.epoch();
        _takeTrade(amount);
        assertEq(
            address(house).balance + bag.heldForVault(address(0)) + payday.funded(e, address(0))
                + burnClock.balanceOf(address(0)),
            amount
        );
    }

    // ---------------------------------------------------------------- payment convention

    function test_native_value_must_equal_amount() public {
        vm.prank(trader);
        vm.expectRevert(PairTransfer.WrongValue.selector);
        bag.takeTradeFee{value: 1}(address(0), 2, token);
    }

    function test_erc20_take_refuses_value() public {
        vm.prank(trader);
        vm.expectRevert(PairTransfer.WrongValue.selector);
        bag.takeTradeFee{value: 1}(address(usd), 1e6, token);
    }

    function test_zero_amount_is_a_no_op_and_zero_with_value_reverts() public {
        vm.prank(trader);
        bag.takeTradeFee(address(0), 0, token);
        vm.prank(trader);
        bag.takeHouseFee(address(usd), 0, token);
        assertEq(bag.totalIn(address(0), BagSource.Trade), 0);
        assertEq(bag.totalIn(address(usd), BagSource.House), 0);
        vm.prank(trader);
        vm.expectRevert(HoodBag.WrongValue.selector);
        bag.takeTradeFee{value: 1}(address(0), 0, token);
    }

    function test_constructor_refuses_zero_addresses() public {
        vm.expectRevert(HoodBag.ZeroAddress.selector);
        new HoodBag(address(0), address(vault), address(payday), address(burnClock));
        vm.expectRevert(HoodBag.ZeroAddress.selector);
        new HoodBag(address(house), address(vault), address(0), address(burnClock));
    }

    function test_self_calls_are_only_for_the_bag() public {
        vm.expectRevert(HoodBag.NotSelf.selector);
        bag.pushVault(address(0), 1);
        vm.expectRevert(HoodBag.NotSelf.selector);
        bag.pushBurn(address(0), 1);
    }

    // ---------------------------------------------------------------- house first, never blocking

    function test_rejecting_house_is_booked_and_paid_later_by_anyone() public {
        house.setAccept(false);
        uint256 amount = 1 ether;
        (,,, uint256 toHouse) = _tradeLegs(amount);

        vm.expectEmit(true, true, true, true, address(bag));
        emit HoodBag.HouseDeferred(address(0), toHouse);
        _takeTrade(amount);
        assertEq(address(house).balance, 0);
        assertEq(bag.houseClaimable(address(0)), toHouse);
        assertEq(bag.totalOut(address(0), BagOutlet.House), 0, "deferred is not out");

        vm.expectRevert(PairTransfer.NativeTransferFailed.selector);
        bag.claimHouse(address(0));

        house.setAccept(true);
        vm.expectEmit(true, true, true, true, address(bag));
        emit IHoodBag.BagOut(BagOutlet.House, address(0), toHouse, address(house));
        vm.prank(makeAddr("anyone"));
        bag.claimHouse(address(0));
        assertEq(address(house).balance, toHouse);
        assertEq(bag.houseClaimable(address(0)), 0);
        assertEq(bag.totalOut(address(0), BagOutlet.House), toHouse);

        vm.expectRevert(HoodBag.NothingToClaim.selector);
        bag.claimHouse(address(0));
    }

    function test_reentering_house_is_booked_not_served() public {
        ReentrantHouse rh = new ReentrantHouse();
        HoodBag b2 = new HoodBag(address(rh), address(vault), address(payday), address(burnClock));
        rh.setBag(address(b2));
        vm.prank(trader);
        b2.takeHouseFee{value: 1 ether}(address(0), 1 ether, token);
        assertFalse(rh.reentered());
        assertEq(b2.houseClaimable(address(0)), 1 ether);
        assertEq(address(rh).balance, 0);
    }

    // ---------------------------------------------------------------- held money

    function test_release_held_vault_money_after_the_house_coin_is_set() public {
        uint256 amount = 1 ether;
        (uint256 toVault,,,) = _tradeLegs(amount);
        _takeTrade(amount);
        assertEq(bag.heldForVault(address(0)), toVault);

        vm.expectRevert(HoodBag.NothingReleased.selector);
        bag.releaseHeld(address(0));

        vault.setHouseToken(coin);
        vm.expectEmit(true, true, true, true, address(bag));
        emit IHoodBag.BagOut(BagOutlet.Vault, address(0), toVault, address(vault));
        vm.prank(makeAddr("anyone"));
        bag.releaseHeld(address(0));
        assertEq(bag.heldForVault(address(0)), 0);
        assertEq(vault.notified(address(0)), toVault);
        assertEq(bag.totalOut(address(0), BagOutlet.Vault), toVault);
        assertEq(address(bag).balance, 0);

        vm.expectRevert(HoodBag.NothingReleased.selector);
        bag.releaseHeld(address(0));
    }

    function test_vault_that_refuses_the_notify_gets_its_share_held_then_released() public {
        vault.setHouseToken(coin);
        vault.setRejectNotify(true);
        uint256 amount = 1 ether;
        (uint256 toVault,,,) = _tradeLegs(amount);
        _takeTrade(amount);
        assertEq(bag.heldForVault(address(0)), toVault, "held, not lost");
        assertEq(vault.notified(address(0)), 0);

        vm.expectRevert(HoodBag.NothingReleased.selector);
        bag.releaseHeld(address(0));

        vault.setRejectNotify(false);
        bag.releaseHeld(address(0));
        assertEq(bag.heldForVault(address(0)), 0);
        assertEq(vault.notified(address(0)), toVault);
    }

    function test_erc20_vault_refusal_holds_the_transfer_too() public {
        vault.setHouseToken(coin);
        vault.setRejectNotify(true);
        uint256 amount = 70e6;
        (uint256 toVault,,,) = _tradeLegs(amount);
        vm.prank(trader);
        bag.takeTradeFee(address(usd), amount, token);
        assertEq(usd.balanceOf(address(vault)), 0, "the transfer rolled back with the notify");
        assertEq(bag.heldForVault(address(usd)), toVault);
        vault.setRejectNotify(false);
        bag.releaseHeld(address(usd));
        assertEq(usd.balanceOf(address(vault)), toVault);
        assertEq(vault.notified(address(usd)), toVault);
    }

    function test_burn_clock_that_refuses_funding_gets_its_share_held_then_released() public {
        MockSink sink = new MockSink();
        HoodBag b2 = new HoodBag(address(house), address(vault), address(payday), address(sink));
        sink.setRejecting(true);
        uint256 amount = 1 ether;
        (uint256 toVault,, uint256 toBurn,) = _tradeLegs(amount);

        vm.expectEmit(true, true, true, true, address(b2));
        emit IHoodBag.Held(BagOutlet.Burn, address(0), toBurn);
        vm.prank(trader);
        b2.takeTradeFee{value: amount}(address(0), amount, token);
        assertEq(b2.heldForBurn(address(0)), toBurn);
        assertEq(sink.balanceOf(address(0)), 0);

        sink.setRejecting(false);
        b2.releaseHeld(address(0));
        assertEq(b2.heldForBurn(address(0)), 0);
        assertEq(sink.balanceOf(address(0)), toBurn);
        assertEq(b2.totalOut(address(0), BagOutlet.Burn), toBurn);
        assertEq(b2.heldForVault(address(0)), toVault, "the vault leg is still waiting for the coin");
    }

    function test_erc20_burn_refusal_leaves_no_allowance_behind() public {
        MockSink sink = new MockSink();
        HoodBag b2 = new HoodBag(address(house), address(vault), address(payday), address(sink));
        sink.setRejecting(true);
        vm.prank(trader);
        usd.approve(address(b2), type(uint256).max);
        uint256 amount = 70e6;
        (,, uint256 toBurn,) = _tradeLegs(amount);
        vm.prank(trader);
        b2.takeTradeFee(address(usd), amount, token);
        assertEq(b2.heldForBurn(address(usd)), toBurn);
        assertEq(usd.allowance(address(b2), address(sink)), 0);
        sink.setRejecting(false);
        b2.releaseHeld(address(usd));
        assertEq(sink.balanceOf(address(usd)), toBurn);
    }

    // ---------------------------------------------------------------- graduation

    function test_graduation_fee_is_half_house_quarter_confetti_quarter_vault() public {
        MockPot pot = new MockPot(token, address(0));
        uint256 amount = 1 ether;
        vm.expectEmit(true, true, true, true, address(bag));
        emit IHoodBag.BagIn(BagSource.Graduation, address(0), amount, token);
        vm.expectEmit(true, true, true, true, address(bag));
        emit IHoodBag.BagOut(BagOutlet.Confetti, address(0), 0.25 ether, address(pot));
        vm.prank(trader);
        bag.takeGraduationFee{value: amount}(address(0), amount, token, address(pot));

        assertEq(address(house).balance, 0.5 ether);
        assertEq(pot.totalDeposited(), 0.25 ether);
        assertEq(pot.lastReason(), BagReasons.CONFETTI);
        assertEq(pot.lastPayer(), address(bag));
        assertEq(bag.heldForVault(address(0)), 0.25 ether);
        assertEq(bag.totalOut(address(0), BagOutlet.Confetti), 0.25 ether);
        assertEq(bag.totalIn(address(0), BagSource.Graduation), amount);
    }

    function test_graduation_fee_erc20_approves_the_pot_and_it_pulls() public {
        MockPot pot = new MockPot(token, address(usd));
        vault.setHouseToken(coin);
        uint256 amount = 100e6;
        vm.prank(trader);
        bag.takeGraduationFee(address(usd), amount, token, address(pot));
        assertEq(usd.balanceOf(address(house)), 50e6);
        assertEq(usd.balanceOf(address(pot)), 25e6);
        assertEq(pot.lastReason(), BagReasons.CONFETTI);
        assertEq(vault.notified(address(usd)), 25e6);
        assertEq(usd.balanceOf(address(bag)), 0);
    }

    function test_graduation_fee_without_a_pot_folds_confetti_into_the_vault_leg() public {
        uint256 amount = 1 ether;
        vm.prank(trader);
        bag.takeGraduationFee{value: amount}(address(0), amount, token, address(0));
        assertEq(address(house).balance, 0.5 ether);
        assertEq(bag.heldForVault(address(0)), 0.5 ether);
        assertEq(bag.totalOut(address(0), BagOutlet.Confetti), 0);
    }

    function test_graduation_fee_refuses_a_pot_in_another_asset() public {
        MockPot pot = new MockPot(token, address(usd));
        vm.prank(trader);
        vm.expectRevert(HoodBag.PotAssetMismatch.selector);
        bag.takeGraduationFee{value: 1 ether}(address(0), 1 ether, token, address(pot));
    }

    function test_graduation_legs_add_up_on_odd_amounts() public {
        MockPot pot = new MockPot(token, address(0));
        uint256 amount = 1_000_000_000_000_000_003;
        vm.prank(trader);
        bag.takeGraduationFee{value: amount}(address(0), amount, token, address(pot));
        assertEq(address(house).balance + pot.totalDeposited() + bag.heldForVault(address(0)), amount);
    }

    // ---------------------------------------------------------------- penalties, house, house coin

    function test_penalty_cut_is_half_house_quarter_payday_quarter_burn() public {
        uint256 amount = 1 ether;
        uint64 e = payday.epoch();
        vm.expectEmit(true, true, true, true, address(bag));
        emit IHoodBag.BagIn(BagSource.Penalty, address(0), amount, token);
        vm.prank(trader);
        bag.takePenaltyCut{value: amount}(address(0), amount, token);
        assertEq(address(house).balance, 0.5 ether);
        assertEq(payday.funded(e, address(0)), 0.25 ether);
        assertEq(burnClock.balanceOf(address(0)), 0.25 ether);
        assertEq(address(bag).balance, 0);
        assertEq(bag.totalIn(address(0), BagSource.Penalty), amount);
    }

    function test_house_fee_goes_entirely_to_the_house() public {
        uint256 amount = 0.002 ether;
        vm.expectEmit(true, true, true, true, address(bag));
        emit IHoodBag.BagIn(BagSource.House, address(0), amount, token);
        vm.prank(trader);
        bag.takeHouseFee{value: amount}(address(0), amount, token);
        assertEq(address(house).balance, amount);
        assertEq(bag.totalOut(address(0), BagOutlet.House), amount);
        assertEq(address(bag).balance, 0);
    }

    function test_house_coin_leg_is_half_vault_half_burn() public {
        uint256 amount = 1 ether;
        vm.expectEmit(true, true, true, true, address(bag));
        emit IHoodBag.BagIn(BagSource.HouseCoin, address(0), amount, address(0));
        vm.prank(trader);
        bag.takeHouseCoinLeg{value: amount}(address(0), amount);
        assertEq(bag.heldForVault(address(0)), 0.5 ether);
        assertEq(burnClock.balanceOf(address(0)), 0.5 ether);
        assertEq(address(house).balance, 0, "the house keeps nothing from its own coin");

        vault.setHouseToken(coin);
        vm.expectEmit(true, true, true, true, address(bag));
        emit IHoodBag.BagIn(BagSource.HouseCoin, address(0), amount, coin);
        vm.prank(trader);
        bag.takeHouseCoinLeg{value: amount}(address(0), amount);
        assertEq(vault.notified(address(0)), 0.5 ether);
        assertEq(burnClock.balanceOf(address(0)), 1 ether);
    }

    function test_totals_accumulate_across_sources_per_asset() public {
        vm.startPrank(trader);
        bag.takeTradeFee{value: 1 ether}(address(0), 1 ether, token);
        bag.takeTradeFee{value: 2 ether}(address(0), 2 ether, token);
        bag.takeHouseFee{value: 0.5 ether}(address(0), 0.5 ether, token);
        bag.takeHouseFee(address(usd), 5e6, token);
        vm.stopPrank();
        assertEq(bag.totalIn(address(0), BagSource.Trade), 3 ether);
        assertEq(bag.totalIn(address(0), BagSource.House), 0.5 ether);
        assertEq(bag.totalIn(address(usd), BagSource.House), 5e6);
        (,,, uint256 toHouse) = _tradeLegs(3 ether);
        assertEq(bag.totalOut(address(0), BagOutlet.House), toHouse + 0.5 ether);
        assertEq(bag.totalOut(address(usd), BagOutlet.House), 5e6);
    }
}
