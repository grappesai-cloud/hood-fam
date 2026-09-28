// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";

import {HoodOpeningAuction} from "../src/direct/HoodOpeningAuction.sol";
import {HoodRevenueSplitter} from "../src/direct/HoodRevenueSplitter.sol";
import {HoodLaunchToken} from "../src/direct/HoodLaunchToken.sol";
import {Allocations, DirectLaunch, Socials} from "../src/direct/DirectTypes.sol";
import {BagReasons} from "../src/bag/BagTypes.sol";
import {IHoodPot} from "../src/interfaces/IHoodPot.sol";
import {PairTransfer} from "../src/libraries/PairTransfer.sol";
import {MockUSD} from "./mocks/Mocks.sol";
import {LockerStub} from "./mocks/DirectMocks.sol";

/// @dev A bidder that cannot take its money back, to prove the refund is booked and not lost.
contract RejectingBidder {
    function bidOn(HoodOpeningAuction auction, address token) external payable {
        auction.bid{value: msg.value}(token, msg.value);
    }

    receive() external payable {
        revert("no");
    }
}

/// @notice The sniper auction: bids, refunds, the settle split and the slot it buys.
contract DirectAuctionTest is Test {
    HoodOpeningAuction internal auction;
    HoodLaunchToken internal token;
    HoodRevenueSplitter internal splitter;
    LockerStub internal locker;
    MockUSD internal usd;
    HoodLaunchToken internal usdToken;
    HoodRevenueSplitter internal usdSplitter;
    LockerStub internal usdLocker;

    address internal creator = makeAddr("creator");
    address internal pool = makeAddr("poolManager");
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");
    address internal carol = makeAddr("carol");
    address internal holder = makeAddr("holder");

    uint256 internal constant SUPPLY = 1_000_000_000e18;
    uint256 internal constant MIN_BID = 0.01 ether;
    uint64 internal endBlock;
    uint64 internal usdEndBlock;

    mapping(address => DirectLaunch) internal rows;

    /// @dev The auction reads the launch row off its portal, which is this contract.
    function getLaunch(address t) external view returns (DirectLaunch memory) {
        return rows[t];
    }

    function _launch(address quote) internal returns (HoodLaunchToken t, HoodRevenueSplitter s, LockerStub l) {
        t = HoodLaunchToken(Clones.clone(address(new HoodLaunchToken())));
        t.initialize("T", "T", "", "", Socials("", "", "", "", ""), SUPPLY, creator, 0, 10_000, 10_000);
        s = new HoodRevenueSplitter(address(this), makeAddr("treasury"), makeAddr("buyback"), address(t), quote);
        s.initialize(creator, makeAddr("realLocker"), Allocations(2_500, 2_500, 4_000, 1_000));
        s.exclude(pool);
        l = new LockerStub();
        t.setLaunchAddresses(pool, address(s), address(l), makeAddr("hook"), makeAddr("buybackModule"), address(0));
        t.transfer(pool, SUPPLY);
        vm.prank(pool);
        t.transfer(holder, SUPPLY / 2); // somebody has to be eligible
        rows[address(t)] = DirectLaunch(address(t), quote, address(0), address(s), address(l), creator, 0, 0, 0, true);
    }

    function setUp() public {
        vm.roll(100);
        auction = new HoodOpeningAuction(address(this));
        (token, splitter, locker) = _launch(address(0));
        endBlock = uint64(block.number) + 10;
        auction.register(address(token), endBlock, MIN_BID);

        usd = new MockUSD();
        (usdToken, usdSplitter, usdLocker) = _launch(address(usd));
        usdEndBlock = uint64(block.number) + 10;
        auction.register(address(usdToken), usdEndBlock, 0);

        vm.deal(alice, 10 ether);
        vm.deal(bob, 10 ether);
        vm.deal(carol, 10 ether);
    }

    // ---------------------------------------------------------------- registering

    function test_only_the_portal_registers_and_only_once() public {
        vm.prank(alice);
        vm.expectRevert(HoodOpeningAuction.NotPortal.selector);
        auction.register(makeAddr("other"), endBlock, 0);
        vm.expectRevert(HoodOpeningAuction.AlreadyRegistered.selector);
        auction.register(address(token), endBlock + 5, 0);
        HoodOpeningAuction.Auction memory a = auction.auctionOf(address(token));
        assertEq(a.quote, address(0));
        assertEq(a.splitter, address(splitter));
        assertEq(a.locker, address(locker));
        assertEq(a.endBlock, endBlock);
        assertEq(a.minBid, MIN_BID);
        assertEq(auction.minimumBid(address(token)), MIN_BID);
    }

    // ---------------------------------------------------------------- bidding

    function test_bids_must_clear_the_floor_and_beat_the_last_by_five_percent() public {
        vm.prank(alice);
        vm.expectRevert(HoodOpeningAuction.NotRegistered.selector);
        auction.bid{value: MIN_BID}(makeAddr("nobody"), MIN_BID);

        vm.prank(alice);
        vm.expectRevert(HoodOpeningAuction.BidTooLow.selector);
        auction.bid{value: MIN_BID - 1}(address(token), MIN_BID - 1);

        vm.expectEmit(true, true, true, true, address(auction));
        emit HoodOpeningAuction.Bid(address(token), alice, MIN_BID, endBlock);
        vm.prank(alice);
        auction.bid{value: MIN_BID}(address(token), MIN_BID);
        assertEq(auction.minimumBid(address(token)), MIN_BID + MIN_BID / 20);

        vm.prank(bob);
        vm.expectRevert(HoodOpeningAuction.BidTooLow.selector);
        auction.bid{value: 0.0104 ether}(address(token), 0.0104 ether);

        // the value has to match the amount
        vm.prank(bob);
        vm.expectRevert(PairTransfer.WrongValue.selector);
        auction.bid{value: 0.02 ether}(address(token), 0.0105 ether);

        vm.prank(bob);
        auction.bid{value: 0.0105 ether}(address(token), 0.0105 ether);
        assertEq(alice.balance, 10 ether, "outbid: refunded on the spot");
        assertEq(address(auction).balance, 0.0105 ether);
        HoodOpeningAuction.Auction memory a = auction.auctionOf(address(token));
        assertEq(a.bidder, bob);
        assertEq(a.amount, 0.0105 ether);

        vm.roll(endBlock + 1);
        vm.prank(carol);
        vm.expectRevert(HoodOpeningAuction.WindowClosed.selector);
        auction.bid{value: 1 ether}(address(token), 1 ether);
    }

    function test_a_refund_that_cannot_be_delivered_is_booked_not_lost() public {
        RejectingBidder rejecter = new RejectingBidder();
        vm.deal(address(rejecter), 1 ether);
        rejecter.bidOn{value: MIN_BID}(auction, address(token));

        vm.expectEmit(true, true, true, true, address(auction));
        emit HoodOpeningAuction.RefundBooked(address(0), address(rejecter), MIN_BID);
        vm.prank(bob);
        auction.bid{value: 0.02 ether}(address(token), 0.02 ether);
        assertEq(auction.refunds(address(0), address(rejecter)), MIN_BID);
        assertEq(address(auction).balance, 0.02 ether + MIN_BID, "still here for whenever it can be taken");

        vm.prank(alice);
        vm.expectRevert(HoodOpeningAuction.Nothing.selector);
        auction.claimRefund(address(0));
    }

    // ---------------------------------------------------------------- settling

    function test_settle_splits_the_bid_half_to_the_holders_and_half_to_locked_liquidity() public {
        vm.prank(alice);
        auction.bid{value: 1 ether}(address(token), 1 ether);

        vm.expectRevert(HoodOpeningAuction.WindowOpen.selector);
        auction.settle(address(token));

        vm.roll(endBlock + 1);
        vm.expectEmit(true, true, true, true, address(splitter));
        emit IHoodPot.HoldersPaid(BagReasons.AUCTION, alice, 0.5 ether, SUPPLY / 2);
        vm.expectEmit(true, true, true, true, address(auction));
        emit HoodOpeningAuction.Settled(address(token), alice, 1 ether, 0.5 ether, 0.5 ether);
        vm.prank(carol);
        auction.settle(address(token));

        assertEq(auction.firstSlot(address(token)), alice);
        assertEq(splitter.totalDeposited(), 0.5 ether);
        assertApproxEqAbs(splitter.pending(holder), 0.5 ether, 2, "the holders' half");
        assertEq(address(locker).balance, 0.5 ether, "the liquidity half sits in the locker for deepen()");
        assertEq(address(auction).balance, 0);

        vm.expectRevert(HoodOpeningAuction.AlreadySettled.selector);
        auction.settle(address(token));
    }

    function test_no_bids_means_nothing_to_split_and_the_pool_opens() public {
        assertFalse(auction.mayReceive(address(token), alice), "shut while the window is open");
        vm.roll(endBlock + 1);
        assertTrue(auction.mayReceive(address(token), alice), "nobody bid: open");
        vm.expectEmit(true, true, true, true, address(auction));
        emit HoodOpeningAuction.Settled(address(token), address(0), 0, 0, 0);
        auction.settle(address(token));
        assertEq(auction.firstSlot(address(token)), address(0));
    }

    function test_the_slot_belongs_to_the_winner_for_twenty_blocks_whether_settled_or_not() public {
        vm.prank(alice);
        auction.bid{value: 1 ether}(address(token), 1 ether);
        assertFalse(auction.mayReceive(address(token), alice), "not before the window closes");
        assertTrue(auction.mayReceive(makeAddr("unregistered"), bob), "a launch with no auction is always open");

        vm.roll(endBlock + 1);
        assertTrue(auction.mayReceive(address(token), alice));
        assertFalse(auction.mayReceive(address(token), bob));
        vm.roll(endBlock + auction.SLOT_BLOCKS());
        assertTrue(auction.mayReceive(address(token), alice));
        assertFalse(auction.mayReceive(address(token), bob));
        vm.roll(endBlock + auction.SLOT_BLOCKS() + 1);
        assertTrue(auction.mayReceive(address(token), bob), "the slot ended: everyone");
    }

    // ---------------------------------------------------------------- an ERC-20 quote

    function test_bids_in_an_erc20_quote_are_pulled_refunded_and_split_the_same_way() public {
        usd.mint(alice, 100e6);
        usd.mint(bob, 100e6);
        vm.prank(alice);
        usd.approve(address(auction), 100e6);
        vm.prank(bob);
        usd.approve(address(auction), 100e6);

        vm.prank(alice);
        vm.expectRevert(PairTransfer.WrongValue.selector);
        auction.bid{value: 1}(address(usdToken), 10e6);

        vm.prank(alice);
        auction.bid(address(usdToken), 10e6);
        assertEq(usd.balanceOf(address(auction)), 10e6);
        vm.prank(bob);
        auction.bid(address(usdToken), 20e6);
        assertEq(usd.balanceOf(alice), 100e6, "refunded in dollars");
        assertEq(usd.balanceOf(address(auction)), 20e6);

        vm.roll(usdEndBlock + 1);
        auction.settle(address(usdToken));
        assertEq(auction.firstSlot(address(usdToken)), bob);
        assertEq(usd.balanceOf(address(usdSplitter)), 10e6, "pulled by the pot");
        assertEq(usdSplitter.totalDeposited(), 10e6);
        assertEq(usd.balanceOf(address(usdLocker)), 10e6);
        assertEq(usd.balanceOf(address(auction)), 0);
    }
}
