// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import {FeeSplit, Launch, Phase} from "./HoodTypes.sol";
import {PairTransfer} from "./libraries/PairTransfer.sol";
import {IHoodBag} from "./interfaces/IHoodBag.sol";
import {IHoodCurve} from "./interfaces/IHoodCurve.sol";
import {IHoodFactory} from "./interfaces/IHoodFactory.sol";
import {IHoodFeeRouter} from "./interfaces/IHoodFeeRouter.sol";
import {IHoodStaking} from "./interfaces/IHoodStaking.sol";
import {IHoodToken} from "./interfaces/IHoodToken.sol";
import {IGraduationHandler} from "./interfaces/IGraduationHandler.sol";

/// @title HoodFeeRouter
/// @notice Holds the creator leg of every trading fee and, on a permissionless flush, spends it
///         across the four destinations the creator picked at launch.
/// @dev The split is read from the registry, where it is written once and never changed. This
///      contract has no owner. A recipient that refuses payment cannot block the other legs:
///      its own share is held for that recipient to claim to an address that accepts it.
contract HoodFeeRouter is IHoodFeeRouter, ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint256 internal constant BPS = 10_000;

    IHoodFactory public immutable factory;
    IHoodStaking public immutable staking;
    /// @notice The sole hot wallet allowed to execute price-sensitive buybacks.
    /// @dev The factory owner (a Safe in production) can also execute or rotate it.
    address public keeper;

    /// @notice Pair wei booked for a token and not yet spent.
    mapping(address token => uint256) public accrued;
    /// @dev Pair wei this contract knows about, per asset. Anything above it is a stray donation.
    mapping(address asset => uint256) public accounted;
    /// @notice Failed creator payouts, reserved for the recipient that was named when flushed.
    mapping(address recipient => mapping(address asset => uint256)) public creatorClaimable;

    event Accrued(address indexed token, uint256 amount);
    event CreatorPayoutDeferred(address indexed token, address indexed recipient, address indexed asset, uint256 amount);
    event CreatorPayoutClaimed(address indexed recipient, address indexed asset, address indexed to, uint256 amount);
    event KeeperSet(address indexed oldKeeper, address indexed newKeeper);
    event Flushed(
        address indexed token,
        uint256 amount,
        uint256 toStakers,
        uint256 toBuyback,
        uint256 toLiquidity,
        uint256 toCreator,
        uint256 tokensBurned
    );

    error UnknownToken();
    error NotACurveLaunch();
    error FundsNotReceived();
    error NothingToFlush();
    error NeedsSwapFloor();
    error NeedsFinalize();
    error NothingToClaim();
    error ZeroAddress();
    error UnexpectedPayout();
    error NotOwner();
    error NotKeeper();

    constructor(address factory_, address staking_) {
        factory = IHoodFactory(factory_);
        staking = IHoodStaking(staking_);
    }

    receive() external payable {}

    function setKeeper(address next) external {
        if (msg.sender != factory.owner()) revert NotOwner();
        emit KeeperSet(keeper, next);
        keeper = next;
    }

    /// @inheritdoc IHoodFeeRouter
    function accrue(address token, uint256 amount) external payable {
        Launch memory l = factory.getLaunch(token);
        if (!l.exists) revert UnknownToken();
        // A direct launch has no curve, and every path out of here reads one. Booking money against
        // one would be booking money that can never leave, so it is refused at the door.
        if (l.curve == address(0)) revert NotACurveLaunch();
        _take(l.pairToken, amount, msg.value);
        accrued[token] += amount;
        emit Accrued(token, amount);
    }

    /// @notice Permissionless. Spends what is booked for `token` across its split.
    /// @dev Reverts for a token with a buyback leg, graduated or not: that leg has to buy, and a
    ///      buy without a floor is a gift to whoever is watching, so it goes through
    ///      `flushBuyback`. A token whose split never buys is served here.
    function flush(address token) external nonReentrant {
        _flush(token, 0, false);
    }

    /// @notice Owner/keeper-only flush with a quoted slippage floor on the buyback leg.
    /// @dev A permissionless caller can pass a dust floor and sandwich the visible fee pot, so
    ///      only the owner-appointed executor may choose the floor. The owner can rotate it.
    ///         The other three legs do exactly what they do in a plain flush.
    function flushBuyback(address token, uint256 minTokensOut) external nonReentrant {
        if (msg.sender != keeper && msg.sender != factory.owner()) revert NotKeeper();
        if (minTokensOut == 0) revert NeedsSwapFloor();
        _flush(token, minTokensOut, true);
    }

    /// @notice A recipient whose payout failed may redirect only its own reserved funds.
    function claimCreator(address asset, address to) external nonReentrant {
        if (to == address(0)) revert ZeroAddress();
        uint256 amount = creatorClaimable[msg.sender][asset];
        if (amount == 0) revert NothingToClaim();
        creatorClaimable[msg.sender][asset] = 0;
        accounted[asset] -= amount;
        PairTransfer.push(asset, to, amount);
        emit CreatorPayoutClaimed(msg.sender, asset, to, amount);
    }

    function _flush(address token, uint256 minTokensOut, bool withFloor) internal {
        Launch memory l = factory.getLaunch(token);
        if (!l.exists) revert UnknownToken();

        uint256 amount = accrued[token];
        if (amount == 0) revert NothingToFlush();
        // A buyback is a market order somebody else can stand in front of, on the pool AND on the
        // curve: the curve's price is a function of how much has been sold, so a caller can buy,
        // force a floorless buyback into their own bid and sell into it. Both paths need the caller
        // to have quoted the trade, which is what `flushBuyback` is for. It is the share that
        // decides, not the rounded leg, so the same token always flushes the same way.
        if (l.feeSplit.buybackBps != 0 && !withFloor) revert NeedsSwapFloor();

        accrued[token] = 0;
        accounted[l.pairToken] -= amount;

        (uint256 toStakers, uint256 toBuyback, uint256 toLiquidity, uint256 toCreator) = _shares(l.feeSplit, amount);

        if (toStakers != 0) {
            PairTransfer.pushAndCall(
                l.pairToken,
                address(staking),
                toStakers,
                // The vault is keyed by the asset now, not by the launch: whoever locked the house
                // coin is paid out of every launch, and this one pays in whatever it trades against.
                abi.encodeCall(IHoodStaking.notifyReward, (l.pairToken, toStakers))
            );
        }
        uint256 burned;
        bool offTheCurve;
        if (toBuyback != 0) (burned, offTheCurve) = _buyback(l, token, toBuyback, minTokensOut);
        if (toLiquidity != 0) _liquidity(l, token, toLiquidity);
        if (toCreator != 0 && !_houseCoinLeg(l, toCreator)) {
            bool paid;
            if (l.pairToken == address(0)) {
                // Cap callback gas so a hostile recipient cannot consume the entire flush.
                (paid,) = l.creatorFeeRecipient.call{value: toCreator, gas: 30_000}("");
            } else {
                uint256 before = IERC20(l.pairToken).balanceOf(address(this));
                paid = IERC20(l.pairToken).trySafeTransfer(l.creatorFeeRecipient, toCreator);
                uint256 spent = before - IERC20(l.pairToken).balanceOf(address(this));
                // A nonstandard token may move funds and still return false. Never reserve those
                // funds a second time, and never continue after an inexact outgoing transfer.
                if (spent != 0 && spent != toCreator) revert UnexpectedPayout();
                paid = spent == toCreator;
            }
            if (!paid) {
                creatorClaimable[l.creatorFeeRecipient][l.pairToken] += toCreator;
                accounted[l.pairToken] += toCreator;
                emit CreatorPayoutDeferred(token, l.creatorFeeRecipient, l.pairToken, toCreator);
            }
        }

        // Two things come back from a buy off the curve: the creator fee on the buyback itself,
        // which the curve books through `accrue` like any trade, and whatever rounding kept the
        // curve from spending, which nothing books. The second is still this token's money, so it
        // is booked here rather than left stranded. Counted once every leg has been paid out, or
        // the legs still sitting here would be counted as change and spent a second time.
        if (offTheCurve) {
            uint256 unbooked = PairTransfer.balance(l.pairToken, address(this)) - accounted[l.pairToken];
            if (unbooked != 0) {
                accrued[token] += unbooked;
                accounted[l.pairToken] += unbooked;
            }
        }

        emit Flushed(token, amount, toStakers, toBuyback, toLiquidity, toCreator, burned);
    }

    // ---------------------------------------------------------------- the four legs

    /// @dev The house coin names the Bag as its creator. That leg is not a payout to a wallet but
    ///      an intake with rules of its own (half Vault, half burn), so it goes in the Bag's door
    ///      rather than at its receive. Read live, not pinned: the Bag is set once on the factory.
    ///      Returns true when it paid, so the ordinary creator payout is skipped.
    function _houseCoinLeg(Launch memory l, uint256 amount) internal returns (bool) {
        address bag = factory.bag();
        if (bag == address(0) || l.creatorFeeRecipient != bag) return false;
        _approvePair(l.pairToken, bag, amount);
        IHoodBag(bag).takeHouseCoinLeg{value: _value(l.pairToken, amount)}(l.pairToken, amount);
        return true;
    }

    /// @dev Each leg is floored and the last one with a share takes the remainder, so four legs
    ///      always add up to exactly what was booked and no wei is ever left behind in here.
    function _shares(FeeSplit memory s, uint256 amount)
        internal
        pure
        returns (uint256 toStakers, uint256 toBuyback, uint256 toLiquidity, uint256 toCreator)
    {
        toStakers = (amount * s.stakersBps) / BPS;
        toBuyback = (amount * s.buybackBps) / BPS;
        toLiquidity = (amount * s.liquidityBps) / BPS;
        toCreator = (amount * s.creatorBps) / BPS;
        uint256 dust = amount - toStakers - toBuyback - toLiquidity - toCreator;
        if (dust == 0) return (toStakers, toBuyback, toLiquidity, toCreator);
        if (s.creatorBps != 0) toCreator += dust;
        else if (s.liquidityBps != 0) toLiquidity += dust;
        else if (s.buybackBps != 0) toBuyback += dust;
        else toStakers += dust;
    }

    /// @dev Buys the token back and burns it: off the curve before graduation, out of the pool
    ///      after. Returns what was burned, and whether the buy was the curve's, which is the only
    ///      one that hands change back.
    function _buyback(Launch memory l, address token, uint256 amount, uint256 minTokensOut)
        internal
        returns (uint256 burned, bool offTheCurve)
    {
        Phase phase = IHoodCurve(l.curve).phase();
        if (phase == Phase.Graduated) {
            // ERC-20 pair: the handler pulls what it is allowed to, native goes as value.
            address handler = IHoodCurve(l.curve).graduationHandler();
            _approvePair(l.pairToken, handler, amount);
            burned =
                IGraduationHandler(handler).buyback{value: _value(l.pairToken, amount)}(token, amount, minTokensOut);
        } else {
            // A sold-out curve cannot be bought from and its pool is one permissionless `finalize`
            // away, so the whole flush waits for that call rather than burning nothing.
            if (phase == Phase.Sold) revert NeedsFinalize();
            uint256 before = IERC20(token).balanceOf(address(this));
            _approvePair(l.pairToken, l.curve, amount);
            IHoodCurve(l.curve).buy{value: _value(l.pairToken, amount)}(amount, minTokensOut, address(this));
            burned = IERC20(token).balanceOf(address(this)) - before;
            IHoodToken(token).burn(burned);
            offTheCurve = true;
        }
    }

    /// @dev Deepens the liquidity the token lives in: into the raise before graduation, so the pool
    ///      opens deeper, and into the locked position after.
    function _liquidity(Launch memory l, address token, uint256 amount) internal {
        if (IHoodCurve(l.curve).phase() == Phase.Graduated) {
            address handler = IHoodCurve(l.curve).graduationHandler();
            _approvePair(l.pairToken, handler, amount);
            IGraduationHandler(handler).compound{value: _value(l.pairToken, amount)}(token, amount);
        } else {
            _approvePair(l.pairToken, l.curve, amount);
            IHoodCurve(l.curve).donate{value: _value(l.pairToken, amount)}(amount);
        }
    }

    // ---------------------------------------------------------------- internals

    function _take(address asset, uint256 amount, uint256 value) internal {
        if (asset == address(0)) {
            if (value != amount) revert FundsNotReceived();
        } else {
            if (value != 0) revert FundsNotReceived();
            // The payer transfers first and calls after, so the funds must already be here.
            if (IERC20(asset).balanceOf(address(this)) < accounted[asset] + amount) revert FundsNotReceived();
        }
        accounted[asset] += amount;
    }

    function _value(address asset, uint256 amount) internal pure returns (uint256) {
        return asset == address(0) ? amount : 0;
    }

    function _approvePair(address asset, address spender, uint256 amount) internal {
        if (asset != address(0)) {
            IERC20(asset).forceApprove(spender, amount);
        }
    }
}
