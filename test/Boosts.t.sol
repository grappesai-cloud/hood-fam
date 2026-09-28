// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";

import {HoodBag} from "../src/bag/HoodBag.sol";
import {HoodBoosts} from "../src/bag/HoodBoosts.sol";
import {HoodPayday} from "../src/bag/HoodPayday.sol";
import {HoodBurnClock} from "../src/bag/HoodBurnClock.sol";
import {BagSource, BagOutlet} from "../src/bag/BagTypes.sol";
import {IHoodBoosts} from "../src/interfaces/IHoodBoosts.sol";
import {MockBagFactory, MockVault} from "./mocks/BagMocks.sol";

/// @notice Boost slots: the price, the hour, the slot rules, and the money landing in that hour's Payday.
contract BoostsTest is Test {
    MockBagFactory internal factory;
    HoodBag internal bag;
    HoodBoosts internal boosts;
    HoodPayday internal payday;

    address internal house = makeAddr("house");
    address internal tokenA = makeAddr("tokenA");
    address internal tokenB = makeAddr("tokenB");
    address internal stranger = makeAddr("stranger");
    address internal buyer = makeAddr("buyer");
    address internal alice = makeAddr("alice");

    function setUp() public {
        vm.warp(1_000_000);
        factory = new MockBagFactory(address(this));
        MockVault vault = new MockVault();
        payday = new HoodPayday(address(factory));
        HoodBurnClock burnClock = new HoodBurnClock(address(factory), makeAddr("poolManager"));
        bag = new HoodBag(house, address(vault), address(payday), address(burnClock));
        boosts = new HoodBoosts(address(factory), address(bag));
        factory.register(tokenA, makeAddr("curveA"), address(0), address(0));
        factory.register(tokenB, address(0), makeAddr("hookB"), address(0));
        vm.deal(buyer, 10 ether);
        vm.deal(alice, 10 ether);
    }

    function _buy(address who, address token, uint64 hour, uint8 slot) internal {
        uint256 price = boosts.slotPrice();
        vm.prank(who);
        boosts.buy{value: price}(token, hour, slot);
    }

    function test_defaults() public view {
        assertEq(boosts.SLOTS(), 4);
        assertEq(boosts.slotPrice(), 0.005 ether);
        assertEq(boosts.MAX_SLOT_PRICE(), 0.05 ether);
        assertEq(boosts.epoch(), uint64(block.timestamp / 1 hours));
        address[] memory empty = boosts.boosted(boosts.epoch());
        assertEq(empty.length, 4);
        for (uint256 i; i < 4; ++i) {
            assertEq(empty[i], address(0));
        }
    }

    function test_buy_pays_the_hours_payday_through_the_bag_and_fills_the_slot() public {
        uint64 e = boosts.epoch();
        uint256 price = boosts.slotPrice();
        vm.expectEmit(true, true, true, true, address(boosts));
        emit IHoodBoosts.BoostBought(tokenA, buyer, e, 2, price);
        _buy(buyer, tokenA, e, 2);

        (address t, address b) = boosts.slotOf(e, 2);
        assertEq(t, tokenA);
        assertEq(b, buyer);
        assertTrue(boosts.holdsSlot(e, tokenA));
        address[] memory board = boosts.boosted(e);
        assertEq(board[2], tokenA);
        assertEq(board[0], address(0));
        assertEq(house.balance, 0, "the house keeps nothing from a boost");
        assertEq(payday.funded(e, address(0)), price, "the traders of the boosted hour are paid for it");
        assertEq(bag.totalIn(address(0), BagSource.Boost), price);
        assertEq(bag.totalOut(address(0), BagOutlet.Payday), price);
        assertEq(address(boosts).balance, 0);
        assertEq(address(bag).balance, 0);
    }

    function test_buy_rules() public {
        uint64 e = boosts.epoch();
        uint256 price = boosts.slotPrice();

        vm.prank(buyer);
        vm.expectRevert(HoodBoosts.WrongPrice.selector);
        boosts.buy{value: price - 1}(tokenA, e, 0);
        vm.prank(buyer);
        vm.expectRevert(HoodBoosts.WrongPrice.selector);
        boosts.buy{value: price + 1}(tokenA, e, 0);

        vm.prank(buyer);
        vm.expectRevert(HoodBoosts.UnknownToken.selector);
        boosts.buy{value: price}(stranger, e, 0);

        vm.prank(buyer);
        vm.expectRevert(HoodBoosts.BadHour.selector);
        boosts.buy{value: price}(tokenA, e - 1, 0);
        vm.prank(buyer);
        vm.expectRevert(HoodBoosts.BadHour.selector);
        boosts.buy{value: price}(tokenA, e + 2, 0);

        vm.prank(buyer);
        vm.expectRevert(HoodBoosts.BadSlot.selector);
        boosts.buy{value: price}(tokenA, e, 4);

        _buy(buyer, tokenA, e, 0);

        vm.prank(alice);
        vm.expectRevert(HoodBoosts.SlotTaken.selector);
        boosts.buy{value: price}(tokenB, e, 0);

        vm.prank(alice);
        vm.expectRevert(HoodBoosts.AlreadyBoosted.selector);
        boosts.buy{value: price}(tokenA, e, 1);

        // another token in another slot, and the same token in the next hour
        _buy(alice, tokenB, e, 1);
        _buy(alice, tokenA, e + 1, 0);
        address[] memory board = boosts.boosted(e);
        assertEq(board[0], tokenA);
        assertEq(board[1], tokenB);
        (address t,) = boosts.slotOf(e + 1, 0);
        assertEq(t, tokenA);
        assertEq(payday.funded(e, address(0)), 2 * price, "two slots this hour");
        assertEq(payday.funded(e + 1, address(0)), price, "and one for the next hour, paid to the next hour");
        assertEq(house.balance, 0);
    }

    function test_all_four_slots_of_an_hour_can_fill() public {
        uint64 e = boosts.epoch();
        address[] memory tokens = new address[](4);
        for (uint8 i; i < 4; ++i) {
            tokens[i] = address(uint160(0xA000 + i));
            factory.register(tokens[i], makeAddr("curve"), address(0), address(0));
            _buy(buyer, tokens[i], e, i);
        }
        address[] memory board = boosts.boosted(e);
        for (uint8 i; i < 4; ++i) {
            assertEq(board[i], tokens[i]);
        }
        address fifth = address(uint160(0xA004));
        factory.register(fifth, makeAddr("curve"), address(0), address(0));
        uint256 price = boosts.slotPrice();
        vm.prank(buyer);
        vm.expectRevert(HoodBoosts.SlotTaken.selector);
        boosts.buy{value: price}(fifth, e, 3);
    }

    function test_the_hour_rolls_over() public {
        uint64 e = boosts.epoch();
        _buy(buyer, tokenA, e + 1, 0);
        vm.warp(block.timestamp + 2 hours);
        assertEq(boosts.epoch(), e + 2);
        uint256 price = boosts.slotPrice();
        vm.prank(buyer);
        vm.expectRevert(HoodBoosts.BadHour.selector);
        boosts.buy{value: price}(tokenB, e + 1, 1);
        _buy(buyer, tokenB, e + 2, 0);
        _buy(buyer, tokenB, e + 3, 0);
    }

    function test_slot_price_is_set_by_the_factory_owner_under_the_cap() public {
        vm.prank(alice);
        vm.expectRevert(HoodBoosts.NotOwner.selector);
        boosts.setSlotPrice(0.01 ether);
        vm.expectRevert(HoodBoosts.PriceTooHigh.selector);
        boosts.setSlotPrice(0.05 ether + 1);

        vm.expectEmit(true, true, true, true, address(boosts));
        emit IHoodBoosts.SlotPriceSet(0.05 ether);
        boosts.setSlotPrice(0.05 ether);
        assertEq(boosts.slotPrice(), 0.05 ether);

        uint64 e = boosts.epoch();
        vm.prank(buyer);
        vm.expectRevert(HoodBoosts.WrongPrice.selector);
        boosts.buy{value: 0.005 ether}(tokenA, e, 0);
        _buy(buyer, tokenA, e, 0);
        assertEq(payday.funded(e, address(0)), 0.05 ether);
    }
}
