// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Vm} from "forge-std/Vm.sol";
import {console2} from "forge-std/console2.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {StateLibrary} from "@uniswap/v4-core/src/libraries/StateLibrary.sol";

import {HoodLaunchHook} from "../src/direct/HoodLaunchHook.sol";
import {HoodRevenueSplitter} from "../src/direct/HoodRevenueSplitter.sol";
import {HoodBuybackModule} from "../src/direct/HoodBuybackModule.sol";
import {PenaltyConfig, BagReasons} from "../src/bag/BagTypes.sol";
import {IHoodPot} from "../src/interfaces/IHoodPot.sol";
import {DirectPoolBase} from "./DirectSwap.t.sol";

/// @notice The penalties, on a real PoolManager: snipe on buys, jeet and whale on sells, each
///         split 80% to the pot and 20% to the Bag with the king pot's slice off the holders'
///         share, and the buyback a penalised sell sets off.
abstract contract PenaltyBase is DirectPoolBase {
    using StateLibrary for IPoolManager;

    uint16 internal constant JEET_BPS = 1_000;
    uint32 internal constant JEET_WINDOW = 120;
    uint16 internal constant WHALE_BPS = 500;
    uint24 internal constant WHALE_TICKS = 1_000;
    uint16 internal constant KING_BPS = 1_000;

    bytes32 internal constant HOLDERS_PAID = keccak256("HoldersPaid(bytes32,address,uint256,uint256)");
    bytes32 internal constant BUYBACK_TRIGGERED = keccak256("BuybackTriggered(uint256,uint256)");
    bytes32 internal constant BUYBACK_WANTED = keccak256("BuybackWanted(address)");

    function _penalties() internal view virtual override returns (PenaltyConfig memory) {
        return PenaltyConfig(JEET_BPS, JEET_WINDOW, WHALE_BPS, WHALE_TICKS, KING_BPS, false);
    }

    /// @dev What a penalty of `amount` splits into here: 20% Bag, 10% of the rest to the king.
    function _split(uint256 amount) internal pure returns (uint256 toHolders, uint256 toBag, uint256 toKing) {
        toBag = amount / 5;
        toKing = ((amount - toBag) * KING_BPS) / BPS;
        toHolders = amount - toBag - toKing;
    }

    /// @dev The last HoldersPaid on the splitter with `reason`: (payer, amount), or found = false.
    function _holdersPaid(Vm.Log[] memory logs, bytes32 reason) internal view returns (address payer, uint256 amount, bool found) {
        for (uint256 i = logs.length; i > 0; --i) {
            Vm.Log memory l = logs[i - 1];
            if (l.emitter == address(splitter) && l.topics[0] == HOLDERS_PAID && l.topics[1] == reason) {
                (amount,) = abi.decode(l.data, (uint256, uint256));
                return (address(uint160(uint256(l.topics[2]))), amount, true);
            }
        }
    }

}

