// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import {IHoodTokenLock} from "./interfaces/IHoodTokenLock.sol";

/// @title HoodTokenLock
/// @notice A creator's first buy, held where everyone can see it and nobody can move it.
/// @dev The staking vault used to do this, back when a launch's own token could be staked. It
///      cannot any more: locking is for the house coin, so a creator who wants to prove they are
///      not about to sell into their own buyers needs a place to put the tokens that pays nothing
///      and gives nothing back early. This is that place, and it is deliberately dumb: no owner,
///      no rewards, no rescue, no way to shorten a lock, no way for anybody but the beneficiary to
///      take the tokens out once the time has passed.
contract HoodTokenLock is IHoodTokenLock, ReentrancyGuard {
    using SafeERC20 for IERC20;

    struct Lock {
        address token;
        address owner;
        uint128 amount;
        uint64 unlockAt;
    }

    mapping(uint256 id => Lock) public locks;
    /// @notice How much of a token is held here, across every lock.
    mapping(address token => uint256) public held;
    uint256 public nextLockId = 1;

    event Locked(uint256 indexed id, address indexed token, address indexed owner, uint256 amount, uint64 unlockAt);
    event Withdrawn(uint256 indexed id, uint256 amount);

    error ZeroAmount();
    error AmountTooLarge();
    error NotATier();
    error NotOwner();
    error StillLocked();
    error NoLock();

    /// @inheritdoc IHoodTokenLock
    function isTier(uint64 lockDuration) public pure returns (bool) {
        return lockDuration == 7 days || lockDuration == 30 days || lockDuration == 90 days || lockDuration == 180 days;
    }

    /// @inheritdoc IHoodTokenLock
    function lockFor(address token, address beneficiary, uint256 amount, uint64 lockDuration)
        external
        nonReentrant
        returns (uint256 id)
    {
        if (beneficiary == address(0)) revert NotOwner();
        if (amount == 0) revert ZeroAmount();
        if (amount > type(uint128).max) revert AmountTooLarge();
        if (!isTier(lockDuration)) revert NotATier();

        // Measured, not assumed: a token that takes a cut on transfer locks what arrived, not what
        // was asked for, and the holder is told the true number in the event.
        uint256 before = IERC20(token).balanceOf(address(this));
        IERC20(token).safeTransferFrom(msg.sender, address(this), amount);
        uint256 received = IERC20(token).balanceOf(address(this)) - before;
        if (received == 0) revert ZeroAmount();

        uint64 unlockAt = uint64(block.timestamp) + lockDuration;
        id = nextLockId++;
        locks[id] = Lock({token: token, owner: beneficiary, amount: uint128(received), unlockAt: unlockAt});
        held[token] += received;
        emit Locked(id, token, beneficiary, received, unlockAt);
    }

    /// @inheritdoc IHoodTokenLock
    function withdraw(uint256 id) external nonReentrant returns (uint256 amount) {
        Lock memory l = locks[id];
        if (l.owner == address(0)) revert NoLock();
        if (l.owner != msg.sender) revert NotOwner();
        if (block.timestamp < l.unlockAt) revert StillLocked();

        amount = l.amount;
        delete locks[id];
        held[l.token] -= amount;
        IERC20(l.token).safeTransfer(l.owner, amount);
        emit Withdrawn(id, amount);
    }
}
