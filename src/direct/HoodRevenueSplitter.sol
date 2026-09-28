// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import {Allocations} from "./DirectTypes.sol";
import {PairTransfer} from "../libraries/PairTransfer.sol";
import {DirectPay} from "./lib/DirectPay.sol";
import {ReferralLeg} from "../libraries/ReferralLeg.sol";
import {IHoodPot} from "../interfaces/IHoodPot.sol";
import {IHoodBag} from "../interfaces/IHoodBag.sol";
import {BagReasons} from "../bag/BagTypes.sol";

/// @dev What this contract reads off the portal: where a legacy protocol claim goes and which
///      address is the Bag. The referral registry pointer is read through ReferralLeg.
interface IPortalTreasury {
    function treasury() external view returns (address);
    function bag() external view returns (address);
}

/// @title HoodRevenueSplitter
/// @notice Every unit of tax a launch collects lands here and leaves along four fixed roads. It is
///         also the launch's pot: the per-share accumulator that pays holders in the quote.
/// @dev The creator's tax is all the creator's (`PROTOCOL_BPS` is zero; the platform's fee goes to
///      the Bag from the hook). It is split between four destinations they chose at launch and
///      can never change: their own claimable balance, a buyback pot, a dividend accumulator for
///      holders, and the locked liquidity.
///
///      It does not matter how tax arrives, and nothing has to call in to announce it. `sweep`
///      looks at what the contract holds, subtracts what is already spoken for, and splits the
///      difference. Money for the pot is different: it is announced (`depositForHolders`), tagged
///      with a reason and a payer, and goes to holders whole.
///
///      Dividends sit on a per-share accumulator. The token tells this contract when a balance
///      moves; the pool, the locker, the hook and this contract itself hold no share. A keeper
///      pushes payouts (`pushMany`); `claim` is the fallback anyone can call for anyone.
///
///      Two more rules live here. The creator cannot rug their fees: a sell of their own token
///      moves whatever they had not claimed to the holders (`slashCreator`, called by the token).
///      The house coin:
///      when the fee recipient is the Bag itself, the creator's leg goes into the Bag as the
///      house-coin leg, and anyone may send it.
contract HoodRevenueSplitter is ReentrancyGuard, IHoodPot {
    using SafeERC20 for IERC20;

    uint256 internal constant BPS = 10_000;
    uint256 internal constant ACC = 1e27;
    /// @notice The protocol's cut of the creator's tax: none. The platform fee is the Bag's and
    ///         comes off the trade in the hook. Kept so `claimProtocol` still pays what was booked.
    uint16 public constant PROTOCOL_BPS = 0;
    /// @notice Gas a pushed native payout may burn. A holder that needs more claims by hand.
    uint256 internal constant PUSH_GAS = 60_000;

    address public immutable portal;
    address public immutable treasury;
    address public immutable buybackModule;
    address public immutable token;
    /// @notice address(0) means the launch is quoted in the chain's own currency.
    address public immutable quote;
    address public creator;
    address public locker;
    address public hook;
    Allocations public allocations;

    /// @notice Owed to the creator, withdrawable whenever they want.
    uint256 public creatorClaimable;
    /// @notice Waiting for somebody to run the buyback.
    uint256 public buybackPot;
    /// @notice Waiting to be pushed into the locked position.
    uint256 public liquidityPot;
    /// @notice Distributed to holders and not yet claimed.
    uint256 public dividendsHeld;
    /// @notice Dividends that arrived while nobody eligible held any. Credited to the first who does.
    uint256 public dividendsOrphaned;
    /// @notice A legacy protocol cut, waiting to be pulled. Nothing new is ever booked here.
    uint256 public protocolClaimable;

    uint256 public accPerShare;
    uint256 public eligibleSupply;
    mapping(address => uint256) public trackedBalance;
    mapping(address => uint256) public dividendDebt;
    mapping(address => uint256) public dividendClaimable;
    mapping(address => bool) public excluded;

    /// @notice Everything ever booked for holders, and everything ever paid out to them.
    uint256 public totalDeposited;
    uint256 public totalPaid;

    /// @dev Everything the buckets own. Anything above it is new tax.
    uint256 public accounted;

    event Swept(uint256 total, uint256 protocol, uint256 creator, uint256 buyback, uint256 dividends, uint256 liquidity);
    event CreatorClaimed(address indexed to, uint256 amount);
    event DividendsClaimed(address indexed holder, uint256 amount);
    event BuybackReleased(uint256 amount);
    event LiquidityPushed(uint256 amount);
    event ProtocolClaimed(address indexed to, uint256 amount);
    event ReferralPaid(address indexed to, uint256 amount);
    event CreatorSlashed(address indexed creator, uint256 amount);

    error NotPortal();
    error NotCreator();
    error NotBuybackModule();
    error NotToken();
    error AlreadyInitialized();
    error BadAllocations();
    error Nothing();

    constructor(address portal_, address treasury_, address buybackModule_, address token_, address quote_) {
        portal = portal_;
        treasury = treasury_;
        buybackModule = buybackModule_;
        token = token_;
        quote = quote_;
    }

    receive() external payable {}

    function initialize(address creator_, address locker_, Allocations calldata a) external {
        if (msg.sender != portal) revert NotPortal();
        if (creator != address(0)) revert AlreadyInitialized();
        if (uint256(a.creatorBps) + a.buybackBps + a.dividendsBps + a.liquidityBps != BPS) revert BadAllocations();
        creator = creator_;
        locker = locker_;
        allocations = a;
        excluded[address(this)] = true;
        excluded[locker_] = true;
        excluded[portal] = true;
        excluded[buybackModule] = true;
    }

    /// @notice Names the launch's hook, once. It holds no dividend share.
    function setHook(address hook_) external {
        if (msg.sender != portal) revert NotPortal();
        if (hook != address(0)) revert AlreadyInitialized();
        hook = hook_;
        _settle(hook_, 0);
        excluded[hook_] = true;
    }

    /// @notice Marks an address as holding no dividend share: the pool, the hook, the locker.
    function exclude(address who) external {
        if (msg.sender != portal) revert NotPortal();
        _settle(who, 0);
        excluded[who] = true;
    }

    /// @inheritdoc IHoodPot
    function asset() external view returns (address) {
        return quote;
    }

    // ---------------------------------------------------------------- the split

    /// @notice Permissionless. Splits whatever tax arrived since the last call.
    function sweep() public {
        uint256 unaccounted = _balance() - accounted;
        if (unaccounted == 0) return;

        Allocations memory a = allocations;
        uint256 toCreator = (unaccounted * a.creatorBps) / BPS;
        uint256 toBuyback = (unaccounted * a.buybackBps) / BPS;
        uint256 toDividends = (unaccounted * a.dividendsBps) / BPS;
        uint256 toLiquidity = unaccounted - toCreator - toBuyback - toDividends;

        creatorClaimable += toCreator;
        buybackPot += toBuyback;
        liquidityPot += toLiquidity;
        accounted += unaccounted;
        if (toDividends != 0) {
            _distribute(toDividends);
            emit HoldersPaid(BagReasons.DIVIDENDS, creator, toDividends, eligibleSupply);
        }

        emit Swept(unaccounted, 0, toCreator, toBuyback, toDividends, toLiquidity);
    }

    function _distribute(uint256 amount) internal {
        if (amount == 0) return;
        dividendsHeld += amount;
        totalDeposited += amount;
        if (eligibleSupply == 0) {
            dividendsOrphaned += amount;
        } else {
            accPerShare += (amount * ACC) / eligibleSupply;
        }
    }

    // ---------------------------------------------------------------- the pot

    /// @inheritdoc IHoodPot
    /// @dev Booked whole, on top of whatever tax is still unswept: the amount is either the value
    ///      sent or pulled here, so `accounted` moves by exactly that and the unswept tax is
    ///      untouched.
    function depositForHolders(uint256 amount, bytes32 reason, address payer) external payable {
        _receive(amount);
        accounted += amount;
        _distribute(amount);
        emit HoldersPaid(reason, payer, amount, eligibleSupply);
    }

    /// @inheritdoc IHoodPot
    function pending(address account) external view returns (uint256) {
        return pendingDividends(account);
    }

    /// @inheritdoc IHoodPot
    function claim(address account) external returns (uint256 amount) {
        return claimDividends(account);
    }

    /// @inheritdoc IHoodPot
    /// @dev A holder that cannot take the payout (a contract that rejects it) keeps it claimable
    ///      and is skipped; one bad receiver never stops the round for the others.
    function pushMany(address[] calldata accounts, uint256 floor) external nonReentrant returns (uint256 paid, uint256 count) {
        sweep();
        for (uint256 i; i < accounts.length; ++i) {
            address account = accounts[i];
            _settle(account, trackedBalance[account]);
            uint256 amount = dividendClaimable[account];
            if (amount == 0 || amount < floor) continue;
            dividendClaimable[account] = 0;
            dividendsHeld -= amount;
            accounted -= amount;
            if (!_tryPush(account, amount)) {
                dividendClaimable[account] = amount;
                dividendsHeld += amount;
                accounted += amount;
                continue;
            }
            totalPaid += amount;
            paid += amount;
            ++count;
            emit Pushed(account, amount);
        }
    }

    function _tryPush(address to, uint256 amount) internal returns (bool ok) {
        if (quote == address(0)) {
            (ok,) = to.call{value: amount, gas: PUSH_GAS}("");
        } else {
            ok = IERC20(quote).trySafeTransfer(to, amount);
        }
    }

    // ---------------------------------------------------------------- dividends

    /// @notice Called by the token whenever a balance moves. Bookkeeping only; it cannot revert a
    ///         transfer, because a token that can be frozen by its own accountant is not a token.
    function syncBalances(address from, address to, uint256 fromBalance, uint256 toBalance) external {
        if (msg.sender != token) revert NotToken();
        if (from != address(0)) _settle(from, fromBalance);
        if (to != address(0)) _settle(to, toBalance);
        if (dividendsOrphaned != 0 && eligibleSupply != 0) {
            uint256 orphaned = dividendsOrphaned;
            dividendsOrphaned = 0;
            accPerShare += (orphaned * ACC) / eligibleSupply;
        }
    }

    function _settle(address account, uint256 newBalance) internal {
        if (excluded[account]) return;
        uint256 tracked = trackedBalance[account];
        if (tracked != 0) {
            uint256 total = (tracked * accPerShare) / ACC;
            uint256 debt = dividendDebt[account];
            if (total > debt) dividendClaimable[account] += total - debt;
        }
        eligibleSupply = eligibleSupply + newBalance - tracked;
        trackedBalance[account] = newBalance;
        dividendDebt[account] = (newBalance * accPerShare) / ACC;
    }

    function pendingDividends(address account) public view returns (uint256) {
        if (excluded[account]) return 0;
        uint256 tracked = trackedBalance[account];
        uint256 total = (tracked * accPerShare) / ACC;
        uint256 debt = dividendDebt[account];
        return dividendClaimable[account] + (total > debt ? total - debt : 0);
    }

    /// @notice Permissionless, and it always pays the holder, never the caller.
    function claimDividends(address account) public nonReentrant returns (uint256 amount) {
        sweep();
        _settle(account, trackedBalance[account]);
        amount = dividendClaimable[account];
        if (amount == 0) revert Nothing();
        dividendClaimable[account] = 0;
        dividendsHeld -= amount;
        accounted -= amount;
        totalPaid += amount;
        PairTransfer.push(quote, account, amount);
        emit DividendsClaimed(account, amount);
    }

    // ---------------------------------------------------------------- the creator's road

    /// @notice The creator's share. Creator only, except for the house coin: when the fee recipient
    ///         is the Bag, anyone may send the leg and it goes in through `takeHouseCoinLeg`.
    function claimCreator(address to) external nonReentrant returns (uint256 amount) {
        address bag = _bag();
        bool houseCoin = bag != address(0) && creator == bag;
        if (!houseCoin && msg.sender != creator) revert NotCreator();
        sweep();
        amount = creatorClaimable;
        if (amount == 0) revert Nothing();
        creatorClaimable = 0;
        accounted -= amount;
        if (houseCoin) {
            DirectPay.payWithCall(quote, bag, amount, abi.encodeCall(IHoodBag.takeHouseCoinLeg, (quote, amount)));
            emit CreatorClaimed(bag, amount);
        } else {
            PairTransfer.push(quote, to, amount);
            emit CreatorClaimed(to, amount);
        }
    }

    /// @notice The creator sold their own token: what they had not claimed goes to the holders.
    ///         Token only, and a no-op when there is nothing to move.
    function slashCreator() external {
        if (msg.sender != token) revert NotToken();
        sweep();
        uint256 amount = creatorClaimable;
        if (amount == 0) return;
        creatorClaimable = 0;
        _distribute(amount);
        emit CreatorSlashed(creator, amount);
        emit HoldersPaid(BagReasons.SLASH, creator, amount, eligibleSupply);
    }

    // ---------------------------------------------------------------- the other roads

    /// @notice Hands the buyback pot to the module that swaps and burns. Module only, and the
    ///         module's entry point is permissionless, so anybody can make the buyback happen.
    function releaseBuyback() external nonReentrant returns (uint256 amount) {
        if (msg.sender != buybackModule) revert NotBuybackModule();
        sweep();
        amount = buybackPot;
        if (amount == 0) revert Nothing();
        buybackPot = 0;
        accounted -= amount;
        PairTransfer.push(quote, buybackModule, amount);
        emit BuybackReleased(amount);
    }

    /// @notice Permissionless. Pushes the liquidity share into the locked position.
    function pushLiquidity() external nonReentrant returns (uint256 amount) {
        sweep();
        amount = liquidityPot;
        if (amount == 0) revert Nothing();
        liquidityPot = 0;
        accounted -= amount;
        PairTransfer.push(quote, locker, amount);
        emit LiquidityPushed(amount);
    }

    /// @notice Permissionless. Pays a legacy protocol cut to the portal's current treasury, and
    ///         falls back to the one pinned at launch. Nothing new is ever booked here: the
    ///         platform's fee goes to the Bag from the hook. The referral leg the portal's registry
    ///         names for this token, if any, comes off first.
    /// @dev Every failure reading the registry (no registry, no code there, a revert) means "no
    ///      referral", so nothing the owner points the portal at can hold this claim hostage. A
    ///      referrer that REJECTS the transfer does revert the claim, and only this launch's: the
    ///      owner clears the referral in the registry to unblock it.
    function claimProtocol() external nonReentrant returns (uint256 amount) {
        sweep();
        amount = protocolClaimable;
        if (amount == 0) revert Nothing();
        protocolClaimable = 0;
        accounted -= amount;
        address to = treasury;
        try IPortalTreasury(portal).treasury() returns (address current) {
            if (current != address(0)) to = current;
        } catch {}
        (address referrer, uint256 cut) = _referral(amount);
        if (cut != 0) {
            PairTransfer.push(quote, referrer, cut);
            emit ReferralPaid(referrer, cut);
        }
        PairTransfer.push(quote, to, amount - cut);
        emit ProtocolClaimed(to, amount - cut);
    }

    /// @dev The referral leg of `amount`, or (0, 0) whenever the registry cannot be read: the same
    ///      read the hook makes for the Bag's share, in ReferralLeg.
    function _referral(uint256 amount) internal view returns (address referrer, uint256 cut) {
        return ReferralLeg.cut(portal, token, amount);
    }

    /// @dev The Bag, as the portal names it right now, or zero when the portal cannot say.
    function _bag() internal view returns (address bag) {
        try IPortalTreasury(portal).bag() returns (address b) {
            bag = b;
        } catch {}
    }

    /// @dev The pot's payment convention: native as value, an ERC-20 approved and pulled here.
    function _receive(uint256 amount) internal {
        if (quote == address(0)) {
            if (msg.value != amount) revert PairTransfer.WrongValue();
        } else {
            if (msg.value != 0) revert PairTransfer.WrongValue();
            IERC20(quote).safeTransferFrom(msg.sender, address(this), amount);
        }
    }

    function _balance() internal view returns (uint256) {
        return quote == address(0) ? address(this).balance : IERC20(quote).balanceOf(address(this));
    }
}
