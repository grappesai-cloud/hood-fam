// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";

import {HoodPot} from "../src/bag/HoodPot.sol";
import {BagReasons} from "../src/bag/BagTypes.sol";
import {IHoodPot} from "../src/interfaces/IHoodPot.sol";
import {PairTransfer} from "../src/libraries/PairTransfer.sol";
import {BagUSD, MockBagFactory, ToggleReceiver} from "./mocks/BagMocks.sol";

/// @notice The curve launch's pot. The test contract plays the token: it keeps the balances and
///         reports every move the way HoodToken's `_update` will.
contract PotTest is Test {
    MockBagFactory internal factory;
    HoodPot internal pot;
    HoodPot internal potUsd;
    BagUSD internal usd;

    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");
    address internal carol = makeAddr("carol");
    address internal curve = makeAddr("curve");
    address internal grad = makeAddr("graduator");
    address internal payer = makeAddr("payer");

    mapping(address => uint256) internal bal;

    function setUp() public {
        factory = new MockBagFactory(address(this));
        factory.setGraduationHandler(grad);
        usd = new BagUSD();
        pot = new HoodPot(address(factory), address(this), address(0));
        potUsd = new HoodPot(address(factory), address(this), address(usd));
        vm.deal(payer, 10_000 ether);
        usd.mint(payer, 1_000_000e6);
        vm.prank(payer);
        usd.approve(address(potUsd), type(uint256).max);
    }

    // ---------------------------------------------------------------- helpers: the token's job

    function _move(HoodPot p, address from, address to, uint256 amount) internal {
        if (from != address(0)) bal[from] -= amount;
        if (to != address(0)) bal[to] += amount;
        p.syncBalances(from, to, bal[from], bal[to]);
    }

    function _mint(HoodPot p, address to, uint256 amount) internal {
        _move(p, address(0), to, amount);
    }

    function _exclude(HoodPot p, address who) internal {
        vm.prank(address(factory));
        p.exclude(who);
    }

    function _deposit(uint256 amount) internal {
        vm.prank(payer);
        pot.depositForHolders{value: amount}(amount, BagReasons.PAYDAY, payer);
    }

    // ---------------------------------------------------------------- access

    function test_only_the_token_syncs() public {
        vm.prank(alice);
        vm.expectRevert(HoodPot.NotToken.selector);
        pot.syncBalances(address(0), alice, 0, 1);
    }

    function test_exclude_is_for_the_factory_or_the_graduation_handler() public {
        vm.prank(alice);
        vm.expectRevert(HoodPot.NotFactory.selector);
        pot.exclude(curve);
        vm.expectRevert(HoodPot.NotFactory.selector);
        pot.exclude(curve);
        _exclude(pot, curve);
        assertTrue(pot.excluded(curve));
        vm.prank(grad);
        pot.exclude(bob);
        assertTrue(pot.excluded(bob));
    }

    function test_immutables() public view {
        assertEq(pot.factory(), address(factory));
        assertEq(pot.token(), address(this));
        assertEq(pot.asset(), address(0));
        assertEq(potUsd.asset(), address(usd));
    }

    // ---------------------------------------------------------------- the accumulator

    function test_deposit_before_any_holder_is_orphaned_then_credited_on_the_first_sync() public {
        vm.expectEmit(true, true, true, true, address(pot));
        emit IHoodPot.HoldersPaid(BagReasons.PAYDAY, payer, 1 ether, 0);
        _deposit(1 ether);
        assertEq(pot.orphaned(), 1 ether);
        assertEq(pot.totalDeposited(), 1 ether);
        assertEq(pot.pending(alice), 0);

        _mint(pot, alice, 100);
        assertEq(pot.orphaned(), 0);
        assertEq(pot.pending(alice), 1 ether, "the first eligible holder gets the orphaned money");
    }

    function test_holders_earn_pro_rata_to_balance() public {
        _mint(pot, alice, 100e18);
        _mint(pot, bob, 300e18);
        vm.expectEmit(true, true, true, true, address(pot));
        emit IHoodPot.HoldersPaid(BagReasons.DIVIDENDS, payer, 4 ether, 400e18);
        vm.prank(payer);
        pot.depositForHolders{value: 4 ether}(4 ether, BagReasons.DIVIDENDS, payer);
        assertEq(pot.pending(alice), 1 ether);
        assertEq(pot.pending(bob), 3 ether);
        assertEq(pot.eligibleSupply(), 400e18);
    }

    function test_excluded_accounts_never_earn() public {
        _exclude(pot, curve);
        _mint(pot, curve, 1_000e18);
        assertEq(pot.eligibleSupply(), 0, "the curve holds no share");
        _move(pot, curve, alice, 100e18);
        assertEq(pot.eligibleSupply(), 100e18);
        _deposit(1 ether);
        assertEq(pot.pending(alice), 1 ether);
        assertEq(pot.pending(curve), 0);
        _move(pot, alice, curve, 50e18);
        _deposit(1 ether);
        assertEq(pot.pending(alice), 2 ether, "alice still holds all of the eligible supply");
        assertEq(pot.pending(curve), 0);
    }

    function test_excluding_a_holder_keeps_what_it_earned_and_stops_it_earning() public {
        _mint(pot, alice, 100e18);
        _mint(pot, bob, 100e18);
        _deposit(2 ether);
        _exclude(pot, bob);
        assertEq(pot.eligibleSupply(), 100e18);
        assertEq(pot.pending(bob), 1 ether, "earned before the exclusion");
        _deposit(1 ether);
        assertEq(pot.pending(alice), 2 ether);
        assertEq(pot.pending(bob), 1 ether);
        uint256 got = pot.claim(bob);
        assertEq(got, 1 ether);
        assertEq(bob.balance, 1 ether);
    }

    function test_transfers_move_future_earnings_only() public {
        _mint(pot, alice, 100e18);
        _deposit(1 ether);
        _move(pot, alice, bob, 100e18);
        _deposit(1 ether);
        assertEq(pot.pending(alice), 1 ether);
        assertEq(pot.pending(bob), 1 ether);
        _move(pot, bob, alice, 50e18);
        _deposit(1 ether);
        assertEq(pot.pending(alice), 1.5 ether);
        assertEq(pot.pending(bob), 1.5 ether);
    }

    function test_stranger_has_nothing_pending() public {
        _mint(pot, alice, 100e18);
        _deposit(1 ether);
        assertEq(pot.pending(carol), 0);
    }

    // ---------------------------------------------------------------- payment convention

    function test_deposit_zero_is_a_no_op_and_value_mismatch_reverts() public {
        vm.prank(payer);
        pot.depositForHolders(0, BagReasons.PAYDAY, payer);
        assertEq(pot.totalDeposited(), 0);
        vm.prank(payer);
        vm.expectRevert(HoodPot.WrongValue.selector);
        pot.depositForHolders{value: 1}(0, BagReasons.PAYDAY, payer);
        vm.prank(payer);
        vm.expectRevert(PairTransfer.WrongValue.selector);
        pot.depositForHolders{value: 1}(2, BagReasons.PAYDAY, payer);
        vm.prank(payer);
        vm.expectRevert(PairTransfer.WrongValue.selector);
        potUsd.depositForHolders{value: 1}(1e6, BagReasons.PAYDAY, payer);
    }

    function test_erc20_pot_pulls_from_the_payer() public {
        _mint(potUsd, alice, 100e18);
        vm.prank(payer);
        potUsd.depositForHolders(10e6, BagReasons.LP_FEES, payer);
        assertEq(usd.balanceOf(address(potUsd)), 10e6);
        assertEq(potUsd.pending(alice), 10e6);
    }

    // ---------------------------------------------------------------- claim

    function test_claim_pays_the_account_never_the_caller() public {
        _mint(pot, alice, 100e18);
        _deposit(1 ether);
        vm.expectEmit(true, true, true, true, address(pot));
        emit IHoodPot.Pushed(alice, 1 ether);
        vm.prank(bob);
        uint256 got = pot.claim(alice);
        assertEq(got, 1 ether);
        assertEq(alice.balance, 1 ether);
        assertEq(bob.balance, 0);
        assertEq(pot.pending(alice), 0);
        assertEq(pot.totalPaid(), 1 ether);
        vm.expectRevert(HoodPot.Nothing.selector);
        pot.claim(alice);
    }

    function test_claim_erc20() public {
        _mint(potUsd, alice, 100e18);
        vm.prank(payer);
        potUsd.depositForHolders(10e6, BagReasons.LP_FEES, payer);
        potUsd.claim(alice);
        assertEq(usd.balanceOf(alice), 10e6);
        assertEq(potUsd.totalPaid(), 10e6);
    }

    // ---------------------------------------------------------------- pushMany

    function test_pushMany_pays_above_the_floor_and_skips_a_receiver_that_reverts() public {
        ToggleReceiver rejecting = new ToggleReceiver();
        rejecting.setAccept(false);
        _mint(pot, alice, 100e18);
        _mint(pot, address(rejecting), 100e18);
        _mint(pot, carol, 1e18);
        _deposit(201 ether);
        assertEq(pot.pending(alice), 100 ether);
        assertEq(pot.pending(address(rejecting)), 100 ether);
        assertEq(pot.pending(carol), 1 ether);

        address[] memory accounts = new address[](3);
        accounts[0] = alice;
        accounts[1] = address(rejecting);
        accounts[2] = carol;
        vm.expectEmit(true, true, true, true, address(pot));
        emit IHoodPot.Pushed(alice, 100 ether);
        vm.expectEmit(true, true, true, true, address(pot));
        emit HoodPot.PushSkipped(address(rejecting), 100 ether);
        (uint256 paid, uint256 count) = pot.pushMany(accounts, 50 ether);
        assertEq(paid, 100 ether);
        assertEq(count, 1);
        assertEq(alice.balance, 100 ether);
        assertEq(pot.pending(alice), 0);
        assertEq(pot.pending(address(rejecting)), 100 ether, "untouched, still theirs");
        assertEq(pot.pending(carol), 1 ether, "under the floor, still theirs");
        assertEq(pot.totalPaid(), 100 ether);

        // the rejecting holder can be paid once it accepts, and the floor at zero pays carol
        rejecting.setAccept(true);
        (paid, count) = pot.pushMany(accounts, 0);
        assertEq(paid, 101 ether);
        assertEq(count, 2);
        assertEq(address(rejecting).balance, 100 ether);
        assertEq(carol.balance, 1 ether);
        assertEq(pot.totalPaid(), 201 ether);
        assertEq(address(pot).balance, 0);
    }

    function test_pushMany_pays_a_duplicate_only_once() public {
        _mint(pot, alice, 100e18);
        _deposit(1 ether);
        address[] memory accounts = new address[](2);
        accounts[0] = alice;
        accounts[1] = alice;
        (uint256 paid, uint256 count) = pot.pushMany(accounts, 0);
        assertEq(paid, 1 ether);
        assertEq(count, 1);
    }

    function test_pushMany_erc20() public {
        _mint(potUsd, alice, 100e18);
        _mint(potUsd, bob, 100e18);
        vm.prank(payer);
        potUsd.depositForHolders(10e6, BagReasons.PAYDAY, payer);
        address[] memory accounts = new address[](2);
        accounts[0] = alice;
        accounts[1] = bob;
        (uint256 paid, uint256 count) = potUsd.pushMany(accounts, 5e6);
        assertEq(paid, 10e6);
        assertEq(count, 2);
        assertEq(usd.balanceOf(alice), 5e6);
        assertEq(usd.balanceOf(bob), 5e6);
    }

    function test_pushMany_with_nothing_pending_pays_nothing() public {
        address[] memory accounts = new address[](1);
        accounts[0] = alice;
        (uint256 paid, uint256 count) = pot.pushMany(accounts, 0);
        assertEq(paid, 0);
        assertEq(count, 0);
    }

    function test_totals_track_every_deposit_and_payout() public {
        _mint(pot, alice, 1e18);
        _deposit(1 ether);
        _deposit(2 ether);
        assertEq(pot.totalDeposited(), 3 ether);
        pot.claim(alice);
        assertEq(pot.totalPaid(), 3 ether);
        assertEq(pot.totalDeposited() - pot.totalPaid(), address(pot).balance);
    }

    function testFuzz_two_holders_split_exactly_by_balance(uint128 a, uint128 b, uint96 amount) public {
        a = uint128(bound(uint256(a), 1, 1e27));
        b = uint128(bound(uint256(b), 1, 1e27));
        uint256 deposit = bound(uint256(amount), 1, 1e24);
        _mint(pot, alice, a);
        _mint(pot, bob, b);
        vm.deal(payer, deposit);
        _deposit(deposit);
        uint256 pa = pot.pending(alice);
        uint256 pb = pot.pending(bob);
        assertLe(pa + pb, deposit, "never more than was deposited");
        // The accumulator floors twice: once when the deposit becomes a per-share rate, which loses
        // up to eligibleSupply / ACC wei (ACC is 1e27, a billion tokens with eighteen decimals, so
        // a real launch loses at most one), and once per holder when the rate becomes an amount.
        uint256 dust = 2 + (uint256(a) + b) / 1e27;
        assertGe(pa + pb + dust, deposit, "at most the accumulator's rounding");
        assertLe(pa, (deposit * a) / (uint256(a) + b) + 1);
        assertLe(pb, (deposit * b) / (uint256(a) + b) + 1);
    }
}
