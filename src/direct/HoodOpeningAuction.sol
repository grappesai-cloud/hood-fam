// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import {DirectLaunch} from "./DirectTypes.sol";
import {PairTransfer} from "../libraries/PairTransfer.sol";
import {DirectPay} from "./lib/DirectPay.sol";
import {IHoodPot} from "../interfaces/IHoodPot.sol";
import {BagReasons} from "../bag/BagTypes.sol";

interface IPortalLaunchRow {
    function getLaunch(address token) external view returns (DirectLaunch memory);
}

/// @title HoodOpeningAuction
/// @notice The sniper auction: one shared contract, keyed by token. A launch that chose it over
///         the fair open has its first slot after the creator's block sold to the highest bidder.
/// @dev The portal registers the window at launch. Bids are in the launch's quote and each must
///      beat the last by five percent; the outbid bidder is refunded on the spot, or booked when
///      the refund cannot be delivered. The slot itself starts the block after the window ends
///      and lasts `SLOT_BLOCKS`, whether or not anyone has settled yet: the token asks
///      `mayReceive`, which reads the bid book, so the winner never has to race a settle. Settle
///      moves the money: half to the launch's pot for the holders, half to the locker as locked
///      liquidity, where `deepen` adds it to the position once the price sits inside it. No bids
///      means the pool simply opens after the window.
contract HoodOpeningAuction is ReentrancyGuard {
    using SafeERC20 for IERC20;

    /// @notice How many blocks the winner has the pool to themselves.
    uint64 public constant SLOT_BLOCKS = 20;
    /// @notice Each bid must beat the last by this much.
    uint256 public constant MIN_RAISE_BPS = 500;
    uint256 internal constant BPS = 10_000;

    struct Auction {
        address quote;
        address splitter;
        address locker;
        uint64 endBlock;
        uint256 minBid;
        address bidder;
        uint256 amount;
        bool settled;
    }

    address public immutable portal;
    mapping(address token => Auction) internal _auctions;
    /// @notice The settled winner of a token's first slot.
    mapping(address token => address) public firstSlot;
    /// @notice Refunds that could not be delivered, per asset and bidder.
    mapping(address asset => mapping(address bidder => uint256)) public refunds;

    event Registered(address indexed token, uint64 endBlock, uint256 minBid);
    event Bid(address indexed token, address indexed bidder, uint256 amount, uint64 endBlock);
    event Settled(address indexed token, address indexed winner, uint256 amount, uint256 toHolders, uint256 toLiquidity);
    event RefundBooked(address indexed asset, address indexed bidder, uint256 amount);
    event RefundClaimed(address indexed asset, address indexed bidder, uint256 amount);

    error NotPortal();
    error AlreadyRegistered();
    error NotRegistered();
    error WindowClosed();
    error WindowOpen();
    error BidTooLow();
    error AlreadySettled();
    error Nothing();

    constructor(address portal_) {
        portal = portal_;
    }

    receive() external payable {}

    // ---------------------------------------------------------------- portal

    /// @notice Portal only, at launch. The quote, splitter and locker are read off the launch row.
    function register(address token, uint64 endBlock, uint256 minBid) external {
        if (msg.sender != portal) revert NotPortal();
        Auction storage a = _auctions[token];
        if (a.endBlock != 0) revert AlreadyRegistered();
        DirectLaunch memory l = IPortalLaunchRow(portal).getLaunch(token);
        a.quote = l.quote;
        a.splitter = l.splitter;
        a.locker = l.locker;
        a.endBlock = endBlock;
        a.minBid = minBid;
        emit Registered(token, endBlock, minBid);
    }

    // ---------------------------------------------------------------- bidding

    /// @notice Bid `amount` of the launch's quote for the first slot. Native quote: send it as
    ///         value; ERC-20 quote: approve it first. Must be at least the minimum and five percent
    ///         over the standing bid; the standing bidder gets their money back.
    function bid(address token, uint256 amount) external payable nonReentrant {
        Auction storage a = _auctions[token];
        if (a.endBlock == 0) revert NotRegistered();
        if (block.number > a.endBlock) revert WindowClosed();
        uint256 floor = a.bidder == address(0) ? a.minBid : a.amount + (a.amount * MIN_RAISE_BPS) / BPS;
        if (amount == 0 || amount < floor) revert BidTooLow();
        PairTransfer.pull(a.quote, msg.sender, amount, msg.value);

        address previous = a.bidder;
        uint256 previousAmount = a.amount;
        a.bidder = msg.sender;
        a.amount = amount;
        if (previous != address(0)) _refund(a.quote, previous, previousAmount);
        emit Bid(token, msg.sender, amount, a.endBlock);
    }

    /// @dev A refund that cannot be delivered is booked, never lost, and never blocks the next bid.
    function _refund(address asset, address to, uint256 amount) internal {
        bool ok;
        if (asset == address(0)) {
            (ok,) = to.call{value: amount, gas: 60_000}("");
        } else {
            ok = IERC20(asset).trySafeTransfer(to, amount);
        }
        if (!ok) {
            refunds[asset][to] += amount;
            emit RefundBooked(asset, to, amount);
        }
    }

    /// @notice Takes a booked refund.
    function claimRefund(address asset) external nonReentrant returns (uint256 amount) {
        amount = refunds[asset][msg.sender];
        if (amount == 0) revert Nothing();
        refunds[asset][msg.sender] = 0;
        PairTransfer.push(asset, msg.sender, amount);
        emit RefundClaimed(asset, msg.sender, amount);
    }

    // ---------------------------------------------------------------- settling

    /// @notice Permissionless once the window has closed. Names the winner and splits the bid:
    ///         half to the holders through the launch's pot, half to the locker as liquidity.
    function settle(address token) external nonReentrant {
        Auction storage a = _auctions[token];
        if (a.endBlock == 0) revert NotRegistered();
        if (block.number <= a.endBlock) revert WindowOpen();
        if (a.settled) revert AlreadySettled();
        a.settled = true;
        address winner = a.bidder;
        uint256 amount = a.amount;
        if (winner == address(0)) {
            emit Settled(token, address(0), 0, 0, 0);
            return;
        }
        firstSlot[token] = winner;
        uint256 toHolders = amount / 2;
        uint256 toLiquidity = amount - toHolders;
        DirectPay.payWithCall(
            a.quote, a.splitter, toHolders, abi.encodeCall(IHoodPot.depositForHolders, (toHolders, BagReasons.AUCTION, winner))
        );
        PairTransfer.push(a.quote, a.locker, toLiquidity);
        emit Settled(token, winner, amount, toHolders, toLiquidity);
    }

    // ---------------------------------------------------------------- views

    /// @notice Whether `to` may receive tokens out of the pool right now. Read by the token.
    function mayReceive(address token, address to) external view returns (bool) {
        Auction storage a = _auctions[token];
        uint64 endBlock = a.endBlock;
        if (endBlock == 0) return true;
        if (block.number <= endBlock) return false;
        address winner = a.bidder;
        if (winner == address(0)) return true;
        if (block.number <= endBlock + SLOT_BLOCKS) return to == winner;
        return true;
    }

    function auctionOf(address token) external view returns (Auction memory) {
        return _auctions[token];
    }

    /// @notice The lowest bid that would stand right now.
    function minimumBid(address token) external view returns (uint256) {
        Auction storage a = _auctions[token];
        return a.bidder == address(0) ? a.minBid : a.amount + (a.amount * MIN_RAISE_BPS) / BPS;
    }
}