contract DirectPenaltiesTest is PenaltyBase {
    // ---------------------------------------------------------------- snipe

    function test_a_sniper_pays_the_pot_and_the_bag_and_is_named_on_the_tape() public {
        assertEq(block.timestamp, hook.launchTime());
        vm.recordLogs();
        _buyExactIn(alice, 1 ether);
        Vm.Log[] memory logs = vm.getRecordedLogs();

        // the surcharge is 50% of the trade; the schedule (6%) rides alongside it
        PenaltyLog memory p = _penaltyLog(logs, BagReasons.SNIPE);
        (uint256 toHolders, uint256 toBag, uint256 toKing) = _split(0.5 ether);
        assertTrue(p.found);
        assertEq(p.payer, alice, "the sniper, by origin");
        assertEq(p.amount, 0.5 ether);
        assertEq(p.toHolders, toHolders, "80%, less the king's slice");
        assertEq(p.toBag, toBag, "20%");
        assertTrue(p.isBuy);
        assertEq(hook.snipeClaims(), 0.5 ether, "held as a claim until the input is settled");
        assertEq(splitter.king(), alice, "and the first buyer wears the crown");
        assertEq(splitter.kingEndsAt(), block.timestamp + 60);

        // the flush routes it: one deposit for the pot, from the hook; the Bag's cut; the king's slice
        vm.recordLogs();
        hook.flushClaims();
        (address payer, uint256 amount, bool found) = _holdersPaid(vm.getRecordedLogs(), BagReasons.SNIPE);
        assertTrue(found);
        assertEq(payer, address(hook), "buy-side penalties are booked in one deposit at the flush");
        assertEq(amount, toHolders);
        assertEq(splitter.totalDeposited(), toHolders);
        assertEq(splitter.kingPot(), toKing);
        assertEq(bag.total(bag.PENALTY(), address(0)), toBag);
        assertEq(bag.total(bag.TRADE(), address(0)), _bagFee(1 ether), "the platform's 70 bps went in as a trade fee");
        assertEq(address(splitter).balance, _creatorFee(1 ether, true) + toHolders + toKing);
        assertEq(address(hook).balance, 0);
        assertEq(hook.snipeClaims(), 0);
    }

    // ---------------------------------------------------------------- jeet

    function test_a_flip_inside_the_window_pays_the_jeet_tax_and_one_after_it_does_not() public {
        _pastTheWindow();
        _buyExactIn(alice, 1 ether);
        hook.flushClaims();
        assertEq(hook.lastBuyAt(alice), block.timestamp, "the buy is remembered by origin");
        uint256 holdings = token.balanceOf(alice);

        // a quarter, sixty seconds later: a flip, and too small a move to be a dump
        vm.warp(block.timestamp + 60);
        int24 before = _tick();
        vm.recordLogs();
        _sellExactIn(alice, holdings / 4);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertLt(uint256(int256(_tick() - before)), WHALE_TICKS, "not a dump");
        (,, uint256 volume) = _lastTaxed(logs);
        uint256 jeet = (volume * JEET_BPS) / BPS;
        (uint256 toHolders, uint256 toBag, uint256 toKing) = _split(jeet);

        PenaltyLog memory p = _penaltyLog(logs, BagReasons.JEET);
        assertTrue(p.found);
        assertEq(p.payer, alice);
        assertEq(p.amount, jeet);
        assertEq(p.toHolders, toHolders);
        assertEq(p.toBag, toBag);
        assertFalse(p.isBuy);
        assertFalse(_penaltyLog(logs, BagReasons.WHALE).found);

        // routed inside the swap, with the seller's name on the pot's deposit
        (address payer, uint256 amount, bool found) = _holdersPaid(logs, BagReasons.JEET);
        assertTrue(found);
        assertEq(payer, alice);
        assertEq(amount, toHolders);
        assertEq(splitter.kingPot(), toKing);
        assertEq(bag.total(bag.PENALTY(), address(0)), toBag);
        assertEq(address(hook).balance, hook.buybackCarry(), "only what the buyback could not spend stays");

        // past the window the same sell is just a sell
        vm.warp(hook.lastBuyAt(alice) + JEET_WINDOW + 1);
        vm.recordLogs();
        _sellExactIn(alice, holdings / 4);
        logs = vm.getRecordedLogs();
        assertFalse(_penaltyLog(logs, BagReasons.JEET).found, "no flip after the window");
        assertFalse(_penaltyLog(logs, BagReasons.WHALE).found);
    }

    // ---------------------------------------------------------------- whale

    function test_a_dump_past_the_tick_limit_pays_the_whale_tax() public {
        _pastTheWindow();
        _buyExactIn(alice, 2 ether);
        _buyExactIn(bob, 0.01 ether);
        hook.flushClaims();
        vm.warp(block.timestamp + JEET_WINDOW + 1); // nobody is flipping

        // bob's small sell moves the price a few ticks: nothing
        int24 before = _tick();
        vm.recordLogs();
        _sellExactIn(bob, token.balanceOf(bob));
        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertLt(uint256(int256(_tick() - before)), WHALE_TICKS);
        assertFalse(_penaltyLog(logs, BagReasons.WHALE).found);

        // alice's whole bag moves it past the line: a dump
        before = _tick();
        vm.recordLogs();
        _sellExactIn(alice, token.balanceOf(alice));
        logs = vm.getRecordedLogs();
        assertGt(uint256(int256(_tick() - before)), WHALE_TICKS, "more than the limit");
        (,, uint256 volume) = _lastTaxed(logs);
        uint256 whale = (volume * WHALE_BPS) / BPS;
        (uint256 toHolders, uint256 toBag,) = _split(whale);
        PenaltyLog memory p = _penaltyLog(logs, BagReasons.WHALE);
        assertTrue(p.found);
        assertEq(p.payer, alice);
        assertEq(p.amount, whale);
        assertEq(p.toHolders, toHolders);
        assertEq(p.toBag, toBag);
        assertFalse(_penaltyLog(logs, BagReasons.JEET).found);
        (address payer, uint256 amount, bool found) = _holdersPaid(logs, BagReasons.WHALE);
        assertTrue(found);
        assertEq(payer, alice);
        assertEq(amount, toHolders);
    }

    /// @dev An exact-output sell names the quote it wants before the pool has moved, so the hook
    ///      measures the move off the liquidity in range instead of waiting for it.
    function test_an_exact_output_dump_is_measured_before_the_swap() public {
        _pastTheWindow();
        _buyExactIn(alice, 2 ether);
        hook.flushClaims();
        vm.warp(block.timestamp + JEET_WINDOW + 1);

        int24 before = _tick();
        vm.recordLogs();
        _sellExactOut(alice, 0.01 ether);
        assertLt(uint256(int256(_tick() - before)), WHALE_TICKS);
        assertFalse(_penaltyLog(vm.getRecordedLogs(), BagReasons.WHALE).found, "a small draw is not a dump");

        before = _tick();
        vm.recordLogs();
        _sellExactOut(alice, 1 ether);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertGt(uint256(int256(_tick() - before)), WHALE_TICKS);
        PenaltyLog memory p = _penaltyLog(logs, BagReasons.WHALE);
        assertTrue(p.found, "the estimate caught it");
        assertEq(p.amount, (1 ether * uint256(WHALE_BPS)) / BPS, "the rate on the quote asked for");
        assertEq(p.payer, alice);
    }

    // ---------------------------------------------------------------- bots buy the dip

    function test_a_penalised_sell_buys_the_dip_right_away_and_only_once_a_block() public {
        _pastTheWindow();
        _buyExactIn(alice, 1 ether);
        _buyExactIn(bob, 1 ether);
        hook.flushClaims();
        splitter.sweep();
        assertGt(splitter.buybackPot(), 0, "the buys filled the pot");
        uint256 supplyBefore = token.totalSupply();

        // alice flips: her jeet tax is routed, and then the pot buys the dip inside the same swap
        vm.warp(block.timestamp + 10);
        vm.recordLogs();
        _sellExactIn(alice, token.balanceOf(alice) / 4);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertTrue(_penaltyLog(logs, BagReasons.JEET).found);
        assertEq(_countTopic(logs, address(hook), BUYBACK_TRIGGERED), 1, "the buyback ran inline");
        assertEq(_countTopic(logs, address(hook), BUYBACK_WANTED), 0);
        assertLt(token.totalSupply(), supplyBefore, "and what it bought was burned");
        assertEq(token.balanceOf(address(hook)), 0);
        assertEq(hook.lastBuybackBlock(), block.number);
        assertEq(address(hook).balance, hook.buybackCarry());
        (uint256 spent, uint256 burned) = _decodeBuyback(logs);
        console2.log("inline buyback: spent / burned", spent, burned);
        assertGt(spent, 0);
        assertEq(burned, supplyBefore - token.totalSupply());

        // bob flips in the same block: penalised, but the buyback is left to the keeper
        supplyBefore = token.totalSupply();
        vm.recordLogs();
        _sellExactIn(bob, token.balanceOf(bob) / 4);
        logs = vm.getRecordedLogs();
        assertTrue(_penaltyLog(logs, BagReasons.JEET).found);
        assertEq(_countTopic(logs, address(hook), BUYBACK_TRIGGERED), 0);
        assertEq(_countTopic(logs, address(hook), BUYBACK_WANTED), 1, "one buyback a block, across both");
        assertEq(token.totalSupply(), supplyBefore);

        // and the keeper's module respects the hook's run the same way
        vm.expectRevert(HoodBuybackModule.AlreadyRanThisBlock.selector);
        module.run(address(token), 0);
        vm.roll(block.number + 1);
        splitter.sweep();
        if (splitter.buybackPot() != 0) {
            assertGt(module.run(address(token), 0), 0, "next block, the keeper runs");
        }
    }

    function _decodeBuyback(Vm.Log[] memory logs) internal view returns (uint256 spent, uint256 burned) {
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter == address(hook) && logs[i].topics[0] == BUYBACK_TRIGGERED) {
                return abi.decode(logs[i].data, (uint256, uint256));
            }
        }
    }

    // ---------------------------------------------------------------- king of the hill

    function test_the_king_pot_fills_crowns_the_last_buyer_and_pays_out_after_sixty_seconds() public {
        // anchored on the hook's clock: under via-IR a local copy of block.timestamp is re-read
        // after a warp
        uint256 start = hook.launchTime();
        _buyExactIn(alice, 1 ether); // t=0: a snipe, so the pot fills at the flush
        assertEq(splitter.king(), alice);
        vm.warp(start + 1);
        _buyExactIn(bob, 0.5 ether); // t=1: still a snipe, and bob takes the crown
        hook.flushClaims();
        uint256 pot = splitter.kingPot();
        assertGt(pot, 0);
        assertEq(splitter.king(), bob);
        assertEq(splitter.kingEndsAt(), start + 1 + 60);

        // a dust buy does not move the crown: it has to be worth a hundredth of the pot
        vm.warp(start + 2);
        _buyExactIn(alice, pot / 200);
        assertEq(splitter.king(), bob, "too small to count");
        _buyExactIn(alice, pot / 50);
        assertEq(splitter.king(), alice, "big enough");
        assertEq(splitter.kingEndsAt(), start + 2 + 60);

        vm.warp(start + 2 + 59);
        vm.expectRevert(HoodRevenueSplitter.KingStillReigns.selector);
        splitter.settleKing();
        vm.warp(start + 2 + 60);
        uint256 before = alice.balance;
        vm.expectEmit(true, true, true, false, address(splitter));
        emit HoodRevenueSplitter.KingWon(alice, 0);
        uint256 won = splitter.settleKing();
        assertEq(alice.balance - before, won);
        assertEq(splitter.kingPot(), 0);
        assertEq(splitter.king(), address(0));
    }

    // ---------------------------------------------------------------- exemptions

    function test_the_portal_and_the_module_never_pay_a_penalty() public {
        // the portal's opening buy at t=0: schedule only, no snipe, no crown for the origin
        vm.recordLogs();
        _swapAsPortal(_buyExactInParams(1 ether));
        assertFalse(_penaltyLog(vm.getRecordedLogs(), BagReasons.SNIPE).found);
        assertEq(hook.snipeClaims(), 0);
        assertEq(hook.claimsHeld(), _schedule(1 ether, true));
        hook.flushClaims();

        // the module's buyback at t=0: base tax only
        splitter.sweep();
        vm.recordLogs();
        module.run(address(token), 0);
        assertFalse(_penaltyLog(vm.getRecordedLogs(), BagReasons.SNIPE).found);
        assertEq(hook.bagClaims(), 0);
        assertEq(hook.snipeClaims(), 0);
    }
}

