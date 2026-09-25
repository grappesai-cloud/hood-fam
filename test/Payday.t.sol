// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";

import {HoodPayday} from "../src/bag/HoodPayday.sol";
import {BagReasons, BagSplits} from "../src/bag/BagTypes.sol";
import {IHoodPayday} from "../src/interfaces/IHoodPayday.sol";
import {PairTransfer} from "../src/libraries/PairTransfer.sol";
import {BagUSD, MockBagFactory, MockPot, ToggleReceiver} from "./mocks/BagMocks.sol";

/// @notice The hourly distributor: funding, the keeper's caps, the carry, and wallets that refuse.
contract PaydayTest is Test {
    MockBagFactory internal factory;
    HoodPayday internal payday;
    BagUSD internal usd;
    MockPot internal pot;
    MockPot internal potUsd;

    address internal keeper = makeAddr("keeper");
    address internal funder = makeAddr("bag");
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");
    address internal token = makeAddr("token");

    function setUp() public {
        vm.warp(1_000_000);
        factory = new MockBagFactory(address(this));
        payday = new HoodPayday(address(factory));
        payday.setKeeper(keeper);
        usd = new BagUSD();
        pot = new MockPot(token, address(0));
        potUsd = new MockPot(token, address(usd));
        vm.deal(funder, 10_000 ether);
        usd.mint(funder, 1_000_000e6);
        vm.prank(funder);
        usd.approve(address(payday), type(uint256).max);
    }

    // ---------------------------------------------------------------- helpers

    function _fund(uint256 amount) internal {
        vm.prank(funder);
        payday.fund{value: amount}(address(0), amount);
    }

    function _one(address who, uint256 amount) internal pure returns (address[] memory w, uint256[] memory a) {
        w = new address[](1);
        a = new uint256[](1);
        w[0] = who;
        a[0] = amount;
    }

    function _none() internal pure returns (address[] memory w, uint256[] memory a) {
        w = new address[](0);
        a = new uint256[](0);
    }

    function _closeTheHour() internal returns (uint64 closed) {
        closed = payday.epoch();
        vm.warp(block.timestamp + 1 hours);
    }

    // ---------------------------------------------------------------- funding

    function test_fund_credits_the_current_epoch() public {
        uint64 e = payday.epoch();
        assertEq(e, uint64(block.timestamp / 1 hours));
        vm.expectEmit(true, true, true, true, address(payday));
        emit IHoodPayday.Funded(e, address(0), 1 ether);
        _fund(1 ether);
        _fund(0.5 ether);
        assertEq(payday.funded(e, address(0)), 1.5 ether);
        vm.prank(funder);
        payday.fund(address(usd), 10e6);
        assertEq(payday.funded(e, address(usd)), 10e6);
        assertEq(usd.balanceOf(address(payday)), 10e6);
        vm.warp(block.timestamp + 1 hours);
        _fund(1 ether);
        assertEq(payday.funded(e + 1, address(0)), 1 ether);
        assertEq(payday.funded(e, address(0)), 1.5 ether);
    }

    function test_fund_zero_is_a_no_op_and_value_mismatch_reverts() public {
        vm.prank(funder);
        payday.fund(address(0), 0);
        assertEq(payday.funded(payday.epoch(), address(0)), 0);
        vm.prank(funder);
        vm.expectRevert(HoodPayday.WrongValue.selector);
        payday.fund{value: 1}(address(0), 0);
        vm.prank(funder);
        vm.expectRevert(PairTransfer.WrongValue.selector);
        payday.fund{value: 1}(address(0), 2);
        vm.prank(funder);
        vm.expectRevert(PairTransfer.WrongValue.selector);
        payday.fund{value: 1}(address(usd), 1e6);
    }

    // ---------------------------------------------------------------- roles

    function test_keeper_is_set_by_the_factory_owner_only() public {
        vm.prank(alice);
        vm.expectRevert(HoodPayday.NotOwner.selector);
        payday.setKeeper(alice);
        vm.expectEmit(true, true, true, true, address(payday));
        emit IHoodPayday.KeeperSet(bob);
        payday.setKeeper(bob);
        assertEq(payday.keeper(), bob);
    }

    function test_pay_is_for_the_keeper_or_the_owner() public {
        _fund(1 ether);
        uint64 e = _closeTheHour();
        (address[] memory w, uint256[] memory a) = _none();
        vm.prank(alice);
        vm.expectRevert(HoodPayday.NotKeeper.selector);
        payday.pay(e, address(0), w, a, w, a);
        // the owner may
        payday.pay(e, address(0), w, a, w, a);
        assertEq(payday.carried(address(0)), 1 ether);
    }

    // ---------------------------------------------------------------- the caps

    function test_an_open_epoch_cannot_be_paid() public {
        _fund(1 ether);
        (address[] memory w, uint256[] memory a) = _none();
        uint64 open = payday.epoch();
        vm.prank(keeper);
        vm.expectRevert(HoodPayday.EpochOpen.selector);
        payday.pay(open, address(0), w, a, w, a);
        vm.prank(keeper);
        vm.expectRevert(HoodPayday.EpochOpen.selector);
        payday.pay(open + 5, address(0), w, a, w, a);
    }

    function test_an_epoch_is_paid_once_per_asset() public {
        _fund(1 ether);
        uint64 e = _closeTheHour();
        (address[] memory w, uint256[] memory a) = _none();
        vm.prank(keeper);
        payday.pay(e, address(0), w, a, w, a);
        assertGt(payday.paidAt(e, address(0)), 0);
        vm.prank(keeper);
        vm.expectRevert(HoodPayday.AlreadyPaid.selector);
        payday.pay(e, address(0), w, a, w, a);
        // another asset in the same epoch is its own payout
        vm.prank(keeper);
        payday.pay(e, address(usd), w, a, w, a);
    }

    function test_cannot_pay_more_than_funded_plus_carry() public {
        _fund(1 ether);
        uint64 e = _closeTheHour();
        (address[] memory w, uint256[] memory a) = _one(alice, 1 ether + 1);
        (address[] memory pw, uint256[] memory pa) = _none();
        vm.prank(keeper);
        vm.expectRevert(HoodPayday.Overspent.selector);
        payday.pay(e, address(0), w, a, pw, pa);
        // wallets plus pots together are what counts
        (w, a) = _one(alice, 0.95 ether);
        (pw, pa) = _one(address(pot), 0.1 ether);
        vm.prank(keeper);
        vm.expectRevert(HoodPayday.Overspent.selector);
        payday.pay(e, address(0), w, a, pw, pa);
    }

    function test_launch_slice_is_capped_at_a_tenth() public {
        _fund(1 ether);
        uint64 e = _closeTheHour();
        uint256 cap = (1 ether * uint256(BagSplits.PAYDAY_LAUNCH_SLICE_BPS)) / 10_000;
        assertEq(cap, 0.1 ether);
        (address[] memory w, uint256[] memory a) = _none();
        (address[] memory pw, uint256[] memory pa) = _one(address(pot), cap + 1);
        vm.prank(keeper);
        vm.expectRevert(HoodPayday.LaunchSliceTooBig.selector);
        payday.pay(e, address(0), w, a, pw, pa);

        (pw, pa) = _one(address(pot), cap);
        vm.expectEmit(true, true, true, true, address(payday));
        emit IHoodPayday.LaunchSlice(e, address(0), address(pot), cap);
        vm.prank(keeper);
        payday.pay(e, address(0), w, a, pw, pa);
        assertEq(pot.totalDeposited(), cap);
        assertEq(pot.lastReason(), BagReasons.PAYDAY);
        assertEq(pot.lastPayer(), address(payday));
        assertEq(payday.carried(address(0)), 0.9 ether);
    }

    function test_limits_on_wallets_pots_and_lengths() public {
        _fund(1 ether);
        uint64 e = _closeTheHour();
        (address[] memory none, uint256[] memory noneA) = _none();

        address[] memory w = new address[](501);
        uint256[] memory a = new uint256[](501);
        vm.prank(keeper);
        vm.expectRevert(HoodPayday.TooManyWallets.selector);
        payday.pay(e, address(0), w, a, none, noneA);

        address[] memory pw = new address[](11);
        uint256[] memory pa = new uint256[](11);
        vm.prank(keeper);
        vm.expectRevert(HoodPayday.TooManyPots.selector);
        payday.pay(e, address(0), none, noneA, pw, pa);

        uint256[] memory short = new uint256[](500);
        vm.prank(keeper);
        vm.expectRevert(HoodPayday.LengthMismatch.selector);
        payday.pay(e, address(0), w, short, none, noneA);

        // five hundred wallets and ten pots are fine
        w = new address[](500);
        a = new uint256[](500);
        for (uint256 i; i < 500; ++i) {
            w[i] = address(uint160(0x1000 + i));
            a[i] = 1e12;
        }
        pw = new address[](10);
        pa = new uint256[](10);
        for (uint256 i; i < 10; ++i) {
            pw[i] = address(pot);
            pa[i] = 0.01 ether;
        }
        vm.prank(keeper);
        payday.pay(e, address(0), w, a, pw, pa);
        assertEq(pot.totalDeposited(), 0.1 ether);
        assertEq(address(uint160(0x1000)).balance, 1e12);
    }

    function test_a_pot_in_another_asset_is_refused() public {
        _fund(1 ether);
        uint64 e = _closeTheHour();
        (address[] memory w, uint256[] memory a) = _none();
        (address[] memory pw, uint256[] memory pa) = _one(address(potUsd), 0.01 ether);
        vm.prank(keeper);
        vm.expectRevert(HoodPayday.PotAssetMismatch.selector);
        payday.pay(e, address(0), w, a, pw, pa);
    }

    // ---------------------------------------------------------------- paying and carrying

    function test_pays_wallets_and_pots_and_carries_the_rest() public {
        _fund(1 ether);
        uint64 e = _closeTheHour();
        address[] memory w = new address[](2);
        uint256[] memory a = new uint256[](2);
        w[0] = alice;
        a[0] = 0.5 ether;
        w[1] = bob;
        a[1] = 0.1 ether;
        (address[] memory pw, uint256[] memory pa) = _one(address(pot), 0.1 ether);

        vm.expectEmit(true, true, true, true, address(payday));
        emit IHoodPayday.Paid(e, address(0), alice, 0.5 ether);
        vm.expectEmit(true, true, true, true, address(payday));
        emit IHoodPayday.Paid(e, address(0), bob, 0.1 ether);
        vm.expectEmit(true, true, true, true, address(payday));
        emit IHoodPayday.EpochPaid(e, address(0), 0.6 ether, 0.1 ether, 0.3 ether);
        vm.prank(keeper);
        payday.pay(e, address(0), w, a, pw, pa);

        assertEq(alice.balance, 0.5 ether);
        assertEq(bob.balance, 0.1 ether);
        assertEq(pot.totalDeposited(), 0.1 ether);
        assertEq(payday.paid(e, address(0)), 0.7 ether);
        assertEq(payday.carried(address(0)), 0.3 ether);
        assertEq(address(payday).balance, 0.3 ether);

        // the carry is available to the next closed epoch, and the slice cap counts it
        _fund(1 ether);
        uint64 e2 = _closeTheHour();
        (w, a) = _one(alice, 1.17 ether);
        (pw, pa) = _one(address(pot), 0.13 ether);
        vm.prank(keeper);
        payday.pay(e2, address(0), w, a, pw, pa);
        assertEq(alice.balance, 1.67 ether);
        assertEq(payday.carried(address(0)), 0);
        assertEq(address(payday).balance, 0);
    }

    function test_a_skipped_epoch_carries_when_it_is_finally_paid() public {
        _fund(1 ether);
        uint64 e = _closeTheHour();
        _fund(2 ether);
        uint64 e2 = _closeTheHour();
        (address[] memory w, uint256[] memory a) = _none();
        vm.prank(keeper);
        payday.pay(e2, address(0), w, a, w, a);
        assertEq(payday.carried(address(0)), 2 ether, "only the paid epoch's money moves into the carry");
        vm.prank(keeper);
        payday.pay(e, address(0), w, a, w, a);
        assertEq(payday.carried(address(0)), 3 ether);
    }

    function test_a_wallet_that_refuses_is_owed_and_never_blocks_the_batch() public {
        ToggleReceiver rejecting = new ToggleReceiver();
        rejecting.setAccept(false);
        _fund(1 ether);
        uint64 e = _closeTheHour();
        address[] memory w = new address[](2);
        uint256[] memory a = new uint256[](2);
        w[0] = address(rejecting);
        a[0] = 0.4 ether;
        w[1] = alice;
        a[1] = 0.6 ether;
        (address[] memory pw, uint256[] memory pa) = _none();

        vm.expectEmit(true, true, true, true, address(payday));
        emit HoodPayday.Owed(address(rejecting), address(0), 0.4 ether);
        vm.prank(keeper);
        payday.pay(e, address(0), w, a, pw, pa);
        assertEq(alice.balance, 0.6 ether);
        assertEq(address(rejecting).balance, 0);
        assertEq(payday.owed(address(rejecting), address(0)), 0.4 ether);
        assertEq(payday.carried(address(0)), 0, "owed money is spent, not carried");

        vm.expectRevert(PairTransfer.NativeTransferFailed.selector);
        payday.claimOwed(address(rejecting), address(0));

        rejecting.setAccept(true);
        vm.expectEmit(true, true, true, true, address(payday));
        emit HoodPayday.OwedClaimed(address(rejecting), address(0), 0.4 ether);
        vm.prank(makeAddr("anyone"));
        payday.claimOwed(address(rejecting), address(0));
        assertEq(address(rejecting).balance, 0.4 ether);
        assertEq(payday.owed(address(rejecting), address(0)), 0);
        vm.expectRevert(HoodPayday.Nothing.selector);
        payday.claimOwed(address(rejecting), address(0));
    }

    function test_erc20_payout_to_wallets_and_pots() public {
        vm.prank(funder);
        payday.fund(address(usd), 100e6);
        uint64 e = _closeTheHour();
        (address[] memory w, uint256[] memory a) = _one(alice, 80e6);
        (address[] memory pw, uint256[] memory pa) = _one(address(potUsd), 10e6);
        vm.prank(keeper);
        payday.pay(e, address(usd), w, a, pw, pa);
        assertEq(usd.balanceOf(alice), 80e6);
        assertEq(usd.balanceOf(address(potUsd)), 10e6);
        assertEq(potUsd.lastReason(), BagReasons.PAYDAY);
        assertEq(payday.carried(address(usd)), 10e6);
        assertEq(usd.balanceOf(address(payday)), 10e6);
    }

    function test_zero_amounts_in_a_batch_are_skipped_quietly() public {
        _fund(1 ether);
        uint64 e = _closeTheHour();
        (address[] memory w, uint256[] memory a) = _one(alice, 0);
        (address[] memory pw, uint256[] memory pa) = _one(address(pot), 0);
        vm.prank(keeper);
        payday.pay(e, address(0), w, a, pw, pa);
        assertEq(alice.balance, 0);
        assertEq(pot.totalDeposited(), 0);
        assertEq(payday.carried(address(0)), 1 ether);
    }
}
