// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import {Allocations} from "./DirectTypes.sol";
import {PairTransfer} from "../libraries/PairTransfer.sol";

interface IPortalTreasury {
    function treasury() external view returns (address);
}

/// @title HoodRevenueSplitter
/// @notice Every unit of tax a launch collects lands here and leaves along four fixed roads.
/// @dev The protocol takes a tenth, hard coded and immutable. The creator's nine tenths are split
///      between four destinations they chose at launch and can never change: their own claimable
///      balance, a buyback pot, a dividend accumulator for holders, and the locked liquidity.
///
///      It does not matter how money arrives, and nothing has to call in to announce it. `sweep`
///      looks at what the contract holds, subtracts what is already spoken for, and splits the
///      difference. A swap tax, a harvest from the locker and a stranger's donation all behave the
///      same way, and there is no path where funds arrive and sit unaccounted.
///
///      Dividends are pull based, on a per-share accumulator. The token tells this contract when a
///      balance moves; the pool, the locker, the hook and this contract itself hold no share.
contract HoodRevenueSplitter is ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint256 internal constant BPS = 10_000;
    uint256 internal constant ACC = 1e27;
    /// @notice The protocol's cut, fixed in the code rather than in a setter.
    uint16 public constant PROTOCOL_BPS = 1_000;

    address public immutable portal;
    address public immutable treasury;
    address public immutable buybackModule;
    address public immutable token;
    /// @notice address(0) means the launch is quoted in the chain's own currency.
    address public immutable quote;
    address public creator;
    address public locker;
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
    /// @notice The protocol's tenth, waiting to be pulled. Never pushed from inside a sweep, so a
    ///         treasury that cannot take a transfer can never freeze anybody else's money.
    uint256 public protocolClaimable;

    uint256 public accPerShare;
    uint256 public eligibleSupply;
    mapping(address => uint256) public trackedBalance;
    mapping(address => uint256) public dividendDebt;
    mapping(address => uint256) public dividendClaimable;
    mapping(address => bool) public excluded;

    /// @dev Everything the four buckets own. Anything above it is new money.
    uint256 public accounted;

    event Swept(uint256 total, uint256 protocol, uint256 creator, uint256 buyback, uint256 dividends, uint256 liquidity);
    event CreatorClaimed(address indexed to, uint256 amount);
    event DividendsClaimed(address indexed holder, uint256 amount);
    event BuybackReleased(uint256 amount);
    event LiquidityPushed(uint256 amount);
    event ProtocolClaimed(address indexed to, uint256 amount);

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

    /// @notice Marks an address as holding no dividend share: the pool, the hook, the locker.
    function exclude(address who) external {
        if (msg.sender != portal) revert NotPortal();
        _settle(who, 0);
        excluded[who] = true;
    }

    // ---------------------------------------------------------------- the split

    /// @notice Permissionless. Splits whatever arrived since the last call.
    function sweep() public {
        uint256 unaccounted = _balance() - accounted;
        if (unaccounted == 0) return;

        uint256 protocol = (unaccounted * PROTOCOL_BPS) / BPS;
        uint256 rest = unaccounted - protocol;

        Allocations memory a = allocations;
        uint256 toCreator = (rest * a.creatorBps) / BPS;
        uint256 toBuyback = (rest * a.buybackBps) / BPS;
        uint256 toDividends = (rest * a.dividendsBps) / BPS;
        uint256 toLiquidity = rest - toCreator - toBuyback - toDividends;

        creatorClaimable += toCreator;
        buybackPot += toBuyback;
        liquidityPot += toLiquidity;
        protocolClaimable += protocol;
        accounted += unaccounted;
        _distribute(toDividends);

        emit Swept(unaccounted, protocol, toCreator, toBuyback, toDividends, toLiquidity);
    }

    function _distribute(uint256 amount) internal {
        if (amount == 0) return;
        dividendsHeld += amount;
        if (eligibleSupply == 0) {
            dividendsOrphaned += amount;
        } else {
            accPerShare += (amount * ACC) / eligibleSupply;
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

    function pendingDividends(address account) external view returns (uint256) {
        if (excluded[account]) return 0;
        uint256 tracked = trackedBalance[account];
        uint256 total = (tracked * accPerShare) / ACC;
        uint256 debt = dividendDebt[account];
        return dividendClaimable[account] + (total > debt ? total - debt : 0);
    }

    /// @notice Permissionless, and it always pays the holder, never the caller.
    function claimDividends(address account) external nonReentrant returns (uint256 amount) {
        sweep();
        _settle(account, trackedBalance[account]);
        amount = dividendClaimable[account];
        if (amount == 0) revert Nothing();
        dividendClaimable[account] = 0;
        dividendsHeld -= amount;
        accounted -= amount;
        PairTransfer.push(quote, account, amount);
        emit DividendsClaimed(account, amount);
    }

    // ---------------------------------------------------------------- the other three roads

    function claim(address to) external nonReentrant returns (uint256 amount) {
        if (msg.sender != creator) revert NotCreator();
        sweep();
        amount = creatorClaimable;
        if (amount == 0) revert Nothing();
        creatorClaimable = 0;
        accounted -= amount;
        PairTransfer.push(quote, to, amount);
        emit CreatorClaimed(to, amount);
    }

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

    /// @notice Permissionless. Pays the protocol's tenth to the portal's current treasury, so the
    ///         treasury can be rotated after the fact, and falls back to the one pinned at launch.
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
        PairTransfer.push(quote, to, amount);
        emit ProtocolClaimed(to, amount);
    }

    function _balance() internal view returns (uint256) {
        return quote == address(0) ? address(this).balance : IERC20(quote).balanceOf(address(this));
    }
}
