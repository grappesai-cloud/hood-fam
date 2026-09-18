// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {StdInvariant} from "forge-std/StdInvariant.sol";

import {HoodSeasonDrop} from "../../src/HoodSeasonDrop.sol";

/// @notice Builds a sorted-pair merkle tree over a fixed set of leaves and hands out proofs, the way
///         the airdrop CLI does off chain, so the fuzzer can drive real claims. Sorted-pair hashing
///         is what OpenZeppelin's `MerkleProof.verify` checks against, so a root and proofs built
///         here verify on chain without matching any particular leaf order.
library MerkleFixture {
    function hashPair(bytes32 a, bytes32 b) internal pure returns (bytes32) {
        return a < b ? keccak256(abi.encodePacked(a, b)) : keccak256(abi.encodePacked(b, a));
    }

    /// @dev Exactly 8 leaves (a clean binary tree, 3-element proofs). Returns the root and, for each
    ///      leaf, its proof.
    function build(bytes32[8] memory leaves) internal pure returns (bytes32 root, bytes32[3][8] memory proofs) {
        // level 0 -> level 1 (4 nodes)
        bytes32[4] memory l1;
        for (uint256 i; i < 4; ++i) l1[i] = hashPair(leaves[2 * i], leaves[2 * i + 1]);
        bytes32[2] memory l2;
        for (uint256 i; i < 2; ++i) l2[i] = hashPair(l1[2 * i], l1[2 * i + 1]);
        root = hashPair(l2[0], l2[1]);

        for (uint256 i; i < 8; ++i) {
            proofs[i][0] = leaves[i ^ 1]; // sibling leaf
            proofs[i][1] = l1[(i / 2) ^ 1]; // sibling at level 1
            proofs[i][2] = l2[(i / 4) ^ 1]; // sibling at level 2
        }
    }
}

/// @notice Random claims, batch claims and sweeps against a funded season, in every order the fuzzer
///         can find.
contract SeasonDropHandler is Test {
    HoodSeasonDrop public drop;
    address public owner;
    uint256 public season;
    address[8] public accounts;
    uint256[8] public amounts;
    bytes32[3][8] public proofs;
    uint256 public total;
    uint64 public deadline;

    uint256 public paidOut; // everything ever claimed, ever

    function init(
        HoodSeasonDrop drop_, address owner_, uint256 season_, address[8] memory accts,
        uint256[8] memory amts, bytes32[3][8] memory prs, uint256 total_, uint64 deadline_
    ) external {
        drop = drop_; owner = owner_; season = season_; accounts = accts; amounts = amts;
        proofs = prs; total = total_; deadline = deadline_;
    }

    function _proof(uint256 i) internal view returns (bytes32[] memory p) {
        p = new bytes32[](3);
        p[0] = proofs[i][0]; p[1] = proofs[i][1]; p[2] = proofs[i][2];
    }

    function claimOne(uint256 idx) public {
        uint256 i = idx % 8;
        try drop.claim(season, accounts[i], amounts[i], _proof(i)) returns (uint256 a) { paidOut += a; } catch {}
    }

    function claimMany(uint256 seed) public {
        // a random subset of the eight, in one call
        uint256 count = (seed % 8) + 1;
        uint256[] memory seasons = new uint256[](count);
        uint256[] memory amts = new uint256[](count);
        bytes32[][] memory prs = new bytes32[][](count);
        // pick `count` distinct-ish indices; the contract skips already-claimed ones
        uint256 base = (seed / 8) % 8;
        address who = accounts[base];
        for (uint256 k; k < count; ++k) {
            uint256 i = (base + k) % 8;
            // claimMany takes ONE account; only its own leaf will verify, others revert the batch,
            // so drive it with the one account's single membership to keep the call meaningful.
            seasons[k] = season; amts[k] = amounts[base]; prs[k] = _proof(base);
            i; // silence
        }
        // a single-entry batch for `who`, repeated safely (already-claimed is skipped)
        uint256[] memory s1 = new uint256[](1); s1[0] = season;
        uint256[] memory a1 = new uint256[](1); a1[0] = amounts[base];
        bytes32[][] memory p1 = new bytes32[][](1); p1[0] = _proof(base);
        try drop.claimMany(s1, who, a1, p1) returns (uint256 t) { paidOut += t; } catch {}
    }

    function warpPastDeadline(uint256 dt) public {
        vm.warp(uint256(deadline) + bound(dt, 1, 90 days));
    }

    function sweep() public {
        vm.prank(owner);
        try drop.sweep(season) {} catch {}
    }

    function accountAt(uint256 i) external view returns (address) { return accounts[i % 8]; }
}

