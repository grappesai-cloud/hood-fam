// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import {Phase} from "./HoodTypes.sol";
import {CurveMath} from "./libraries/CurveMath.sol";
import {PairTransfer} from "./libraries/PairTransfer.sol";
import {IHoodBag} from "./interfaces/IHoodBag.sol";
import {IHoodCurve} from "./interfaces/IHoodCurve.sol";
import {IHoodFactory} from "./interfaces/IHoodFactory.sol";
import {IHoodPot} from "./interfaces/IHoodPot.sol";
import {BagReasons, BagSplits} from "./bag/BagTypes.sol";
import {IHoodFeeRouter} from "./interfaces/IHoodFeeRouter.sol";
import {IHoodReferrals} from "./interfaces/IHoodReferrals.sol";
import {IGraduationHandler} from "./interfaces/IGraduationHandler.sol";

/// @title HoodCurve
/// @notice One launch's market: a linear bonding curve that sells the curve supply, then hands the
///         pool supply and the raise to the graduation handler and closes for good.
/// @dev Everything that matters is immutable and set at launch. There is no owner, no pause, no
///      parameter setter and no path for anybody to take the reserve out other than selling back
///      into the curve or graduating into the pool.
///
///      Every protocol leg leaves through the Bag, pinned at launch: the trade legs when somebody
///      claims them, the graduation fee inside `finalize`. The Bag has no owner and splits by rules
///      fixed at its deploy, so pinning it is pinning the rules this launch was sold under.
///
///      The open is guarded the way the direct machine's is: a surcharge on buys that decays to
///      nothing over `snipeDecaySeconds`, and a per-wallet buy cap for `restrictionBlocks`. The
///      surcharge is a penalty, not a fee: 80% to this launch's holders through the pot, 20% to
///      the Bag. Exempt are buys made INSIDE the launch transaction by the factory (the creator's
///      first buy) or by the account that called the factory (a block-zero periphery), and
///      nothing else: the constructor marks this contract's transient storage, which lives for
///      exactly the launch transaction, so a buy one transaction later is a buy like any other.
contract HoodCurve is IHoodCurve, ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint256 internal constant BPS = 10_000;

    struct InitParams {
        address factory;
        address token;
        address pairToken;
        address bag;
        address pot;
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
        // The opening rules (v4), and who called the factory: its buys inside the launch
        // transaction are the launch's own.
        address opener;
        uint16 snipeTaxBps;
        uint32 snipeDecaySeconds;
        uint32 restrictionBlocks;
        uint256 maxBuy;
    }

    /// @dev Transient slot set by the constructor: nonzero for the rest of the launch transaction.
    bytes32 internal constant LAUNCH_TX_SLOT = keccak256("hood.curve.launch-tx");

    address public immutable factory;
    address public immutable token;
    address public immutable pairToken;
    /// @notice Where every protocol leg goes. Pinned: a Bag swapped later cannot reach this launch.
    address public immutable bag;
    /// @notice The launch's pot, named to the Bag at graduation so Confetti lands in the right room.
    address public immutable pot;
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
    /// @notice The account that called the factory. Only inside the launch transaction does it matter.
    address public immutable opener;
    uint16 public immutable snipeTaxBps;
    uint32 public immutable snipeDecaySeconds;
    uint64 public immutable launchedAt;
    /// @notice The last block of the per-wallet buy cap.
    uint64 public immutable restrictionsEndBlock;
    /// @notice Token wei one wallet may buy until `restrictionsEndBlock`. Zero = no cap.
    uint256 public immutable maxBuy;

    Phase public phase;
    /// @notice Token wei sold off the curve.
    uint256 public sold;
    /// @notice Pair wei paid in by buyers, net of fees. Backs every sell, seeds the pool at the end.
    uint256 public reserve;
    /// @notice Pair wei donated on top of the curve. Goes to the pool, never back out.
    uint256 public bonus;
    /// @notice The protocol's fee legs, booked and waiting to be pulled by anyone.
    uint256 public protocolClaimable;
    /// @notice The Bag's share of snipe penalties, booked like the fee legs and pulled with them.
    uint256 public penaltyClaimable;
    /// @notice Token wei each wallet bought while the buy cap held.
    mapping(address => uint256) public boughtDuringWindow;

    event Bought(address indexed buyer, address indexed to, uint256 pairIn, uint256 tokensOut, uint256 fee);
    event Sold(address indexed seller, address indexed to, uint256 tokensIn, uint256 pairOut, uint256 fee);
    event Donated(address indexed from, uint256 amount);
    event SoldOut(uint256 reserve);
    event Graduated(uint256 tokenAmount, uint256 pairAmount, uint256 graduationFee);
    event ProtocolClaimed(address indexed to, uint256 amount);
    event ReferralPaid(address indexed to, uint256 amount);
    /// @notice A buy inside the decay window paid the surcharge. `buyer` is the caller, `to` the
    ///         wallet that got the tokens; `toHolders` went into the pot in this same call.
    event Sniped(address indexed buyer, address indexed to, uint256 penalty, uint256 toHolders, uint256 toBag);

    error NotTrading();
    error NotSoldOut();
    error ZeroAddress();
    error NothingBought();
    error Slippage();
    error TooExpensive();
    error ExceedsCurveSupply();
    error InsufficientValue();
    error NothingToClaim();
    error BuysTooMuch();

    constructor(InitParams memory p) {
        factory = p.factory;
        token = p.token;
        pairToken = p.pairToken;
        bag = p.bag;
        pot = p.pot;
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
        opener = p.opener;
        snipeTaxBps = p.snipeTaxBps;
        snipeDecaySeconds = p.snipeDecaySeconds;
        launchedAt = uint64(block.timestamp);
        restrictionsEndBlock = uint64(block.number) + p.restrictionBlocks;
        maxBuy = p.maxBuy;
        bytes32 slot = LAUNCH_TX_SLOT;
        assembly ("memory-safe") {
            tstore(slot, 1)
        }
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

    /// @notice What `pairIn` buys right now, for a caller who is not the launch itself. `fee`
    ///         includes the snipe surcharge while it lasts, as `pairSpent` does.
    function quoteBuy(uint256 pairIn) public view returns (uint256 tokensOut, uint256 pairSpent, uint256 fee) {
        if (phase != Phase.Curve) return (0, 0, 0);
        uint256 snipe = currentSnipeBps();
        uint256 afterSnipe = pairIn - Math.mulDiv(pairIn, snipe, BPS, Math.Rounding.Ceil);
        uint256 budget = afterSnipe - _feeOnGross(afterSnipe);
        tokensOut = CurveMath.tokensForPair(p0, p1, curveSupply, sold, budget, remaining());
        if (tokensOut == 0) return (0, 0, 0);
        uint256 net = CurveMath.cost(p0, p1, curveSupply, sold, tokensOut, true);
        uint256 spent = net + _feeOnNet(net);
        pairSpent = spent + _snipeOnNet(spent, snipe);
        fee = pairSpent - net;
    }

    function quoteBuyExactOut(uint256 tokensOut) public view returns (uint256 pairIn, uint256 fee) {
        uint256 net = CurveMath.cost(p0, p1, curveSupply, sold, tokensOut, true);
        uint256 spent = net + _feeOnNet(net);
        pairIn = spent + _snipeOnNet(spent, currentSnipeBps());
        fee = pairIn - net;
    }

    /// @notice The surcharge on a buy right now, in bps of what the buyer hands in. Quadratic, so
    ///         it is nearly gone half way through the window.
    function currentSnipeBps() public view returns (uint256) {
        uint256 window = snipeDecaySeconds;
        if (window == 0 || snipeTaxBps == 0) return 0;
        uint256 elapsed = block.timestamp - launchedAt;
        if (elapsed >= window) return 0;
        uint256 left = window - elapsed;
        return (uint256(snipeTaxBps) * left * left) / (window * window);
    }

    /// @notice Whether the current call is the launch transaction's own buy.
    function isLaunchBuy(address caller) public view returns (bool) {
        if (caller != factory && caller != opener) return false;
        bytes32 slot = LAUNCH_TX_SLOT;
        uint256 marked;
        assembly ("memory-safe") {
            marked := tload(slot)
        }
        return marked != 0;
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

        bool own = isLaunchBuy(msg.sender);
        uint256 snipe = own ? 0 : currentSnipeBps();
        uint256 afterSnipe = pairIn - Math.mulDiv(pairIn, snipe, BPS, Math.Rounding.Ceil);
        uint256 budget = afterSnipe - _feeOnGross(afterSnipe);
        tokensOut = CurveMath.tokensForPair(p0, p1, curveSupply, sold, budget, remaining());
        if (tokensOut == 0) revert NothingBought();
        if (tokensOut < minTokensOut) revert Slippage();
        if (!own) _checkWindow(to, tokensOut);

        uint256 net = CurveMath.cost(p0, p1, curveSupply, sold, tokensOut, true);
        uint256 spent = _settleBuy(net, tokensOut, to);
        // Charged on what was actually bought, so a buy the curve could only partly fill pays the
        // surcharge on the part it got and gets the rest back whole.
        uint256 penalty = _snipeOnNet(spent, snipe);
        // Rounding up can overshoot what the buyer handed in by a wei; never charge past it.
        if (penalty > pairIn - spent) penalty = pairIn - spent;
        if (penalty != 0) _takeSnipe(to, penalty);
        PairTransfer.push(pairToken, msg.sender, pairIn - spent - penalty);
        emit Bought(msg.sender, to, spent + penalty, tokensOut, spent + penalty - net);
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
        bool own = isLaunchBuy(msg.sender);
        if (!own) _checkWindow(to, tokensOut);

        uint256 net = CurveMath.cost(p0, p1, curveSupply, sold, tokensOut, true);
        uint256 spent = net + _feeOnNet(net);
        uint256 penalty = own ? 0 : _snipeOnNet(spent, currentSnipeBps());
        uint256 quoted = spent + penalty;
        if (quoted > maxPairIn) revert TooExpensive();

        if (pairToken == address(0)) {
            if (msg.value < quoted) revert InsufficientValue();
        } else {
            PairTransfer.pull(pairToken, msg.sender, quoted, msg.value);
        }

        pairSpent = _settleBuy(net, tokensOut, to) + penalty;
        if (penalty != 0) _takeSnipe(to, penalty);
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
    ///
    ///      The graduation fee is not booked: it goes into the Bag in this same call, and the Bag
    ///      pays a quarter of it (Confetti) into this launch's pot right here, so the holders who
    ///      bonded the curve are paid in the transaction that bonded it.
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
        if (graduationFee != 0) {
            IHoodBag(bag).takeGraduationFee{value: _forBag(graduationFee)}(pairToken, graduationFee, token, pot);
        }

        emit Graduated(tokenAmount, pairForLp, graduationFee);
    }

    /// @notice Permissionless. Pays the protocol's booked trade legs into the Bag pinned at
    ///         launch, less the referral leg the factory's registry names for this token, if any.
    /// @dev Pulled rather than pushed, for the reason in `_payFees`. The keeper calls it; if the
    ///      keeper dies anybody can, and until somebody does the money sits here untouched.
    ///
    ///      The registry is read through the factory and every failure on that road (no registry,
    ///      a registry with no code, a registry that reverts) means "no referral", so nothing the
    ///      owner points the factory at can hold this claim hostage. A referrer that REJECTS the
    ///      transfer does revert the claim, and only this launch's: the owner clears the referral
    ///      in the registry to unblock it.
    function claimProtocol() external nonReentrant returns (uint256 amount) {
        amount = protocolClaimable;
        uint256 penalties = penaltyClaimable;
        if (amount == 0 && penalties == 0) revert NothingToClaim();
        if (penalties != 0) {
            penaltyClaimable = 0;
            IHoodBag(bag).takePenaltyCut{value: _forBag(penalties)}(pairToken, penalties, token);
        }
        if (amount == 0) return 0;
        protocolClaimable = 0;
        (address referrer, uint256 cut) = _referral(amount);
        if (cut != 0) {
            PairTransfer.push(pairToken, referrer, cut);
            emit ReferralPaid(referrer, cut);
        }
        uint256 net = amount - cut;
        IHoodBag(bag).takeTradeFee{value: _forBag(net)}(pairToken, net, token);
        emit ProtocolClaimed(bag, net);
    }

    // ---------------------------------------------------------------- internals

    /// @dev The Bag's payment convention: native rides as value, an ERC-20 is approved and pulled.
    ///      Returns the value to attach and leaves the approval in place when the pair is a token.
    function _forBag(uint256 amount) internal returns (uint256 value) {
        if (pairToken == address(0)) return amount;
        IERC20(pairToken).forceApprove(bag, amount);
        return 0;
    }

    /// @dev The referral leg of `amount`, or (0, 0) whenever the registry cannot be read. A cut
    ///      larger than the amount, or one with nobody to pay, is a registry that lies and is
    ///      ignored the same way.
    function _referral(uint256 amount) internal view returns (address to, uint256 cut) {
        address registry;
        try IHoodFactory(factory).referrals() returns (address r) {
            registry = r;
        } catch {}
        if (registry == address(0) || registry.code.length == 0) return (address(0), 0);
        try IHoodReferrals(registry).split(token, amount) returns (address to_, uint256 cut_) {
            if (to_ == address(0) || cut_ > amount) return (address(0), 0);
            return (to_, cut_);
        } catch {}
    }

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

    /// @dev The surcharge that sits on top of `spent` so that it is `bps` of the whole.
    function _snipeOnNet(uint256 spent, uint256 bps) internal pure returns (uint256) {
        if (bps == 0 || spent == 0) return 0;
        return Math.mulDiv(spent, bps, BPS - bps, Math.Rounding.Ceil);
    }

    /// @dev The per-wallet buy cap. Keyed on the receiving wallet, cumulative over the window.
    function _checkWindow(address to, uint256 tokensOut) internal {
        uint256 cap = maxBuy;
        if (cap == 0 || block.number > restrictionsEndBlock) return;
        uint256 bought = boughtDuringWindow[to] + tokensOut;
        if (bought > cap) revert BuysTooMuch();
        boughtDuringWindow[to] = bought;
    }

    /// @dev 80% of the surcharge to this launch's holders now, 20% booked for the Bag. The pot is
    ///      this launch's own contract and books a deposit without calling out, so paying it inline
    ///      cannot hold a trade hostage; the Bag's share waits for `claimProtocol` like the fees.
    function _takeSnipe(address to, uint256 penalty) internal {
        uint256 toBag = (penalty * BagSplits.PENALTY_BAG_BPS) / BPS;
        uint256 toHolders = penalty - toBag;
        penaltyClaimable += toBag;
        if (toHolders != 0) {
            if (pairToken == address(0)) {
                IHoodPot(pot).depositForHolders{value: toHolders}(toHolders, BagReasons.SNIPE, to);
            } else {
                IERC20(pairToken).forceApprove(pot, toHolders);
                IHoodPot(pot).depositForHolders(toHolders, BagReasons.SNIPE, to);
            }
        }
        emit Sniped(msg.sender, to, penalty, toHolders, toBag);
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

    /// @dev The protocol's leg is BOOKED, not sent. Every trade calls this, so a Bag that could not
    ///      take a transfer (a paused outlet behind it, a blacklisted stablecoin address somewhere
    ///      down its chain) would otherwise stop every trade on every curve that names it, and the
    ///      address is an immutable. Nobody else's money may depend on the Bag accepting funds, so
    ///      `claimProtocol` pulls it instead.
    function _payFees(uint256 protocolFee, uint256 creatorFee) internal {
        protocolClaimable += protocolFee;
        if (creatorFee != 0) {
            PairTransfer.pushAndCall(
                pairToken, feeRouter, creatorFee, abi.encodeCall(IHoodFeeRouter.accrue, (token, creatorFee))
            );
        }
    }
}
