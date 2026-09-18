// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

import {HoodSeasonDrop} from "../src/HoodSeasonDrop.sol";
import {PairTransfer} from "../src/libraries/PairTransfer.sol";
import {MockUSD, RejectNative} from "./mocks/Mocks.sol";

/// @notice A season ends, one root is published, and the list takes its share. The tree is built
///         here in Solidity with sorted-pair hashing, the shape OpenZeppelin's merkle-tree package
///         produces, so the proofs these tests pass in are the proofs the CLI will hand out.
contract SeasonDropTest is Test {
    HoodSeasonDrop internal drop;
    MockUSD internal usd;

    address internal treasury = makeAddr("treasury");
    address internal stranger = makeAddr("stranger");

    /// @dev Five rows, an odd count on purpose: the last node of a level is promoted rather than
    ///      paired, and a proof that ignores that promotion is a proof that does not verify.
    address[] internal holders;
    uint256[] internal shares;

    uint256 internal constant POOL = 10 ether;
    uint64 internal constant WINDOW = 60 days;

    function setUp() public {
        drop = new HoodSeasonDrop(address(this), treasury);
        usd = new MockUSD();

        holders.push(makeAddr("alice"));
        shares.push(1 ether);
        holders.push(makeAddr("bob"));
        shares.push(2 ether);
        holders.push(makeAddr("carol"));
        shares.push(3 ether);
        holders.push(makeAddr("dave"));
        shares.push(0.5 ether);
        holders.push(makeAddr("erin"));
        shares.push(3.5 ether);

        vm.deal(address(this), 1_000 ether);
        usd.mint(address(this), 1_000 ether);
        usd.approve(address(drop), type(uint256).max);
    }

    // ---------------------------------------------------------------- the tree

    function _hashPair(bytes32 a, bytes32 b) internal pure returns (bytes32) {
        return a < b ? keccak256(abi.encode(a, b)) : keccak256(abi.encode(b, a));
    }

    /// @notice Builds the tree over `leaves` and, in the same pass, the proof for `index`.
    function _tree(bytes32[] memory leaves, uint256 index)
        internal
        pure
        returns (bytes32 root, bytes32[] memory proof)
    {
        bytes32[] memory level = leaves;
        bytes32[] memory siblings = new bytes32[](32);
        uint256 depth;
        uint256 idx = index;

        while (level.length > 1) {
            uint256 up = (level.length + 1) / 2;
            bytes32[] memory parents = new bytes32[](up);
            for (uint256 i; i < up; ++i) {
                uint256 left = 2 * i;
                uint256 right = left + 1;
                parents[i] = right < level.length ? _hashPair(level[left], level[right]) : level[left];
            }
            // An unpaired last node contributes nothing to the proof: it walks up untouched.
            if ((idx ^ 1) < level.length) siblings[depth++] = level[idx ^ 1];
            idx /= 2;
            level = parents;
        }

        root = level[0];
        proof = new bytes32[](depth);
        for (uint256 i; i < depth; ++i) {
            proof[i] = siblings[i];
        }
    }

    /// @dev The encoding written out by hand rather than read back from the contract, so the tree
    ///      in this file is independent of the thing it is testing.
    function _leaf(uint256 season, address account, uint256 amount) internal pure returns (bytes32) {
        return keccak256(bytes.concat(keccak256(abi.encode(season, account, amount))));
    }

    function _leaves(uint256 season) internal view returns (bytes32[] memory out) {
        out = new bytes32[](holders.length);
        for (uint256 i; i < holders.length; ++i) {
            out[i] = _leaf(season, holders[i], shares[i]);
        }
    }

    function _root(uint256 season) internal view returns (bytes32 root) {
        (root,) = _tree(_leaves(season), 0);
    }

    function _proof(uint256 season, uint256 index) internal view returns (bytes32[] memory proof) {
        (, proof) = _tree(_leaves(season), index);
    }

    function _open(uint256 season, address asset) internal {
        _open(season, asset, POOL);
    }

    function _open(uint256 season, address asset, uint256 total) internal {
        uint64 deadline = uint64(block.timestamp) + WINDOW;
        if (asset == address(0)) {
            drop.openDrop{value: total}(season, _root(season), address(0), total, deadline);
        } else {
            drop.openDrop(season, _root(season), asset, total, deadline);
        }
    }

    function _claim(uint256 season, uint256 index) internal returns (uint256) {
        return drop.claim(season, holders[index], shares[index], _proof(season, index));
    }

    // ---------------------------------------------------------------- the leaf encoding

    function test_the_leaf_is_the_openzeppelin_double_hash() public view {
        // Computed off chain, not restated from the contract: season 1, address(1), amount 1.
        assertEq(
            drop.leafOf(1, address(1), 1),
            bytes32(0x7b492a5431c35eebd2d53bbba9fa01228c2ad4e37faaa64b09192cff0a7eca98),
            "the CLI on the other side has to produce exactly this"
        );
        for (uint256 i; i < holders.length; ++i) {
            assertEq(drop.leafOf(1, holders[i], shares[i]), _leaf(1, holders[i], shares[i]));
        }
    }

    // ---------------------------------------------------------------- end to end

    function test_a_native_drop_pays_every_leaf_to_the_wei() public {
        _open(1, address(0));
        assertEq(address(drop).balance, POOL, "funded in the same call that opened it");

        uint256 paid;
        for (uint256 i; i < holders.length; ++i) {
            paid += _claim(1, i);
            assertEq(holders[i].balance, shares[i]);
        }

        assertEq(paid, POOL, "the whole pool, to the wei");
        assertEq(drop.unclaimed(1), 0);
        assertEq(address(drop).balance, 0, "nothing is left behind");
    }

    function test_an_erc20_drop_pays_every_leaf_to_the_wei() public {
        _open(2, address(usd));
        assertEq(usd.balanceOf(address(drop)), POOL);

        uint256 paid;
        for (uint256 i; i < holders.length; ++i) {
            paid += _claim(2, i);
            assertEq(usd.balanceOf(holders[i]), shares[i]);
        }

        assertEq(paid, POOL, "the whole pool, to the wei");
        assertEq(usd.balanceOf(address(drop)), 0);
    }

    function test_a_root_can_never_be_rewritten() public {
        _open(1, address(0));
        vm.expectRevert(HoodSeasonDrop.AlreadyOpen.selector);
        drop.openDrop{value: POOL}(1, keccak256("a better list"), address(0), POOL, uint64(block.timestamp) + WINDOW);

        (bytes32 root,,,,,,) = drop.drops(1);
        assertEq(root, _root(1), "the published list is the list");
    }

    function test_a_wrong_amount_or_a_wrong_account_fails_the_proof() public {
        _open(1, address(0));

        vm.expectRevert(HoodSeasonDrop.BadProof.selector);
        drop.claim(1, holders[0], shares[0] + 1, _proof(1, 0));

        // Somebody else's proof, with their amount, against an address that is not on the list.
        vm.expectRevert(HoodSeasonDrop.BadProof.selector);
        drop.claim(1, stranger, shares[0], _proof(1, 0));

        assertFalse(drop.isClaimable(1, stranger, shares[0], _proof(1, 0)));
        assertTrue(drop.isClaimable(1, holders[0], shares[0], _proof(1, 0)));
    }

    function test_a_leaf_can_only_be_claimed_once() public {
        _open(1, address(0));
        _claim(1, 0);

        vm.expectRevert(HoodSeasonDrop.AlreadyClaimed.selector);
        _claim(1, 0);
        assertFalse(drop.isClaimable(1, holders[0], shares[0], _proof(1, 0)));
    }

    function test_claiming_for_somebody_else_pays_them_not_the_caller() public {
        _open(1, address(0));
        uint256 before = stranger.balance;

        vm.prank(stranger);
        _claim(1, 0);

        assertEq(holders[0].balance, shares[0], "the list is paid");
        assertEq(stranger.balance, before, "the caller gets nothing for the favour");
    }

    function test_an_unknown_season_cannot_be_claimed() public {
        vm.expectRevert(HoodSeasonDrop.NotOpen.selector);
        drop.claim(99, holders[0], shares[0], _proof(99, 0));
        assertFalse(drop.isClaimable(99, holders[0], shares[0], _proof(99, 0)));
    }

    function test_a_claim_after_the_deadline_reverts() public {
        _open(1, address(0));
        vm.warp(block.timestamp + WINDOW + 1);

        vm.expectRevert(HoodSeasonDrop.Expired.selector);
        _claim(1, 0);
        assertFalse(drop.isClaimable(1, holders[0], shares[0], _proof(1, 0)));
    }

    function test_the_window_has_to_be_a_month_at_the_very_least() public {
        vm.expectRevert(HoodSeasonDrop.WindowTooShort.selector);
        drop.openDrop{value: POOL}(1, _root(1), address(0), POOL, uint64(block.timestamp) + 29 days);

        vm.expectRevert(HoodSeasonDrop.WindowTooShort.selector);
        drop.openDrop{value: POOL}(1, _root(1), address(0), POOL, uint64(block.timestamp) - 1);

        drop.openDrop{value: POOL}(1, _root(1), address(0), POOL, uint64(block.timestamp) + drop.MIN_WINDOW());
    }

    function test_a_drop_has_to_be_funded_exactly() public {
        uint64 deadline = uint64(block.timestamp) + WINDOW;

        vm.expectRevert(PairTransfer.WrongValue.selector);
        drop.openDrop{value: POOL - 1}(1, _root(1), address(0), POOL, deadline);

        vm.expectRevert(PairTransfer.WrongValue.selector);
        drop.openDrop{value: POOL + 1}(1, _root(1), address(0), POOL, deadline);

        // An ERC-20 drop arrives as a transfer, so value on top of it is a mistake worth catching.
        vm.expectRevert(PairTransfer.WrongValue.selector);
        drop.openDrop{value: 1}(1, _root(1), address(usd), POOL, deadline);

        assertEq(address(drop).balance, 0, "a refused drop leaves nothing behind");
    }

    // ---------------------------------------------------------------- the sweep

    function test_a_sweep_before_the_deadline_reverts() public {
        _open(1, address(0));
        vm.expectRevert(HoodSeasonDrop.TooEarly.selector);
        drop.sweep(1);

        vm.warp(block.timestamp + WINDOW); // the deadline itself is still a claim day
        vm.expectRevert(HoodSeasonDrop.TooEarly.selector);
        drop.sweep(1);
        assertEq(treasury.balance, 0, "an open drop's funds are nobody's, not even the owner's");
    }

    function test_a_sweep_pays_the_treasury_exactly_what_nobody_claimed_and_runs_once() public {
        _open(1, address(0));
        _claim(1, 0);
        _claim(1, 2);
        uint256 taken = shares[0] + shares[2];

        vm.warp(block.timestamp + WINDOW + 1);
        drop.sweep(1);

        assertEq(treasury.balance, POOL - taken, "total minus claimed, to the wei");
        assertEq(address(drop).balance, 0);
        assertEq(drop.unclaimed(1), 0, "swept money is no longer held here");

        vm.expectRevert(HoodSeasonDrop.AlreadySwept.selector);
        drop.sweep(1);
    }

    function test_a_treasury_that_rejects_the_asset_blocks_only_the_sweep() public {
        RejectNative rejector = new RejectNative();
        drop.setTreasury(address(rejector));
        _open(1, address(0));

        _claim(1, 0); // a claim never touches the treasury, so it does not care
        assertEq(holders[0].balance, shares[0]);

        vm.warp(block.timestamp + WINDOW + 1);
        vm.expectRevert(PairTransfer.NativeTransferFailed.selector);
        drop.sweep(1);

        // The failed sweep reverted whole, so the drop is still unswept and retryable.
        drop.setTreasury(treasury);
        drop.sweep(1);
        assertEq(treasury.balance, POOL - shares[0]);
    }

    function test_only_the_owner_opens_a_drop_sweeps_it_or_moves_the_treasury() public {
        _open(1, address(0));
        vm.warp(block.timestamp + WINDOW + 1);

        vm.startPrank(stranger);
        bytes memory denied = abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger);

        vm.expectRevert(denied);
        drop.openDrop(2, keccak256("mine"), address(usd), 1, uint64(block.timestamp) + WINDOW);
        vm.expectRevert(denied);
        drop.sweep(1);
        vm.expectRevert(denied);
        drop.setTreasury(stranger);
        vm.stopPrank();
    }

    // ---------------------------------------------------------------- several seasons at once

    function test_claim_many_pays_three_seasons_at_once_and_skips_what_is_already_claimed() public {
        _open(1, address(0));
        _open(2, address(0));
        _open(3, address(0));

        // Somebody was kind and paid season 2 for them while the batch was being built.
        _claim(2, 1);
        assertEq(holders[1].balance, shares[1]);

        uint256[] memory seasons = new uint256[](3);
        uint256[] memory amounts = new uint256[](3);
        bytes32[][] memory proofs = new bytes32[][](3);
        for (uint256 s; s < 3; ++s) {
            seasons[s] = s + 1;
            amounts[s] = shares[1];
            proofs[s] = _proof(s + 1, 1);
        }

        uint256 paid = drop.claimMany(seasons, holders[1], amounts, proofs);

        assertEq(paid, shares[1] * 2, "the two seasons that were still owed, and no revert for the third");
        assertEq(holders[1].balance, shares[1] * 3);
        assertTrue(drop.claimed(1, holders[1]) && drop.claimed(2, holders[1]) && drop.claimed(3, holders[1]));
    }

    function test_claim_many_rejects_a_ragged_call() public {
        uint256[] memory seasons = new uint256[](2);
        uint256[] memory amounts = new uint256[](1);
        bytes32[][] memory proofs = new bytes32[][](2);

        vm.expectRevert(HoodSeasonDrop.LengthMismatch.selector);
        drop.claimMany(seasons, holders[0], amounts, proofs);
    }

    function test_a_season_that_adds_up_to_more_than_its_pool_stops_at_its_own_pool() public {
        // The tree is built off chain and nothing on chain can add its rows up, so the honest
        // failure is a season running dry, never a season eating the one next to it.
        uint256 short = POOL - 1 ether;
        _open(1, address(0), short);
        _open(2, address(0));

        uint256 taken;
        for (uint256 i; i < 4; ++i) {
            taken += _claim(1, i);
        }
        assertFalse(drop.isClaimable(1, holders[4], shares[4], _proof(1, 4)));

        vm.expectRevert(HoodSeasonDrop.PoolExhausted.selector);
        _claim(1, 4);

        assertEq(drop.unclaimed(2), POOL, "season two is untouched");
        assertEq(address(drop).balance, short - taken + POOL);
        _claim(2, 4);
        assertEq(holders[4].balance, shares[4], "and still pays its own list in full");
    }

    // ---------------------------------------------------------------- fuzz

    function testFuzz_a_season_never_pays_out_more_than_it_holds(uint8 who) public {
        _open(1, address(0));

        uint256 expected;
        for (uint256 i; i < holders.length; ++i) {
            if ((who >> i) & 1 == 0) continue;
            expected += _claim(1, i);
            (,,, uint256 claimedSoFar,,,) = drop.drops(1);
            assertLe(claimedSoFar, POOL, "claimed can never pass the pool");
            assertEq(claimedSoFar, expected);
            assertEq(address(drop).balance, POOL - expected, "the books match the balance");
        }
        assertEq(drop.unclaimed(1), POOL - expected);
    }

    function testFuzz_a_leaf_from_one_season_never_verifies_against_another(uint8 index, uint16 other) public {
        uint256 i = index % holders.length;
        uint256 far = uint256(other) + 2; // anything but season 1
        _open(1, address(0));
        _open(far, address(0));

        bytes32[] memory proofOne = _proof(1, i);
        assertTrue(drop.isClaimable(1, holders[i], shares[i], proofOne));
        assertFalse(drop.isClaimable(far, holders[i], shares[i], proofOne), "the season is inside the leaf");

        vm.expectRevert(HoodSeasonDrop.BadProof.selector);
        drop.claim(far, holders[i], shares[i], proofOne);

        // And the same wall in the other direction.
        vm.expectRevert(HoodSeasonDrop.BadProof.selector);
        drop.claim(1, holders[i], shares[i], _proof(far, i));
    }

    receive() external payable {}
}
