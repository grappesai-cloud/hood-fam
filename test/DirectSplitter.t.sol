// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";

import {HoodRevenueSplitter} from "../src/direct/HoodRevenueSplitter.sol";
import {HoodLaunchToken} from "../src/direct/HoodLaunchToken.sol";
import {Allocations, Socials} from "../src/direct/DirectTypes.sol";
import {BagReasons} from "../src/bag/BagTypes.sol";
import {IHoodPot} from "../src/interfaces/IHoodPot.sol";
import {PairTransfer} from "../src/libraries/PairTransfer.sol";
import {RejectNative, MockUSD} from "./mocks/Mocks.sol";
import {MockBag, PortalStub} from "./mocks/DirectMocks.sol";

/// @notice The four roads the creator's share travels, the pot underneath, and the three rules on
///         top of it: the slash and the house coin's leg.
contract DirectSplitterTest is Test {
    HoodRevenueSplitter internal splitter;
    HoodLaunchToken internal token;

    address internal portal = address(this);
    address internal treasury = makeAddr("treasury");
    address internal buybackModule = makeAddr("buybackModule");
    address internal creator = makeAddr("creator");
    address internal locker = makeAddr("locker");
    address internal hook = makeAddr("hook");
    address internal pool = makeAddr("poolManager");
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");
    address internal carol = makeAddr("carol");

    uint256 internal constant SUPPLY = 1_000_000_000e18;

    function setUp() public {
        token = HoodLaunchToken(Clones.clone(address(new HoodLaunchToken())));
        token.initialize(
            "Hood Fam", "FAM", "", "", Socials("", "", "", "", ""), SUPPLY, creator
        );
        splitter = new HoodRevenueSplitter(portal, treasury, buybackModule, address(token), address(0));
        // 25% creator, 25% buyback, 40% dividends, 10% liquidity
        splitter.initialize(creator, locker, Allocations(2_500, 2_500, 4_000, 1_000));
        splitter.setHook(hook);
        splitter.exclude(pool);
        token.setLaunchAddresses(pool, address(splitter));
        token.transfer(pool, SUPPLY);
        vm.deal(hook, 100 ether);
    }

    function _tax(uint256 amount) internal {
        vm.deal(address(splitter), address(splitter).balance + amount);
        splitter.sweep();
    }

    function _buy(address who, uint256 amount) internal {
        vm.prank(pool);
        token.transfer(who, amount);
    }

    // ---------------------------------------------------------------- the split

    function test_the_creators_tax_is_all_the_creators_and_follows_their_split() public {
        _buy(alice, SUPPLY / 2); // somebody has to be eligible for dividends
        _tax(10 ether);

        assertEq(splitter.PROTOCOL_BPS(), 0);
        assertEq(splitter.protocolClaimable(), 0, "nothing is booked for the protocol");
        assertEq(treasury.balance, 0);
        assertEq(splitter.creatorClaimable(), 2.5 ether);
        assertEq(splitter.buybackPot(), 2.5 ether);
        assertEq(splitter.liquidityPot(), 1 ether);
        assertApproxEqAbs(splitter.pendingDividends(alice), 4 ether, 2);
        assertEq(splitter.totalDeposited(), 4 ether, "the dividends leg is an inflow to the pot");

        vm.expectRevert(HoodRevenueSplitter.Nothing.selector);
        splitter.claimProtocol();
    }

    function test_allocations_must_add_up() public {
        HoodRevenueSplitter s = new HoodRevenueSplitter(portal, treasury, buybackModule, address(token), address(0));
        vm.expectRevert(HoodRevenueSplitter.BadAllocations.selector);
        s.initialize(creator, locker, Allocations(2_500, 2_500, 4_000, 999));
    }

    function test_the_hook_is_named_once_and_holds_no_share() public {
        vm.expectRevert(HoodRevenueSplitter.AlreadyInitialized.selector);
        splitter.setHook(bob);
        assertTrue(splitter.excluded(hook));
        vm.prank(bob);
        vm.expectRevert(HoodRevenueSplitter.NotPortal.selector);
        splitter.setHook(bob);
    }

    function test_dividends_follow_the_holders_not_the_pool() public {
        _buy(alice, SUPPLY / 4);
        _buy(bob, SUPPLY / 4);
        _tax(10 ether);

        // the pool holds half the supply and is owed nothing
        assertEq(splitter.pendingDividends(pool), 0);
        assertApproxEqAbs(splitter.pendingDividends(alice), 2 ether, 2);
        assertApproxEqAbs(splitter.pendingDividends(bob), 2 ether, 2);
    }

    function test_a_holder_who_arrives_later_does_not_take_earlier_dividends() public {
        _buy(alice, SUPPLY / 4);
        _tax(10 ether);
        _buy(bob, SUPPLY / 4);

        assertApproxEqAbs(splitter.pendingDividends(alice), 4 ether, 2);
        assertEq(splitter.pendingDividends(bob), 0);

        _tax(10 ether);
        assertApproxEqAbs(splitter.pendingDividends(alice), 6 ether, 4);
        assertApproxEqAbs(splitter.pendingDividends(bob), 2 ether, 4);
    }

    function test_selling_stops_the_dividends_and_keeps_what_was_earned() public {
        _buy(alice, SUPPLY / 4);
        _tax(10 ether);

        vm.prank(alice);
        token.transfer(pool, SUPPLY / 4); // sells everything

        _tax(10 ether); // reverts to nobody eligible... bob is not in yet
        _buy(bob, SUPPLY / 4);

        uint256 before = alice.balance;
        splitter.claimDividends(alice);
        assertApproxEqAbs(alice.balance - before, 4 ether, 4, "what she earned while holding");
        assertApproxEqAbs(splitter.pendingDividends(bob), 4 ether, 4, "the orphaned round goes to the next holder");
    }

    function test_anybody_can_push_a_holders_dividends_to_them() public {
        _buy(alice, SUPPLY / 2);
        _tax(10 ether);

        uint256 before = alice.balance;
        vm.prank(bob);
        uint256 paid = splitter.claim(alice);
        assertApproxEqAbs(alice.balance - before, 4 ether, 2);
        assertEq(paid, alice.balance - before);
        assertEq(splitter.pending(alice), 0);
        assertEq(splitter.totalPaid(), paid);
    }

    function test_only_the_creator_takes_the_creator_share() public {
        _buy(alice, SUPPLY / 2);
        _tax(10 ether);

        vm.prank(bob);
        vm.expectRevert(HoodRevenueSplitter.NotCreator.selector);
        splitter.claimCreator(bob);

        vm.prank(creator);
        splitter.claimCreator(creator);
        assertEq(creator.balance, 2.5 ether);
    }

    function test_the_buyback_pot_only_leaves_towards_the_module() public {
        _buy(alice, SUPPLY / 2);
        _tax(10 ether);

        vm.prank(bob);
        vm.expectRevert(HoodRevenueSplitter.NotBuybackModule.selector);
        splitter.releaseBuyback();
        vm.prank(hook);
        vm.expectRevert(HoodRevenueSplitter.NotBuybackModule.selector);
        splitter.releaseBuyback();

        vm.prank(buybackModule);
        uint256 amount = splitter.releaseBuyback();
        assertEq(amount, 2.5 ether);
        assertEq(buybackModule.balance, 2.5 ether);
    }

    function test_the_liquidity_share_goes_to_the_locker_and_anybody_can_send_it() public {
        _buy(alice, SUPPLY / 2);
        _tax(10 ether);

        vm.prank(bob);
        splitter.pushLiquidity();
        assertEq(locker.balance, 1 ether);
        assertEq(splitter.liquidityPot(), 0);
    }

    function test_every_wei_is_accounted_for(uint96 amount) public {
        vm.assume(amount > 1e6);
        _buy(alice, SUPPLY / 2);
        _tax(amount);

        uint256 buckets = splitter.creatorClaimable() + splitter.buybackPot() + splitter.liquidityPot()
            + splitter.dividendsHeld() + splitter.protocolClaimable();
        assertEq(buckets, splitter.accounted());
        assertLe(splitter.accounted(), address(splitter).balance);
        assertEq(address(splitter).balance, amount);
    }

    // ---------------------------------------------------------------- the pot

    function test_a_deposit_for_holders_goes_to_them_whole_and_is_tagged() public {
        _buy(alice, SUPPLY / 4);
        _buy(bob, SUPPLY / 4);
        assertEq(splitter.asset(), address(0));
        assertEq(splitter.token(), address(token));

        vm.expectEmit(true, true, true, true, address(splitter));
        emit IHoodPot.HoldersPaid(BagReasons.DIVIDENDS, carol, 1 ether, SUPPLY / 2);
        vm.prank(hook);
        splitter.depositForHolders{value: 1 ether}(1 ether, BagReasons.DIVIDENDS, carol);

        assertEq(splitter.totalDeposited(), 1 ether);
        assertEq(splitter.accounted(), 1 ether);
        assertApproxEqAbs(splitter.pending(alice), 0.5 ether, 2);
        assertApproxEqAbs(splitter.pending(bob), 0.5 ether, 2);
        assertEq(splitter.creatorClaimable(), 0, "none of it is the creator's");

        // the value must match the amount, either way round
        vm.expectRevert(PairTransfer.WrongValue.selector);
        splitter.depositForHolders{value: 0.5 ether}(1 ether, BagReasons.DIVIDENDS, carol);
        vm.expectRevert(PairTransfer.WrongValue.selector);
        splitter.depositForHolders{value: 1 ether}(0.5 ether, BagReasons.DIVIDENDS, carol);
    }

    function test_a_deposit_lands_on_top_of_unswept_tax_without_touching_it() public {
        _buy(alice, SUPPLY / 2);
        vm.deal(address(splitter), 10 ether); // tax that nobody has swept yet
        splitter.depositForHolders{value: 1 ether}(1 ether, BagReasons.SLASH, carol);
        assertApproxEqAbs(splitter.pending(alice), 1 ether, 2, "the deposit is the holders' whole");
        splitter.sweep();
        assertEq(splitter.creatorClaimable(), 2.5 ether, "the tax still follows the creator's split");
        assertApproxEqAbs(splitter.pending(alice), 5 ether, 4);
    }

    function test_the_pot_pulls_an_erc20_quote() public {
        MockUSD usd = new MockUSD();
        HoodLaunchToken t2 = HoodLaunchToken(Clones.clone(address(new HoodLaunchToken())));
        t2.initialize("Two", "TWO", "", "", Socials("", "", "", "", ""), SUPPLY, creator);
        HoodRevenueSplitter s2 = new HoodRevenueSplitter(portal, treasury, buybackModule, address(t2), address(usd));
        s2.initialize(creator, locker, Allocations(2_500, 2_500, 4_000, 1_000));
        s2.exclude(pool);
        t2.setLaunchAddresses(pool, address(s2));
        t2.transfer(pool, SUPPLY);
        vm.prank(pool);
        t2.transfer(alice, SUPPLY / 2);

        usd.mint(address(this), 100e6);
        usd.approve(address(s2), 100e6);
        s2.depositForHolders(100e6, BagReasons.PAYDAY, bob);
        assertEq(usd.balanceOf(address(s2)), 100e6);
        assertApproxEqAbs(s2.pending(alice), 100e6, 2);
        assertEq(s2.claim(alice), s2.pending(alice) == 0 ? usd.balanceOf(alice) : 0);
        assertApproxEqAbs(usd.balanceOf(alice), 100e6, 2);

        // sending value with an ERC-20 quote is a mistake, not a tip
        vm.deal(address(this), 1 ether);
        vm.expectRevert(PairTransfer.WrongValue.selector);
        s2.depositForHolders{value: 1}(1, BagReasons.PAYDAY, bob);
    }

    function test_push_many_pays_over_the_floor_and_skips_a_receiver_that_rejects() public {
        address rejecter = address(new RejectNative());
        _buy(alice, SUPPLY / 2);
        _buy(bob, SUPPLY / 1_000);
        _buy(rejecter, SUPPLY / 4);
        _tax(10 ether);
        uint256 aliceOwed = splitter.pending(alice);
        uint256 bobOwed = splitter.pending(bob);
        uint256 rejecterOwed = splitter.pending(rejecter);
        assertGt(bobOwed, 0);
        assertGt(rejecterOwed, 0);

        address[] memory who = new address[](4);
        who[0] = alice;
        who[1] = bob;
        who[2] = rejecter;
        who[3] = carol; // holds nothing
        uint256 floor = bobOwed + 1;

        vm.expectEmit(true, true, true, true, address(splitter));
        emit IHoodPot.Pushed(alice, aliceOwed);
        (uint256 paid, uint256 count) = splitter.pushMany(who, floor);

        assertEq(count, 1, "alice is over the floor and can take it; bob is under, the rejecter cannot");
        assertEq(paid, aliceOwed);
        assertEq(alice.balance, aliceOwed);
        assertEq(splitter.pending(alice), 0);
        assertEq(splitter.pending(bob), bobOwed, "under the floor: still owed");
        assertEq(splitter.pending(rejecter), rejecterOwed, "rejected: still owed, never lost");
        assertEq(splitter.totalPaid(), aliceOwed);
        assertEq(splitter.accounted(), address(splitter).balance - 0, "the books moved by exactly what left");

        // a zero floor pays bob and still skips the rejecter
        (paid, count) = splitter.pushMany(who, 0);
        assertEq(count, 1);
        assertEq(paid, bobOwed);
        assertEq(bob.balance, bobOwed);
        assertEq(splitter.pending(rejecter), rejecterOwed);
        // the fallback for the rejecter fails the same way, loudly, and keeps it owed
        vm.expectRevert(PairTransfer.NativeTransferFailed.selector);
        splitter.claimDividends(rejecter);
        assertEq(splitter.pending(rejecter), rejecterOwed);
    }

    // ---------------------------------------------------------------- the slash

    function test_the_creators_sell_moves_their_unclaimed_fees_to_the_holders() public {
        _buy(alice, SUPPLY / 4);
        _buy(creator, SUPPLY / 4);
        _tax(10 ether);
        assertEq(splitter.creatorClaimable(), 2.5 ether);
        uint256 aliceBefore = splitter.pending(alice);

        vm.prank(bob);
        vm.expectRevert(HoodRevenueSplitter.NotToken.selector);
        splitter.slashCreator();

        // the token calls it when the creator's tokens go to the pool
        vm.expectEmit(true, true, true, true, address(splitter));
        emit HoodRevenueSplitter.CreatorSlashed(creator, 2.5 ether);
        vm.expectEmit(true, true, true, true, address(splitter));
        emit IHoodPot.HoldersPaid(BagReasons.SLASH, creator, 2.5 ether, SUPPLY / 2);
        vm.prank(creator);
        token.transfer(pool, 1e18);

        assertEq(splitter.creatorClaimable(), 0);
        assertApproxEqAbs(splitter.pending(alice) - aliceBefore, 1.25 ether, 2, "half to alice, half to the creator's own bag");
        assertEq(splitter.totalDeposited(), 6.5 ether);

        // nothing left: the next sell is a no-op, not a revert
        vm.prank(creator);
        token.transfer(pool, 1e18);
        assertEq(splitter.creatorClaimable(), 0);
    }

    function test_a_plain_transfer_by_the_creator_does_not_slash() public {
        _buy(alice, SUPPLY / 4);
        _buy(creator, SUPPLY / 4);
        _tax(10 ether);
        vm.prank(creator);
        token.transfer(bob, 1e18);
        assertEq(splitter.creatorClaimable(), 2.5 ether, "only a sell into the pool counts");
    }

    // ---------------------------------------------------------------- the house coin

    function test_when_the_bag_is_the_creator_its_leg_goes_into_the_bag_and_anyone_may_send_it() public {
        PortalStub stub = new PortalStub();
        MockBag bag = new MockBag();
        stub.setBag(address(bag));
        HoodLaunchToken t2 = HoodLaunchToken(Clones.clone(address(new HoodLaunchToken())));
        t2.initialize("House", "HOUSE", "", "", Socials("", "", "", "", ""), SUPPLY, creator);
        vm.startPrank(address(stub));
        HoodRevenueSplitter s2 = new HoodRevenueSplitter(address(stub), treasury, buybackModule, address(t2), address(0));
        s2.initialize(address(bag), locker, Allocations(2_500, 2_500, 4_000, 1_000));
        s2.exclude(pool);
        vm.stopPrank();
        t2.setLaunchAddresses(pool, address(s2));
        t2.transfer(pool, SUPPLY);
        vm.prank(pool);
        t2.transfer(alice, SUPPLY / 2);

        vm.deal(address(s2), 10 ether);
        vm.prank(carol);
        assertEq(s2.claimCreator(carol), 2.5 ether, "a stranger may send it, and it does not go to them");
        assertEq(carol.balance, 0);
        assertEq(bag.total(bag.HOUSE_COIN(), address(0)), 2.5 ether, "it went in as the house coin's leg");
        assertEq(address(bag).balance, 2.5 ether);
    }
}
