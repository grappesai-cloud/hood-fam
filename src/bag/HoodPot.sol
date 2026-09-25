// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

import {PairTransfer} from "../libraries/PairTransfer.sol";
import {IHoodPot} from "../interfaces/IHoodPot.sol";
import {IHoodFactory} from "../interfaces/IHoodFactory.sol";

/// @title HoodPot
/// @notice A curve launch's pot: every deposit is booked for the token's holders pro rata to
///         balance, in the token's quote, and paid out by a keeper or by anyone on the holder's
///         behalf. One per launch, deployed by the factory.
/// @dev The same per-share accumulator as the direct machine's splitter. The token reports every
///      balance move through `syncBalances`; the curve, the graduator and the pool are excluded
///      by the factory (or the graduation handler) so they never earn. A deposit that lands while
///      nobody eligible holds anything is orphaned and folded into the accumulator on the next
///      sync that finds an eligible supply.
contract HoodPot is IHoodPot, ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint256 internal constant ACC = 1e27;
    /// @dev Gas forwarded to a holder on a keeper push. Enough for a Safe, not enough to grief
    ///      the batch.
    uint256 internal constant PUSH_GAS = 50_000;

    address public immutable factory;
    address public immutable token;
    /// @notice address(0) when the launch is quoted in the chain's own currency.
    address public immutable asset;

    uint256 public accPerShare;
    uint256 public eligibleSupply;
    /// @notice Deposits that arrived while nobody eligible held any. Credited on the next sync.
    uint256 public orphaned;
    uint256 public totalDeposited;
    uint256 public totalPaid;
    mapping(address account => uint256) public trackedBalance;
    mapping(address account => uint256) public debt;
    mapping(address account => uint256) public claimable;
    mapping(address account => bool) public excluded;

    event Excluded(address indexed who);
    event PushSkipped(address indexed account, uint256 amount);

    error NotToken();
    error NotFactory();
    error WrongValue();
    error Nothing();
    error UnexpectedPayout();

    constructor(address factory_, address token_, address asset_) {
        factory = factory_;
        token = token_;
        asset = asset_;
    }

    // ---------------------------------------------------------------- bookkeeping

    /// @notice Marks an address as holding no share: the curve, the graduator, the pool.
    /// @dev Factory or graduation handler only. Whatever the account earned up to now stays
    ///      claimable; from here on it earns nothing.
    function exclude(address who) external {
        if (msg.sender != factory && msg.sender != IHoodFactory(factory).graduationHandler()) revert NotFactory();
        _settle(who, 0);
        excluded[who] = true;
        emit Excluded(who);
    }

    /// @notice Called by the token whenever a balance moves, with the balances after the move.
    ///         Bookkeeping only; it never reverts a transfer.
    function syncBalances(address from, address to, uint256 fromBalance, uint256 toBalance) external {
        if (msg.sender != token) revert NotToken();
        if (from != address(0)) _settle(from, fromBalance);
        if (to != address(0)) _settle(to, toBalance);
        if (orphaned != 0 && eligibleSupply != 0) {
            uint256 amount = orphaned;
            orphaned = 0;
            accPerShare += Math.mulDiv(amount, ACC, eligibleSupply);
        }
    }

    function _settle(address account, uint256 newBalance) internal {
        if (excluded[account]) return;
        uint256 tracked = trackedBalance[account];
        if (tracked != 0) {
            uint256 total = Math.mulDiv(tracked, accPerShare, ACC);
            uint256 owed = debt[account];
            if (total > owed) claimable[account] += total - owed;
        }
        eligibleSupply = eligibleSupply + newBalance - tracked;
        trackedBalance[account] = newBalance;
        debt[account] = Math.mulDiv(newBalance, accPerShare, ACC);
    }

    // ---------------------------------------------------------------- money in

    /// @inheritdoc IHoodPot
    function depositForHolders(uint256 amount, bytes32 reason, address payer) external payable {
        if (amount == 0) {
            if (msg.value != 0) revert WrongValue();
            return;
        }
        PairTransfer.pull(asset, msg.sender, amount, msg.value);
        totalDeposited += amount;
        uint256 supply = eligibleSupply;
        if (supply == 0) {
            orphaned += amount;
        } else {
            accPerShare += Math.mulDiv(amount, ACC, supply);
        }
        emit HoldersPaid(reason, payer, amount, supply);
    }

    // ---------------------------------------------------------------- money out

    /// @inheritdoc IHoodPot
    function pending(address account) external view returns (uint256) {
        uint256 tracked = trackedBalance[account];
        uint256 total = Math.mulDiv(tracked, accPerShare, ACC);
        uint256 owed = debt[account];
        return claimable[account] + (total > owed ? total - owed : 0);
    }

    /// @inheritdoc IHoodPot
    function claim(address account) external nonReentrant returns (uint256 amount) {
        _settle(account, trackedBalance[account]);
        amount = claimable[account];
        if (amount == 0) revert Nothing();
        claimable[account] = 0;
        totalPaid += amount;
        PairTransfer.push(asset, account, amount);
        emit Pushed(account, amount);
    }

    /// @inheritdoc IHoodPot
    /// @dev A holder that refuses the push (a contract that reverts on receive, a blocklisted
    ///      wallet) is skipped with its pending amount untouched, so one wallet never blocks
    ///      the batch.
    function pushMany(address[] calldata accounts, uint256 floor)
        external
        nonReentrant
        returns (uint256 paid, uint256 count)
    {
        for (uint256 i; i < accounts.length; ++i) {
            address account = accounts[i];
            _settle(account, trackedBalance[account]);
            uint256 amount = claimable[account];
            if (amount == 0 || amount < floor) continue;
            claimable[account] = 0;
            if (_tryPush(account, amount)) {
                paid += amount;
                ++count;
                totalPaid += amount;
                emit Pushed(account, amount);
            } else {
                claimable[account] = amount;
                emit PushSkipped(account, amount);
            }
        }
    }

    function _tryPush(address to, uint256 amount) internal returns (bool ok) {
        if (asset == address(0)) {
            (ok,) = to.call{value: amount, gas: PUSH_GAS}("");
        } else {
            uint256 before = IERC20(asset).balanceOf(address(this));
            IERC20(asset).trySafeTransfer(to, amount);
            uint256 spent = before - IERC20(asset).balanceOf(address(this));
            if (spent != 0 && spent != amount) revert UnexpectedPayout();
            ok = spent == amount;
        }
    }
}