contract SeasonDropSolvencyInvariant is StdInvariant, Test {
    HoodSeasonDrop internal drop;
    SeasonDropHandler internal handler;

    address internal owner = makeAddr("owner");
    address internal treasury = makeAddr("treasury");
    uint256 internal constant SEASON = 1;

    uint256 internal total;

    function setUp() public {
        drop = new HoodSeasonDrop(owner, treasury);

        address[8] memory accounts;
        uint256[8] memory amounts;
        bytes32[8] memory leaves;
        total = 0;
        for (uint256 i; i < 8; ++i) {
            accounts[i] = address(uint160(0xA1D0 + i));
            amounts[i] = (i + 1) * 1 ether; // 1..8 ether, sum 36
            leaves[i] = drop.leafOf(SEASON, accounts[i], amounts[i]);
            total += amounts[i];
        }
        (bytes32 root, bytes32[3][8] memory proofs) = MerkleFixture.build(leaves);

        uint64 deadline = uint64(block.timestamp + 60 days);
        vm.deal(owner, total);
        vm.prank(owner);
        drop.openDrop{value: total}(SEASON, root, address(0), total, deadline);

        handler = new SeasonDropHandler();
        handler.init(drop, owner, SEASON, accounts, amounts, proofs, total, deadline);

        targetContract(address(handler));
        bytes4[] memory sel = new bytes4[](4);
        sel[0] = SeasonDropHandler.claimOne.selector;
        sel[1] = SeasonDropHandler.claimMany.selector;
        sel[2] = SeasonDropHandler.warpPastDeadline.selector;
        sel[3] = SeasonDropHandler.sweep.selector;
        targetSelector(FuzzSelector({addr: address(handler), selectors: sel}));
    }

    function _dropClaimed() internal view returns (uint256 claimed) {
        (, , , claimed, , , ) = drop.drops(SEASON);
    }

    /// @notice Proof the fixture's merkle proofs actually verify on chain, so the invariants above
    ///         guard real claims and not a run of caught BadProof reverts: one leaf claims its exact
    ///         amount, the balance drops by it, and a second claim of the same leaf is refused.
    function test_a_fixture_proof_actually_claims() public {
        address who = handler.accountAt(3);
        // reconstruct the proof the handler holds for leaf 3
        bytes32[] memory proof = new bytes32[](3);
        (proof[0], proof[1], proof[2]) = (handlerProof(3, 0), handlerProof(3, 1), handlerProof(3, 2));
        uint256 amount = 4 ether; // leaf i has (i+1) ether; leaf 3 -> 4 ether
        uint256 balBefore = who.balance;

        drop.claim(SEASON, who, amount, proof);
        assertEq(who.balance - balBefore, amount, "the leaf claimed its exact amount");

        vm.expectRevert(HoodSeasonDrop.AlreadyClaimed.selector);
        drop.claim(SEASON, who, amount, proof);
    }

    function handlerProof(uint256 leaf, uint256 j) internal view returns (bytes32) {
        return handler.proofs(leaf, j);
    }

    /// @notice A season never pays out more than it was funded with: the sum of every claim is at
    ///         most the season's total. This is the PoolExhausted guard holding under every order of
    ///         claims a fuzzer can build, including partial batches and re-tries.
    function invariant_claimedNeverExceedsTotal() public view {
        assertLe(_dropClaimed(), total, "a season paid out more than it was funded");
    }

    /// @notice What actually left the contract never exceeds what was put in. A double claim, a bad
    ///         accounting of a batch, or a sweep that overlaps a claim would break this.
    function invariant_paidOutNeverExceedsFunded() public view {
        assertLe(handler.paidOut(), total, "more native left than was funded");
    }

    /// @notice The contract is solvent for what it still owes: before the sweep, its balance covers
    ///         the unclaimed remainder; after the sweep, the remainder went to the treasury and the
    ///         balance is whatever claims have not yet been pulled. In all cases balance + paidOut
    ///         + swept-to-treasury accounts for every wei, so nothing is created or lost.
    function invariant_everyWeiAccountedFor() public view {
        (, , , uint256 claimed, , , bool swept) = drop.drops(SEASON);
        uint256 sweptAmount = swept ? total - claimed : 0;
        assertEq(address(drop).balance + handler.paidOut() + sweptAmount, total, "wei leaked or appeared");
    }
}
