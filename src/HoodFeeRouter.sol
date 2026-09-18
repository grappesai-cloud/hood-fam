// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import {FeeModel, Launch, Phase} from "./HoodTypes.sol";
import {PairTransfer} from "./libraries/PairTransfer.sol";
import {IHoodCurve} from "./interfaces/IHoodCurve.sol";
import {IHoodFactory} from "./interfaces/IHoodFactory.sol";
import {IHoodFeeRouter} from "./interfaces/IHoodFeeRouter.sol";
import {IHoodStaking} from "./interfaces/IHoodStaking.sol";
import {IHoodToken} from "./interfaces/IHoodToken.sol";
import {IGraduationHandler} from "./interfaces/IGraduationHandler.sol";

/// @title HoodFeeRouter
/// @notice Holds the creator leg of every trading fee and, on a permissionless flush, spends it the
///         way the creator chose at launch.
/// @dev The fee model is read from the registry, where it is written once and never changed. This
///      contract has no owner and no withdrawal: whatever is booked for a token can only leave
///      along that token's model.
contract HoodFeeRouter is IHoodFeeRouter, ReentrancyGuard {
    using SafeERC20 for IERC20;

    IHoodFactory public immutable factory;
    IHoodStaking public immutable staking;

    /// @notice Pair wei booked for a token and not yet spent.
    mapping(address token => uint256) public accrued;
    /// @dev Pair wei this contract knows about, per asset. Anything above it is a stray donation.
    mapping(address asset => uint256) public accounted;

    event Accrued(address indexed token, uint256 amount);
    event Flushed(address indexed token, FeeModel model, uint256 amount, uint256 result);

    error UnknownToken();
    error NotACurveLaunch();
    error FundsNotReceived();
    error NothingToFlush();
    error NeedsSwapFloor();
    error NeedsFinalize();

    constructor(address factory_, address staking_) {
        factory = IHoodFactory(factory_);
        staking = IHoodStaking(staking_);
    }

    receive() external payable {}

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

    /// @notice Permissionless. Spends what is booked for `token` along its fee model.
    /// @dev Reverts for a buyback-and-burn token, graduated or not: that one has to buy, and a buy
    ///      without a floor is a gift to whoever is watching, so it goes through `flushBuyback`.
    function flush(address token) external nonReentrant {
        _flush(token, 0, false);
    }

    /// @notice Permissionless flush for buyback-and-burn after graduation, with a slippage floor.
    function flushBuyback(address token, uint256 minTokensOut) external nonReentrant {
        _flush(token, minTokensOut, true);
    }

    function _flush(address token, uint256 minTokensOut, bool withFloor) internal {
        Launch memory l = factory.getLaunch(token);
        if (!l.exists) revert UnknownToken();

        uint256 amount = accrued[token];
        if (amount == 0) revert NothingToFlush();
        accrued[token] = 0;
        accounted[l.pairToken] -= amount;

        bool graduated = IHoodCurve(l.curve).phase() == Phase.Graduated;
        address handler = IHoodCurve(l.curve).graduationHandler();
        uint256 result;

        if (l.feeModel == FeeModel.StakingRewards) {
            PairTransfer.pushAndCall(
                l.pairToken, address(staking), amount, abi.encodeCall(IHoodStaking.notifyReward, (token, amount))
            );
            result = amount;
        } else if (l.feeModel == FeeModel.BuybackBurn) {
            // A buyback is a market order somebody else can stand in front of, on the pool AND on
            // the curve: the curve's price is a function of how much has been sold, so a caller can
            // buy, force a floorless buyback into their own bid and sell into it. Both paths need
            // the caller to have quoted the trade, which is what `flushBuyback` is for.
            if (graduated) {
                if (!withFloor) revert NeedsSwapFloor();
                // ERC-20 pair: the handler pulls what it is allowed to, native goes as value.
                _approvePair(l.pairToken, handler, amount);
                result =
                    IGraduationHandler(handler).buyback{value: _value(l.pairToken, amount)}(token, amount, minTokensOut);
            } else {
                if (IHoodCurve(l.curve).phase() == Phase.Sold) revert NeedsFinalize();
                if (!withFloor) revert NeedsSwapFloor();
                uint256 before = IERC20(token).balanceOf(address(this));
                _approvePair(l.pairToken, l.curve, amount);
                IHoodCurve(l.curve).buy{value: _value(l.pairToken, amount)}(amount, minTokensOut, address(this));
                uint256 bought = IERC20(token).balanceOf(address(this)) - before;
                IHoodToken(token).burn(bought);
                result = bought;
                // Two things come back from that buy: the creator fee on the buyback itself, which
                // the curve books through `accrue` like any trade, and whatever rounding kept the
                // curve from spending, which nothing books. The second is still this token's
                // money, so it is booked here rather than left stranded.
                uint256 unbooked = PairTransfer.balance(l.pairToken, address(this)) - accounted[l.pairToken];
                if (unbooked != 0) {
                    accrued[token] += unbooked;
                    accounted[l.pairToken] += unbooked;
                }
            }
        } else if (l.feeModel == FeeModel.LiquidityCompound) {
            if (graduated) {
                _approvePair(l.pairToken, handler, amount);
                IGraduationHandler(handler).compound{value: _value(l.pairToken, amount)}(token, amount);
            } else {
                _approvePair(l.pairToken, l.curve, amount);
                IHoodCurve(l.curve).donate{value: _value(l.pairToken, amount)}(amount);
            }
            result = amount;
        } else if (l.feeModel == FeeModel.CreatorKeep) {
            PairTransfer.push(l.pairToken, l.creatorFeeRecipient, amount);
            result = amount;
        } else {
            // ZeroFee never books anything through a trade. Anything that lands here was donated,
            // and the only place it may go is the treasury.
            PairTransfer.push(l.pairToken, factory.treasury(), amount);
            result = amount;
        }

        emit Flushed(token, l.feeModel, amount, result);
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