/// @notice "Lockers eat the jeets": the same launch with `penaltiesToVault` on. Jeet and whale
///         holder shares go to the Vault; the snipe's still goes to the pot; the king's slice and
///         the Bag's cut do not move.
contract DirectPenaltiesToVaultTest is PenaltyBase {
    function _penalties() internal view override returns (PenaltyConfig memory) {
        return PenaltyConfig(JEET_BPS, JEET_WINDOW, WHALE_BPS, WHALE_TICKS, KING_BPS, true);
    }

    function test_jeet_and_whale_shares_go_to_the_vault_and_the_snipes_to_the_pot() public {
        assertEq(hook.vault(), address(vault));
        _buyExactIn(bob, 1 ether); // t=0: a snipe
        hook.flushClaims();
        (uint256 snipeHolders,,) = _split(0.5 ether);
        assertEq(splitter.totalDeposited(), snipeHolders, "the snipe's 80% is still the pot's");
        assertEq(vault.rewards(address(0)), 0);

        _pastTheWindow();
        _buyExactIn(alice, 2 ether);
        hook.flushClaims();
        vm.warp(block.timestamp + 10);
        uint256 potBefore = splitter.totalDeposited();
        uint256 kingBefore = splitter.kingPot();
        uint256 bagBefore = bag.total(bag.PENALTY(), address(0));
        vm.recordLogs();
        _sellExactIn(alice, token.balanceOf(alice)); // a flip and a dump at once
        Vm.Log[] memory logs = vm.getRecordedLogs();
        _checkVaultRouting(logs, potBefore, kingBefore, bagBefore);
    }

    function _checkVaultRouting(Vm.Log[] memory logs, uint256 potBefore, uint256 kingBefore, uint256 bagBefore) internal {
        PenaltyLog memory jeet = _penaltyLog(logs, BagReasons.JEET);
        PenaltyLog memory whale = _penaltyLog(logs, BagReasons.WHALE);
        assertTrue(jeet.found && whale.found, "both penalties on one sell");
        assertEq(vault.rewards(address(0)), jeet.toHolders + whale.toHolders, "the lockers ate them");
        assertEq(vault.notifyCount(), 2, "pushed then notified, once each");
        // the pot only grew by the creator's own dividends leg, swept inside the inline buyback
        assertEq(splitter.totalDeposited() - potBefore, _dividendsLeg(logs), "none of the penalties reached the holders");
        (,, bool found) = _holdersPaid(logs, BagReasons.JEET);
        assertFalse(found);
        (,, found) = _holdersPaid(logs, BagReasons.WHALE);
        assertFalse(found);
        assertEq(splitter.kingPot() - kingBefore, _kingSlice(jeet) + _kingSlice(whale), "the king's slice comes off first");
        assertEq(bag.total(bag.PENALTY(), address(0)) - bagBefore, jeet.toBag + whale.toBag);
    }

    function _kingSlice(PenaltyLog memory p) internal pure returns (uint256) {
        return p.amount - p.toHolders - p.toBag;
    }

    function _dividendsLeg(Vm.Log[] memory logs) internal view returns (uint256 sum) {
        for (uint256 i; i < logs.length; ++i) {
            Vm.Log memory l = logs[i];
            if (l.emitter == address(splitter) && l.topics[0] == HOLDERS_PAID && l.topics[1] == BagReasons.DIVIDENDS) {
                (uint256 amount,) = abi.decode(l.data, (uint256, uint256));
                sum += amount;
            }
        }
    }
}
