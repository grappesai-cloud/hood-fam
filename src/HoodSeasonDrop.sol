// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {MerkleProof} from "@openzeppelin/contracts/utils/cryptography/MerkleProof.sol";

import {PairTransfer} from "./libraries/PairTransfer.sol";

/// @title HoodSeasonDrop
/// @notice The claim side of a season of points. A season ends, the protocol works out who earned
///         what from money it already collected, publishes one merkle root, and everybody on that
///         list takes their share whenever they get around to it.
/// @dev One contract serves every season, keyed by season number. A drop is funded in the same call
///      that opens it, so a published root is always backed by money that is already here: there is
///      no promise, no vesting and no second transaction that could fail to arrive.
///
///      What the owner deliberately cannot do: change a season's root once it is written, take an
///      open drop's funds, or stop a claim before the deadline. The only owner powers are opening a
///      new season's drop, sweeping what nobody claimed once the deadline has passed, and moving
///      where a sweep lands. Claiming itself has no owner: it is permissionless and always pays the
///      account on the list, never the caller.
///
///      Nothing checks that a season's rows add up to what the drop was funded with, because the
///      tree is off chain, so each season is capped at its own total: a bad list runs out at its own
///      pool rather than reaching into another season's money.
///
///      Funds sent here outside `openDrop` are not recoverable, and that is the price of the
///      guarantee above: a rescue hatch is a hatch over every open drop's money.
contract HoodSeasonDrop is Ownable2Step, ReentrancyGuard {
    /// @notice The shortest a claim window may be. A season's list is published once and people
    ///         show up late, so a month is the floor rather than the owner's choice.
    uint64 public constant MIN_WINDOW = 30 days;

    struct Drop {
        bytes32 root;
        /// @notice address(0) means the drop pays in the chain's own currency.
        address asset;
        uint256 total;
        uint256 claimed;
        uint64 opensAt;
        uint64 deadline;
        bool swept;
    }

    mapping(uint256 season => Drop) public drops;
    mapping(uint256 season => mapping(address account => bool)) public claimed;

    /// @notice Where a sweep lands. It never touches an open drop's funds.
    address public treasury;

    event DropOpened(uint256 indexed season, bytes32 root, address asset, uint256 total, uint64 deadline);
    event Claimed(uint256 indexed season, address indexed account, uint256 amount);
    event Swept(uint256 indexed season, address indexed to, uint256 amount);
    event TreasurySet(address indexed treasury);

    error AlreadyClaimed();
    error BadProof();
    error NotOpen();
    error Expired();
    error AlreadyOpen();
    error AlreadySwept();
    error BadRoot();
    error ZeroAmount();
    error ZeroAddress();
    error WindowTooShort();
    error TooEarly();
    error LengthMismatch();
    error PoolExhausted();

    constructor(address owner_, address treasury_) Ownable(owner_) {
        if (treasury_ == address(0)) revert ZeroAddress();
        treasury = treasury_;
    }

    // ---------------------------------------------------------------- the leaf

    /// @notice The leaf a season's tree is built from.
    /// @dev keccak256(bytes.concat(keccak256(abi.encode(season, account, amount)))), the OpenZeppelin
    ///      double-hash convention. This is exactly what OpenZeppelin's merkle-tree package produces
    ///      from `StandardMerkleTree.of(rows, ["uint256", "address", "uint256"])`, and the CLI that
    ///      builds the tree off chain has to match it leaf for leaf. Verified with sorted-pair
    ///      hashing, which is that library's default.
    function leafOf(uint256 season, address account, uint256 amount) public pure returns (bytes32) {
        return keccak256(bytes.concat(keccak256(abi.encode(season, account, amount))));
    }

    // ---------------------------------------------------------------- opening a season

    /// @notice Publishes a season's list and funds it in the same call.
    /// @dev A season's root is written once and never again, so nobody has to watch this contract
    ///      between the publication and their claim.
    function openDrop(uint256 season, bytes32 root, address asset, uint256 total, uint64 deadline)
        external
        payable
        onlyOwner
    {
        Drop storage d = drops[season];
        if (d.root != bytes32(0)) revert AlreadyOpen();
        if (root == bytes32(0)) revert BadRoot();
        if (total == 0) revert ZeroAmount();
        if (deadline < block.timestamp + MIN_WINDOW) revert WindowTooShort();

        // The same rule as everywhere else in the repo: native must arrive as value, an ERC-20 must
        // arrive as a transfer and carry no value, and an asset that skims the transfer is refused
        // rather than left to shortchange the last claimer.
        PairTransfer.pull(asset, msg.sender, total, msg.value);

        d.root = root;
        d.asset = asset;
        d.total = total;
        d.opensAt = uint64(block.timestamp);
        d.deadline = deadline;

        emit DropOpened(season, root, asset, total, deadline);
    }

    // ---------------------------------------------------------------- claiming

    /// @notice Permissionless, and it always pays `account`, never the caller.
    /// @dev So a keeper can pay a whole season's list, and if the keeper stops, anybody can.
    function claim(uint256 season, address account, uint256 amount, bytes32[] calldata proof)
        external
        nonReentrant
        returns (uint256)
    {
        return _claim(season, account, amount, proof, false);
    }

    /// @notice One transaction for somebody who let several seasons pile up.
    /// @dev A season already claimed is skipped rather than reverting the batch: anybody may have
    ///      claimed it for this account between the call being built and mined, and losing the other
    ///      seasons to that race would be absurd. A bad proof or a dead season still reverts, since
    ///      that is a mistake in the call and not a race.
    function claimMany(
        uint256[] calldata seasons,
        address account,
        uint256[] calldata amounts,
        bytes32[][] calldata proofs
    ) external nonReentrant returns (uint256 total) {
        uint256 n = seasons.length;
        if (amounts.length != n || proofs.length != n) revert LengthMismatch();
        for (uint256 i; i < n; ++i) {
            total += _claim(seasons[i], account, amounts[i], proofs[i], true);
        }
    }

    function _claim(uint256 season, address account, uint256 amount, bytes32[] calldata proof, bool skipClaimed)
        internal
        returns (uint256)
    {
        Drop storage d = drops[season];
        if (d.root == bytes32(0)) revert NotOpen();
        if (block.timestamp > d.deadline) revert Expired();
        if (claimed[season][account]) {
            if (skipClaimed) return 0;
            revert AlreadyClaimed();
        }
        if (!MerkleProof.verify(proof, d.root, leafOf(season, account, amount))) revert BadProof();
        // Every season shares this contract's balance, so each one is capped at what it was funded
        // with. A list that adds up to more than its pool runs out at its own total instead of
        // reaching into the next season's money.
        if (d.claimed + amount > d.total) revert PoolExhausted();

        claimed[season][account] = true;
        d.claimed += amount;
        PairTransfer.push(d.asset, account, amount);

        emit Claimed(season, account, amount);
        return amount;
    }

    // ---------------------------------------------------------------- after the deadline

    /// @notice Sends what nobody claimed to the treasury, once, and only once the window is over.
    /// @dev A treasury that cannot take the asset makes this revert whole, which leaves the drop
    ///      unswept and retryable after `setTreasury`. It never blocks a claim, because a claim
    ///      never touches the treasury.
    function sweep(uint256 season) external onlyOwner nonReentrant {
        Drop storage d = drops[season];
        if (d.root == bytes32(0)) revert NotOpen();
        if (block.timestamp <= d.deadline) revert TooEarly();
        if (d.swept) revert AlreadySwept();

        d.swept = true;
        uint256 amount = d.total - d.claimed;
        PairTransfer.push(d.asset, treasury, amount);
        emit Swept(season, treasury, amount);
    }

    function setTreasury(address treasury_) external onlyOwner {
        if (treasury_ == address(0)) revert ZeroAddress();
        treasury = treasury_;
        emit TreasurySet(treasury_);
    }

    // ---------------------------------------------------------------- views

    /// @notice What is still held here for a season. Zero once it has been swept.
    function unclaimed(uint256 season) external view returns (uint256) {
        Drop storage d = drops[season];
        if (d.swept) return 0;
        return d.total - d.claimed;
    }

    /// @notice Whether this exact row would pay right now, for a front end that would rather not
    ///         hand somebody a transaction that reverts.
    function isClaimable(uint256 season, address account, uint256 amount, bytes32[] calldata proof)
        external
        view
        returns (bool)
    {
        Drop storage d = drops[season];
        if (d.root == bytes32(0)) return false;
        if (block.timestamp > d.deadline) return false;
        if (claimed[season][account]) return false;
        if (d.claimed + amount > d.total) return false;
        return MerkleProof.verify(proof, d.root, leafOf(season, account, amount));
    }
}
