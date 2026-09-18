// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";

import {HoodRevenueSplitter} from "../src/direct/HoodRevenueSplitter.sol";
import {HoodLaunchToken} from "../src/direct/HoodLaunchToken.sol";
import {Allocations, Socials} from "../src/direct/DirectTypes.sol";
import {RejectNative} from "./mocks/Mocks.sol";

/// @notice The four roads the creator's share travels, and the dividend accumulator underneath.
contract DirectSplitterTest is Test {
    HoodRevenueSplitter internal splitter;
    HoodLaunchToken internal token;

    address internal portal = address(this);
    address internal treasury = makeAddr("treasury");
    address internal buybackModule = makeAddr("buybackModule");
    address internal creator = makeAddr("creator");
    address internal locker = makeAddr("locker");
    address internal pool = makeAddr("poolManager");
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");

    uint256 internal constant SUPPLY = 1_000_000_000e18;

    function setUp() public {
        token = HoodLaunchToken(Clones.clone(address(new HoodLaunchToken())));
        token.initialize(
            "Hood Fam", "FAM", "", "", Socials("", "", "", "", ""), SUPPLY, creator, 0, 10_000, 10_000
        );
        splitter = new HoodRevenueSplitter(portal, treasury, buybackModule, address(token), address(0));
        // 25% creator, 25% buyback, 40% dividends, 10% liquidity
        splitter.initialize(creator, locker, Allocations(2_500, 2_500, 4_000, 1_000));
        splitter.exclude(pool);
        token.setLaunchAddresses(pool, address(splitter), locker, makeAddr("hook"), makeAddr("buybackModule"));
        token.transfer(pool, SUPPLY);
    }

    function _tax(uint256 amount) internal {
        vm.deal(address(splitter), address(splitter).balance + amount);
        splitter.sweep();
    }

    function _buy(address who, uint256 amount) internal {
        vm.prank(pool);
        token.transfer(who, amount);
    }

    function test_the_protocol_takes_a_tenth_and_the_rest_follows_the_creators_split() public {
        _buy(alice, SUPPLY / 2); // somebody has to be eligible for dividends
        _tax(10 ether);

        assertEq(splitter.protocolClaimable(), 1 ether, "a tenth to the protocol, waiting to be pulled");
        assertEq(treasury.balance, 0, "nothing is pushed from inside a sweep");
        splitter.claimProtocol();
        assertEq(treasury.balance, 1 ether, "pulled by anyone, paid to the treasury");
        assertEq(splitter.creatorClaimable(), 2.25 ether);
        assertEq(splitter.buybackPot(), 2.25 ether);
        assertEq(splitter.liquidityPot(), 0.9 ether);
        assertApproxEqAbs(splitter.pendingDividends(alice), 3.6 ether, 2);
    }

    function test_allocations_must_add_up() public {
        HoodRevenueSplitter s = new HoodRevenueSplitter(portal, treasury, buybackModule, address(token), address(0));
        vm.expectRevert(HoodRevenueSplitter.BadAllocations.selector);
        s.initialize(creator, locker, Allocations(2_500, 2_500, 4_000, 999));
    }

    function test_dividends_follow_the_holders_not_the_pool() public {
        _buy(alice, SUPPLY / 4);
        _buy(bob, SUPPLY / 4);
        _tax(10 ether);

        // the pool holds half the supply and is owed nothing
        assertEq(splitter.pendingDividends(pool), 0);
        assertApproxEqAbs(splitter.pendingDividends(alice), 1.8 ether, 2);
        assertApproxEqAbs(splitter.pendingDividends(bob), 1.8 ether, 2);
    }

    function test_a_holder_who_arrives_later_does_not_take_earlier_dividends() public {
        _buy(alice, SUPPLY / 4);
        _tax(10 ether);
        _buy(bob, SUPPLY / 4);

        assertApproxEqAbs(splitter.pendingDividends(alice), 3.6 ether, 2);
        assertEq(splitter.pendingDividends(bob), 0);

        _tax(10 ether);
        assertApproxEqAbs(splitter.pendingDividends(alice), 5.4 ether, 4);
        assertApproxEqAbs(splitter.pendingDividends(bob), 1.8 ether, 4);
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
        assertApproxEqAbs(alice.balance - before, 3.6 ether, 4, "what she earned while holding");
        assertApproxEqAbs(splitter.pendingDividends(bob), 3.6 ether, 4, "the orphaned round goes to the next holder");
    }

    function test_anybody_can_push_a_holders_dividends_to_them() public {
        _buy(alice, SUPPLY / 2);
        _tax(10 ether);

        uint256 before = alice.balance;
        vm.prank(bob);
        splitter.claimDividends(alice);
        assertApproxEqAbs(alice.balance - before, 3.6 ether, 2);
        assertEq(splitter.pendingDividends(alice), 0);
    }

    function test_only_the_creator_takes_the_creator_share() public {
        _buy(alice, SUPPLY / 2);
        _tax(10 ether);

        vm.prank(bob);
        vm.expectRevert(HoodRevenueSplitter.NotCreator.selector);
        splitter.claim(bob);

        vm.prank(creator);
        splitter.claim(creator);
        assertEq(creator.balance, 2.25 ether);
    }

    function test_the_buyback_pot_only_leaves_towards_the_module() public {
        _buy(alice, SUPPLY / 2);
        _tax(10 ether);

        vm.prank(bob);
        vm.expectRevert(HoodRevenueSplitter.NotBuybackModule.selector);
        splitter.releaseBuyback();

        vm.prank(buybackModule);
        uint256 amount = splitter.releaseBuyback();
        assertEq(amount, 2.25 ether);
        assertEq(buybackModule.balance, 2.25 ether);
    }

    function test_the_liquidity_share_goes_to_the_locker_and_anybody_can_send_it() public {
        _buy(alice, SUPPLY / 2);
        _tax(10 ether);

        vm.prank(bob);
        splitter.pushLiquidity();
        assertEq(locker.balance, 0.9 ether);
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
        assertEq(address(splitter).balance + treasury.balance, amount);
    }

    /// @dev The Argus and Pons reviews both landed on the same trap: a protocol tenth PUSHED from
    ///      inside sweep() lets one bad treasury freeze every payout of every launch. It is pulled.
    function test_a_treasury_that_rejects_eth_freezes_nobody_elses_money() public {
        address badTreasury = address(new RejectNative());
        HoodLaunchToken t2 = HoodLaunchToken(Clones.clone(address(new HoodLaunchToken())));
        t2.initialize("Two", "TWO", "", "", Socials("", "", "", "", ""), SUPPLY, creator, 0, 10_000, 10_000);
        HoodRevenueSplitter s2 = new HoodRevenueSplitter(portal, badTreasury, buybackModule, address(t2), address(0));
        s2.initialize(creator, locker, Allocations(2_500, 2_500, 4_000, 1_000));
        s2.exclude(pool);
        t2.setLaunchAddresses(pool, address(s2), locker, makeAddr("hook2"), buybackModule);
        t2.transfer(pool, SUPPLY);
        vm.prank(pool);
        t2.transfer(alice, SUPPLY / 2);

        vm.deal(address(s2), 10 ether);
        s2.sweep(); // never touches the treasury

        // every other road still moves
        vm.prank(creator);
        assertEq(s2.claim(creator), 2.25 ether);
        assertEq(s2.claimDividends(alice), 3.6 ether);
        assertEq(s2.pushLiquidity(), 0.9 ether);
        vm.prank(buybackModule);
        assertEq(s2.releaseBuyback(), 2.25 ether);

        // only the protocol's own claim fails, and only until the treasury is fixed
        vm.expectRevert();
        s2.claimProtocol();
        assertEq(s2.protocolClaimable(), 1 ether, "still owed, still there");
    }
}
