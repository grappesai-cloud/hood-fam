// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import {Phase} from "./HoodTypes.sol";
import {CurveMath} from "./libraries/CurveMath.sol";
import {PairTransfer} from "./libraries/PairTransfer.sol";
import {IHoodCurve} from "./interfaces/IHoodCurve.sol";
import {IHoodFactory} from "./interfaces/IHoodFactory.sol";
import {IHoodFeeRouter} from "./interfaces/IHoodFeeRouter.sol";
import {IGraduationHandler} from "./interfaces/IGraduationHandler.sol";

/// @title HoodCurve
/// @notice One launch's market: a linear bonding curve that sells the curve supply, then hands the
///         pool supply and the raise to the graduation handler and closes for good.
/// @dev Everything that matters is immutable and set at launch. There is no owner, no pause, no
///      parameter setter and no path for anybody to take the reserve out other than selling back
///      into the curve or graduating into the pool.
contract HoodCurve is IHoodCurve, ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint256 internal constant BPS = 10_000;

    struct InitParams {
        address factory;
        address token;
        address pairToken;
        address treasury;
        address feeRouter;
        address graduationHandler;
        uint256 curveSupply;
        uint256 lpSupply;
        uint256 p0;
        uint256 p1;
        uint16 liquidityBps;
        uint16 protocolFeeBps;
        uint16 creatorFeeBps;
        uint24 poolFee;
        int24 tickSpacing;
    }

    address public immutable factory;
    address public immutable token;
    address public immutable pairToken;
    address public immutable treasury;
    address public immutable feeRouter;
    /// @dev Pinned at launch. A later change of the launchpad's default handler cannot reach a
    ///      token that is already trading.
    address public immutable graduationHandler;
    uint256 public immutable curveSupply;
    uint256 public immutable lpSupply;
    uint256 public immutable p0;
    uint256 public immutable p1;
    uint16 public immutable liquidityBps;
    uint16 public immutable protocolFeeBps;
    uint16 public immutable creatorFeeBps;
    uint24 public immutable poolFee;
    int24 public immutable tickSpacing;

    Phase public phase;
    /// @notice Token wei sold off the curve.
    uint256 public sold;
    /// @notice Pair wei paid in by buyers, net of fees. Backs every sell, seeds the pool at the end.
    uint256 public reserve;
    /// @notice Pair wei donated on top of the curve. Goes to the pool, never back out.
    uint256 public bonus;
    /// @notice The protocol's fee legs, booked and waiting to be pulled by anyone.
    uint256 public protocolClaimable;

    event Bought(address indexed buyer, address indexed to, uint256 pairIn, uint256 tokensOut, uint256 fee);
    event Sold(address indexed seller, address indexed to, uint256 tokensIn, uint256 pairOut, uint256 fee);
    event Donated(address indexed from, uint256 amount);
    event SoldOut(uint256 reserve);
    event Graduated(uint256 tokenAmount, uint256 pairAmount, uint256 graduationFee);
    event ProtocolClaimed(address indexed to, uint256 amount);

    error NotTrading();
    error NotSoldOut();
    error ZeroAddress();
    error NothingBought();
    error Slippage();
    error TooExpensive();
    error ExceedsCurveSupply();
    error InsufficientValue();
    error NothingToClaim();

    constructor(InitParams memory p) {
        factory = p.factory;
        token = p.token;
        pairToken = p.pairToken;
        treasury = p.treasury;
        feeRouter = p.feeRouter;
        graduationHandler = p.graduationHandler;
        curveSupply = p.curveSupply;
        lpSupply = p.lpSupply;
        p0 = p.p0;
        p1 = p.p1;
        liquidityBps = p.liquidityBps;
        protocolFeeBps = p.protocolFeeBps;
        creatorFeeBps = p.creatorFeeBps;
        poolFee = p.poolFee;
        tickSpacing = p.tickSpacing;
    }

    // ---------------------------------------------------------------- views

    /// @notice Current price per 1e18 token wei, in pair units.
    function price() public view returns (uint256) {
        return CurveMath.priceAt(p0, p1, curveSupply, sold);
    }

    /// @notice Token wei still for sale on the curve.
    function remaining() public view returns (uint256) {
        return curveSupply - sold;
    }

    /// @notice What the reserve holds once the curve sells out, in pair units.
    function raiseTarget() public view returns (uint256) {
        return CurveMath.cost(p0, p1, curveSupply, 0, curveSupply, false);
    }

    function quoteBuy(uint256 pairIn) public view returns (uint256 tokensOut, uint256 pairSpent, uint256 fee) {
        if (phase != Phase.Curve) return (0, 0, 0);
        uint256 budget = pairIn - _feeOnGross(pairIn);
        tokensOut = CurveMath.tokensForPair(p0, p1, curveSupply, sold, budget, remaining());
        if (tokensOut == 0) return (0, 0, 0);
        uint256 net = CurveMath.cost(p0, p1, curveSupply, sold, tokensOut, true);
        fee = _feeOnNet(net);
        pairSpent = net + fee;
    }

    function quoteBuyExactOut(uint256 tokensOut) public view returns (uint256 pairIn, uint256 fee) {
        uint256 net = CurveMath.cost(p0, p1, curveSupply, sold, tokensOut, true);
        fee = _feeOnNet(net);
        pairIn = net + fee;
    }

    function quoteSell(uint256 tokensIn) public view returns (uint256 pairOut, uint256 fee) {
        if (tokensIn > sold) return (0, 0);
        uint256 gross = CurveMath.cost(p0, p1, curveSupply, sold - tokensIn, tokensIn, false);
        fee = Math.mulDiv(gross, uint256(protocolFeeBps) + creatorFeeBps, BPS);
        pairOut = gross - fee;
    }

    // ---------------------------------------------------------------- trading

    /// @notice Spends `pairIn` on tokens. Whatever the curve cannot absorb comes straight back.
    function buy(uint256 pairIn, uint256 minTokensOut, address to)
        external
        payable
        nonReentrant
        returns (uint256 tokensOut)
    {
        if (phase != Phase.Curve) revert NotTrading();
        if (to == address(0)) revert ZeroAddress();
        PairTransfer.pull(pairToken, msg.sender, pairIn, msg.value);

        uint256 budget = pairIn - _feeOnGross(pairIn);
        tokensOut = CurveMath.tokensForPair(p0, p1, curveSupply, sold, budget, remaining());
        if (tokensOut == 0) revert NothingBought();
        if (tokensOut < minTokensOut) revert Slippage();

        uint256 net = CurveMath.cost(p0, p1, curveSupply, sold, tokensOut, true);
        uint256 spent = _settleBuy(net, tokensOut, to);
        PairTransfer.push(pairToken, msg.sender, pairIn - spent);
        emit Bought(msg.sender, to, spent, tokensOut, spent - net);
    }

    /// @notice Buys exactly `tokensOut`, paying at most `maxPairIn`.
    function buyExactOut(uint256 tokensOut, uint256 maxPairIn, address to)
        external
        payable
        nonReentrant
        returns (uint256 pairSpent)
    {
        if (phase != Phase.Curve) revert NotTrading();
        if (to == address(0)) revert ZeroAddress();
        if (tokensOut == 0) revert NothingBought();
        if (tokensOut > remaining()) revert ExceedsCurveSupply();

        uint256 net = CurveMath.cost(p0, p1, curveSupply, sold, tokensOut, true);
        uint256 quoted = net + _feeOnNet(net);
        if (quoted > maxPairIn) revert TooExpensive();

        if (pairToken == address(0)) {
            if (msg.value < quoted) revert InsufficientValue();
        } else {
            PairTransfer.pull(pairToken, msg.sender, quoted, msg.value);
        }

        pairSpent = _settleBuy(net, tokensOut, to);
        if (pairToken == address(0)) PairTransfer.push(pairToken, msg.sender, msg.value - pairSpent);
        emit Bought(msg.sender, to, pairSpent, tokensOut, pairSpent - net);
    }

    /// @notice Sells `tokensIn` back into the curve.
    function sell(uint256 tokensIn, uint256 minPairOut, address to) external nonReentrant returns (uint256 pairOut) {
        if (phase != Phase.Curve) revert NotTrading();
        if (to == address(0)) revert ZeroAddress();
        if (tokensIn == 0 || tokensIn > sold) revert NothingBought();

        IERC20(token).safeTransferFrom(msg.sender, address(this), tokensIn);

        uint256 gross = CurveMath.cost(p0, p1, curveSupply, sold - tokensIn, tokensIn, false);
        (uint256 protocolFee, uint256 creatorFee) = _splitFee(Math.mulDiv(gross, uint256(protocolFeeBps) + creatorFeeBps, BPS));
        pairOut = gross - protocolFee - creatorFee;
        if (pairOut < minPairOut) revert Slippage();

        sold -= tokensIn;
        reserve -= gross;

        PairTransfer.push(pairToken, to, pairOut);
        _payFees(protocolFee, creatorFee);
        IHoodFactory(factory).recordVolume(token, gross);

        emit Sold(msg.sender, to, tokensIn, pairOut, protocolFee + creatorFee);
    }

    /// @notice Adds pair funds to the liquidity this token graduates into.
    function donate(uint256 amount) external payable nonReentrant {
        if (phase == Phase.Graduated) revert NotTrading();
        PairTransfer.pull(pairToken, msg.sender, amount, msg.value);
        bonus += amount;
        emit Donated(msg.sender, amount);
    }

    /// @notice Permissionless. Opens the pool once the curve has sold out.
    /// @dev Kept out of the last buy on purpose: a pool deployment that reverts must never be able
    ///      to hold a trade hostage. Anyone can call this, in the same block if they want.
    function finalize() external nonReentrant {
        if (phase != Phase.Sold) revert NotSoldOut();
        phase = Phase.Graduated;

        uint256 pairForLp = Math.mulDiv(reserve, liquidityBps, BPS) + bonus;
        uint256 graduationFee = reserve + bonus - pairForLp;
        uint256 tokenAmount = IERC20(token).balanceOf(address(this));
        reserve = 0;
        bonus = 0;

        IERC20(token).safeTransfer(graduationHandler, tokenAmount);
        PairTransfer.pushAndCall(
            pairToken,
            graduationHandler,
            pairForLp,
            abi.encodeCall(
                IGraduationHandler.graduate, (token, pairToken, tokenAmount, pairForLp, poolFee, tickSpacing)
            )
        );
        protocolClaimable += graduationFee;

        emit Graduated(tokenAmount, pairForLp, graduationFee);
    }

    /// @notice Permissionless. Pays the protocol's booked fees to the treasury pinned at launch.
    /// @dev Pulled rather than pushed, for the reason in `_payFees`. The keeper calls it; if the
    ///      keeper dies anybody can, and until somebody does the money sits here untouched.
    function claimProtocol() external nonReentrant returns (uint256 amount) {
        amount = protocolClaimable;
        if (amount == 0) revert NothingToClaim();
        protocolClaimable = 0;
        PairTransfer.push(pairToken, treasury, amount);
        emit ProtocolClaimed(treasury, amount);
    }

    // ---------------------------------------------------------------- internals

    /// @dev Fee charged on a gross amount the buyer hands in.
    function _feeOnGross(uint256 gross) internal view returns (uint256) {
        uint256 bps = uint256(protocolFeeBps) + creatorFeeBps;
        if (bps == 0) return 0;
        return Math.mulDiv(gross, bps, BPS, Math.Rounding.Ceil);
    }

    /// @dev Fee that sits on top of `net` so that fee = bps of (net + fee).
    function _feeOnNet(uint256 net) internal view returns (uint256) {
        uint256 bps = uint256(protocolFeeBps) + creatorFeeBps;
        if (bps == 0) return 0;
        return Math.mulDiv(net, bps, BPS - bps, Math.Rounding.Ceil);
    }

    /// @dev Splits one rounded total, so the two legs can never add up to more than it.
    function _splitFee(uint256 total) internal view returns (uint256 protocolFee, uint256 creatorFee) {
        uint256 bps = uint256(protocolFeeBps) + creatorFeeBps;
        if (bps == 0 || total == 0) return (0, 0);
        protocolFee = Math.mulDiv(total, protocolFeeBps, bps);
        creatorFee = total - protocolFee;
    }

    function _settleBuy(uint256 net, uint256 tokensOut, address to) internal returns (uint256 spent) {
        (uint256 protocolFee, uint256 creatorFee) = _splitFee(_feeOnNet(net));
        spent = net + protocolFee + creatorFee;

        sold += tokensOut;
        reserve += net;

        IERC20(token).safeTransfer(to, tokensOut);
        _payFees(protocolFee, creatorFee);
        IHoodFactory(factory).recordVolume(token, spent);

        if (sold == curveSupply) {
            phase = Phase.Sold;
            emit SoldOut(reserve);
        }
    }

    /// @dev The protocol's leg is BOOKED, not sent. Every trade calls this, so a treasury that
    ///      cannot take a transfer (an EIP-7702 delegation on this chain, a Safe with a reverting
    ///      fallback, a blacklisted stablecoin address) would otherwise stop every trade on every
    ///      curve that names it, and the address is an immutable. Nobody else's money may depend on
    ///      the treasury accepting funds, so `claimProtocol` pulls it instead.
    function _payFees(uint256 protocolFee, uint256 creatorFee) internal {
        protocolClaimable += protocolFee;
        if (creatorFee != 0) {
            PairTransfer.pushAndCall(
                pairToken, feeRouter, creatorFee, abi.encodeCall(IHoodFeeRouter.accrue, (token, creatorFee))
            );
        }
    }
}
