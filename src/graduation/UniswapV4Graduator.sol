// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import {
    ExactInputSingleParams,
    IPermit2,
    IPoolManager,
    IPositionManager,
    IStateView,
    IUniversalRouter,
    PoolKey,
    SwapParams,
    V4Actions
} from "../interfaces/IExternal.sol";
import {IGraduationHandler} from "../interfaces/IGraduationHandler.sol";
import {IHoodFactory} from "../interfaces/IHoodFactory.sol";
import {IHoodFeeRouter} from "../interfaces/IHoodFeeRouter.sol";
import {IHoodToken} from "../interfaces/IHoodToken.sol";
import {PairTransfer} from "../libraries/PairTransfer.sol";
import {Launch} from "../HoodTypes.sol";
import {PenaltyConfig} from "../bag/BagTypes.sol";

/// @notice The one hook every graduated pool trades through (HoodGraduationHook), declared against
///         this file's own PoolKey, which encodes exactly like v4-core's.
interface IHoodGraduationHook {
    function register(PoolKey calldata key, address token, address pot, PenaltyConfig calldata penalties) external;
}

/// @notice What a launch's pot lets the graduation handler do: keep the pool's own addresses out of
///         the holder count, so the supply sitting in the pool never earns what holders are paid.
interface IHoodPotExclude {
    function exclude(address who) external;
}

/// @title UniswapV4Graduator
/// @notice Turns a sold-out curve into a Uniswap v4 pool and keeps the position forever.
/// @dev The position NFT never leaves this contract and this contract has no transfer function and
///      no way to decrease liquidity. The only thing anybody can do with it is collect the fees it
///      earned, which go straight back into the token's fee split. That is the whole point:
///      graduated liquidity is locked, and the lock is the absence of code, not a promise.
///
///      Every pool it opens names the graduation hook, which takes the platform fee and the sell-side
///      penalties on every swap. The hook is named once, by the factory owner, and cannot be changed
///      after that; until it is named no pool can be opened, so no launch runs without it.
contract UniswapV4Graduator is IGraduationHandler, ReentrancyGuard {
    using SafeERC20 for IERC20;

    /// @dev Full range, clamped to the widest tick the spacing allows.
    int24 internal constant MAX_TICK = 887272;
    uint160 internal constant MIN_SQRT_PRICE = 4295128739;
    uint160 internal constant MAX_SQRT_PRICE = 1461446703485210103287273052203988822378723970342;
    uint256 internal constant Q96 = 1 << 96;
    /// @dev How far the pool's price may sit from the ratio actually raised and still be minted
    ///      into as it stands: a fortieth of the square root, so about five percent of the price.
    uint256 internal constant PRICE_BAND = 40;
    /// @notice How much of the in-range liquidity a donation lands on may belong to somebody other
    ///         than this token's locked position: one part in a thousand.
    uint256 internal constant STRANGER_TOLERANCE_BPS = 10;

    uint8 internal constant ACTION_DONATE = 0;
    uint8 internal constant ACTION_RESET_PRICE = 1;

    IHoodFactory public immutable factory;
    IPoolManager public immutable poolManager;
    IPositionManager public immutable positionManager;
    IUniversalRouter public immutable universalRouter;
    IPermit2 public immutable permit2;
    IStateView public immutable stateView;
    /// @notice The graduation hook every pool opened here trades through. Set once, then fixed.
    address public hook;

    struct Position {
        PoolKey key;
        uint256 tokenId;
        bool exists;
    }

    mapping(address token => Position) internal _positions;

    event PoolOpened(
        address indexed token, address indexed pairToken, uint256 tokenId, uint160 sqrtPriceX96, uint128 liquidity
    );
    event FeesCollected(address indexed token, uint256 pairAmount, uint256 tokenBurned);
    event Compounded(address indexed token, uint256 pairAmount);
    event BoughtBack(address indexed token, uint256 pairSpent, uint256 burned);
    event HookSet(address indexed hook);
    /// @notice The pot would not take the exclusion. Graduation goes on; the pot needs a look.
    event PotExcludeFailed(address indexed token, address indexed pot, address who);

    error NotOwner();
    error HookAlreadySet();
    error HookNotSet();
    error NotACurve();
    error AlreadyGraduated();
    error NotGraduated();
    error NothingToDo();
    error FundsNotReceived();
    error NotPoolManager();
    error NotFactory();
    error NotSelf();
    error BadPrice();
    error PoolPriceMoved();
    error NotAloneInRange();

    constructor(
        address factory_,
        address poolManager_,
        address positionManager_,
        address universalRouter_,
        address permit2_,
        address stateView_
    ) {
        factory = IHoodFactory(factory_);
        poolManager = IPoolManager(poolManager_);
        positionManager = IPositionManager(positionManager_);
        universalRouter = IUniversalRouter(universalRouter_);
        permit2 = IPermit2(permit2_);
        stateView = IStateView(stateView_);
    }

    /// @notice Names the graduation hook, once.
    /// @dev A setter rather than a constructor argument so the deploy order stays free: a v4 hook's
    ///      address has to be mined against its own creation code, which does not depend on this
    ///      contract, and nothing that constructs this contract has to change to carry it. There is
    ///      no way to change it afterwards, and `_key` refuses to build a key without it.
    function setHook(address hook_) external {
        if (msg.sender != factory.owner()) revert NotOwner();
        if (hook != address(0)) revert HookAlreadySet();
        if (hook_ == address(0)) revert HookNotSet();
        hook = hook_;
        emit HookSet(hook_);
    }

    /// @inheritdoc IGraduationHandler
    function prepare(
        address token,
        address pairToken,
        uint256 tokenAmount,
        uint256 pairAmount,
        uint24 poolFee,
        int24 tickSpacing
    ) external {
        if (msg.sender != address(factory)) revert NotFactory();
        PoolKey memory key = _key(token, pairToken, poolFee, tickSpacing);
        if (_currentPrice(key) != 0) return;
        (uint256 amount0, uint256 amount1) =
            key.currency0 == token ? (tokenAmount, pairAmount) : (pairAmount, tokenAmount);
        poolManager.initialize(key, _sqrtPriceFor(amount0, amount1));
    }

    receive() external payable {}

    function isGraduated(address token) external view returns (bool) {
        return _positions[token].exists;
    }

    function positionOf(address token) external view returns (PoolKey memory key, uint256 tokenId) {
        Position memory p = _positions[token];
        return (p.key, p.tokenId);
    }

    // ---------------------------------------------------------------- graduation

    /// @inheritdoc IGraduationHandler
    function graduate(
        address token,
        address pairToken,
        uint256 tokenAmount,
        uint256 pairAmount,
        uint24 poolFee,
        int24 tickSpacing
    ) external payable nonReentrant {
        Launch memory l = factory.getLaunch(token);
        if (l.curve != msg.sender) revert NotACurve();
        if (_positions[token].exists) revert AlreadyGraduated();
        if (tokenAmount == 0 || pairAmount == 0) revert NothingToDo();
        if (pairToken == address(0) && msg.value != pairAmount) revert FundsNotReceived();

        PoolKey memory key = _key(token, pairToken, poolFee, tickSpacing);
        // Before anything touches the pool: the price walk below is a swap, and the hook refuses a
        // swap on a pool it has no row for.
        _register(token, key, l.pot);
        bool tokenIsZero = key.currency0 == token;
        (uint256 amount0, uint256 amount1) =
            tokenIsZero ? (tokenAmount, pairAmount) : (pairAmount, tokenAmount);

        // The pool was opened at launch, at the price this raise was heading for, so that nobody
        // could open it first at a price of their own. That is not enough on its own: until this
        // call the pool holds NO liquidity, and a swap in an empty pool consumes nothing and moves
        // the price to whatever limit it is given. Anybody could therefore walk the price to any
        // tick for the cost of gas, and minting into it as it stands would put the supply and the
        // raise wherever they left it. So the price is pinned to the ratio actually raised.
        uint160 expected = _sqrtPriceFor(amount0, amount1);
        uint160 sqrtPriceX96 = _currentPrice(key);
        if (sqrtPriceX96 == 0) {
            sqrtPriceX96 = expected;
            poolManager.initialize(key, expected);
        } else if (sqrtPriceX96 != expected) {
            // Free while the pool is empty, which is the only state it can be in here unless
            // somebody has put real money in it. If they have, their price is accepted as long as
            // it is close to ours; further out than that is a price nobody should mint into, and
            // the raise waits in the curve until somebody trades it back (anybody can, and a
            // mispriced position pays whoever does).
            if (_tryResetPrice(key, expected)) sqrtPriceX96 = expected;
            else if (!_withinBand(sqrtPriceX96, expected)) revert PoolPriceMoved();
        }

        (int24 tickLower, int24 tickUpper) = _fullRange(tickSpacing);
        uint128 liquidity = _liquidityFor(sqrtPriceX96, amount0, amount1);

        _approveForPositionManager(token, tokenAmount);
        if (pairToken != address(0)) _approveForPositionManager(pairToken, pairAmount);

        uint256 tokenId = positionManager.nextTokenId();
        bytes memory actions;
        bytes[] memory params;
        if (pairToken == address(0)) {
            actions = abi.encodePacked(V4Actions.MINT_POSITION, V4Actions.SETTLE_PAIR, V4Actions.SWEEP);
            params = new bytes[](3);
            params[2] = abi.encode(address(0), address(this));
        } else {
            actions = abi.encodePacked(V4Actions.MINT_POSITION, V4Actions.SETTLE_PAIR);
            params = new bytes[](2);
        }
        params[0] = abi.encode(key, tickLower, tickUpper, liquidity, amount0, amount1, address(this), bytes(""));
        params[1] = abi.encode(key.currency0, key.currency1);

        positionManager.modifyLiquidities{value: pairToken == address(0) ? pairAmount : 0}(
            abi.encode(actions, params), block.timestamp
        );

        _positions[token] = Position({key: key, tokenId: tokenId, exists: true});
        _sweepLeftovers(token, pairToken);
        emit PoolOpened(token, pairToken, tokenId, sqrtPriceX96, liquidity);
    }

    /// @dev Writes the pool's row in the hook (token, pot, the launch's penalties) and keeps the
    ///      pool manager and the hook out of the pot's holder count: the pool's reserves are most of
    ///      the supply, and a pot that counted them would book most of every deposit to an address
    ///      that never claims. A pot that refuses the exclusion cannot hold the raise hostage in the
    ///      curve, so that failure is an event rather than a revert.
    function _register(address token, PoolKey memory key, address pot) internal {
        IHoodGraduationHook(hook).register(key, token, pot, factory.penaltiesOf(token));
        if (pot == address(0)) return;
        _exclude(token, pot, address(poolManager));
        _exclude(token, pot, hook);
    }

    function _exclude(address token, address pot, address who) internal {
        try IHoodPotExclude(pot).exclude(who) {}
        catch {
            emit PotExcludeFailed(token, pot, who);
        }
    }

    /// @inheritdoc IGraduationHandler
    /// @dev Permissionless: the pair side goes back into the token's fee split, the token side is burned.
    function collect(address token) external nonReentrant {
        Position memory pos = _positions[token];
        if (!pos.exists) revert NotGraduated();
        Launch memory l = factory.getLaunch(token);

        bytes memory actions = abi.encodePacked(V4Actions.DECREASE_LIQUIDITY, V4Actions.TAKE_PAIR);
        bytes[] memory params = new bytes[](2);
        params[0] = abi.encode(pos.tokenId, uint256(0), uint256(0), uint256(0), bytes(""));
        params[1] = abi.encode(pos.key.currency0, pos.key.currency1, address(this));
        positionManager.modifyLiquidities(abi.encode(actions, params), block.timestamp);

        uint256 pairAmount = PairTransfer.balance(l.pairToken, address(this));
        uint256 tokenAmount = IERC20(token).balanceOf(address(this));
        if (pairAmount == 0 && tokenAmount == 0) revert NothingToDo();

        if (tokenAmount != 0) IHoodToken(token).burn(tokenAmount);
        if (pairAmount != 0) {
            PairTransfer.pushAndCall(
                l.pairToken,
                factory.feeRouter(),
                pairAmount,
                abi.encodeCall(IHoodFeeRouter.accrue, (token, pairAmount))
            );
        }
        emit FeesCollected(token, pairAmount, tokenAmount);
    }

    /// @inheritdoc IGraduationHandler
    /// @dev Pair-only funds cannot mint liquidity on their own, so they are donated to the pool.
    ///      v4 credits a donation to whoever is in range, and the locked full-range position is in
    ///      range at every price, so this deepens the very liquidity the token graduated into.
    ///      It goes through the PoolManager directly: the PositionManager rejects DONATE with
    ///      UnsupportedAction, which is measured, not assumed (see test/ForkV4.t.sol).
    function compound(address token, uint256 amount) external payable nonReentrant {
        Position memory pos = _positions[token];
        if (!pos.exists) revert NotGraduated();
        Launch memory l = factory.getLaunch(token);
        // A donation is credited to whatever liquidity is in range at that instant, which Uniswap
        // warns about on `donate` itself: a bot mints a narrow position on the current tick, calls
        // this, takes its share and burns the position again, inside one transaction. So this only
        // donates onto the locked position when the locked position is all that is in range.
        if (!canCompound(token)) revert NotAloneInRange();
        _receivePair(l.pairToken, amount);

        bool pairIsZero = pos.key.currency0 == l.pairToken;
        poolManager.unlock(
            abi.encode(
                ACTION_DONATE,
                abi.encode(pos.key, pairIsZero ? amount : 0, pairIsZero ? 0 : amount, l.pairToken, amount)
            )
        );
        emit Compounded(token, amount);
    }

    /// @notice Whether a donation right now would land on this token's locked position alone.
    function canCompound(address token) public view returns (bool) {
        Position memory pos = _positions[token];
        if (!pos.exists) return false;
        uint128 mine = positionManager.getPositionLiquidity(pos.tokenId);
        if (mine == 0) return false;
        uint128 active = stateView.getLiquidity(keccak256(abi.encode(pos.key)));
        return active >= mine && uint256(active) <= uint256(mine) + (uint256(mine) * STRANGER_TOLERANCE_BPS) / 10_000;
    }

    /// @notice The PoolManager calls this back inside `compound` and `resetPrice`. Nothing else
    ///         can reach it.
    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        if (msg.sender != address(poolManager)) revert NotPoolManager();
        (uint8 action, bytes memory payload) = abi.decode(data, (uint8, bytes));

        if (action == ACTION_RESET_PRICE) {
            (PoolKey memory key, uint160 target) = abi.decode(payload, (PoolKey, uint160));
            // One wei of exact input, with the target as the limit. An empty pool fills none of it
            // and lands exactly on the limit; a pool with liquidity anywhere along the way either
            // stops short or takes the wei, and both of those are a refusal rather than a fix.
            int256 delta = poolManager.swap(
                key,
                SwapParams({
                    zeroForOne: _currentPrice(key) > target,
                    amountSpecified: -1,
                    sqrtPriceLimitX96: target
                }),
                bytes("")
            );
            if (delta != 0 || _currentPrice(key) != target) revert PoolPriceMoved();
            return bytes("");
        }

        (PoolKey memory key_, uint256 amount0, uint256 amount1, address currency, uint256 amount) =
            abi.decode(payload, (PoolKey, uint256, uint256, address, uint256));

        poolManager.donate(key_, amount0, amount1, bytes(""));
        if (currency == address(0)) {
            poolManager.settle{value: amount}();
        } else {
            poolManager.sync(currency);
            IERC20(currency).safeTransfer(address(poolManager), amount);
            poolManager.settle();
        }
        return bytes("");
    }

    /// @notice Only this contract calls it, and only through `_tryResetPrice`, which is what makes
    ///         the failure recoverable: the try/catch needs a real external call to catch.
    function resetPrice(PoolKey calldata key, uint160 target) external {
        if (msg.sender != address(this)) revert NotSelf();
        poolManager.unlock(abi.encode(ACTION_RESET_PRICE, abi.encode(key, target)));
    }

    function _tryResetPrice(PoolKey memory key, uint160 target) internal returns (bool) {
        try this.resetPrice(key, target) {
            return true;
        } catch {
            return false;
        }
    }

    function _withinBand(uint160 current, uint160 expected) internal pure returns (bool) {
        uint256 slack = uint256(expected) / PRICE_BAND;
        return current + slack >= expected && current <= uint256(expected) + slack;
    }

    /// @inheritdoc IGraduationHandler
    function buyback(address token, uint256 amount, uint256 minTokensOut)
        external
        payable
        nonReentrant
        returns (uint256 burned)
    {
        Position memory pos = _positions[token];
        if (!pos.exists) revert NotGraduated();
        Launch memory l = factory.getLaunch(token);
        _receivePair(l.pairToken, amount);

        bool zeroForOne = pos.key.currency0 == l.pairToken;
        if (l.pairToken != address(0)) {
            IERC20(l.pairToken).forceApprove(address(permit2), amount);
            permit2.approve(l.pairToken, address(universalRouter), uint160(amount), uint48(block.timestamp + 1));
        }

        bytes memory actions =
            abi.encodePacked(V4Actions.SWAP_EXACT_IN_SINGLE, V4Actions.SETTLE_ALL, V4Actions.TAKE_ALL);
        bytes[] memory params = new bytes[](3);
        params[0] = abi.encode(
            ExactInputSingleParams({
                poolKey: pos.key,
                zeroForOne: zeroForOne,
                amountIn: uint128(amount),
                amountOutMinimum: uint128(minTokensOut),
                minHopPriceX36: 0,
                hookData: bytes("")
            })
        );
        params[1] = abi.encode(l.pairToken, amount);
        params[2] = abi.encode(token, minTokensOut);

        bytes memory commands = abi.encodePacked(V4Actions.CMD_V4_SWAP);
        bytes[] memory inputs = new bytes[](1);
        inputs[0] = abi.encode(actions, params);

        universalRouter.execute{value: l.pairToken == address(0) ? amount : 0}(commands, inputs, block.timestamp);

        burned = IERC20(token).balanceOf(address(this));
        if (burned == 0) revert NothingToDo();
        IHoodToken(token).burn(burned);
        emit BoughtBack(token, amount, burned);
    }

    // ---------------------------------------------------------------- internals

    /// @dev The liquidity maths asks for slightly less than we hold, so a sliver of both sides is
    ///      left over. It does not sit here: the token side is burned and the pair side goes into
    ///      the token's own fee split. No balance in this contract is ever somebody's to take.
    function _sweepLeftovers(address token, address pairToken) internal {
        uint256 tokenLeft = IERC20(token).balanceOf(address(this));
        if (tokenLeft != 0) IHoodToken(token).burn(tokenLeft);

        uint256 pairLeft = PairTransfer.balance(pairToken, address(this));
        if (pairLeft != 0) {
            PairTransfer.pushAndCall(
                pairToken, factory.feeRouter(), pairLeft, abi.encodeCall(IHoodFeeRouter.accrue, (token, pairLeft))
            );
        }
    }

    function _key(address token, address pairToken, uint24 poolFee, int24 tickSpacing)
        internal
        view
        returns (PoolKey memory)
    {
        address h = hook;
        if (h == address(0)) revert HookNotSet();
        (address c0, address c1) = pairToken < token ? (pairToken, token) : (token, pairToken);
        return PoolKey({currency0: c0, currency1: c1, fee: poolFee, tickSpacing: tickSpacing, hooks: h});
    }

    function _currentPrice(PoolKey memory key) internal view returns (uint160 sqrtPriceX96) {
        (sqrtPriceX96,,,) = stateView.getSlot0(keccak256(abi.encode(key)));
    }

    /// @dev Bounds checked rather than cast: a ratio outside v4's own price range would wrap the
    ///      cast and open (or reprice) a pool at a number nobody meant.
    function _sqrtPriceFor(uint256 amount0, uint256 amount1) internal pure returns (uint160) {
        uint256 sqrtPrice = Math.sqrt(Math.mulDiv(amount1, Q96 * Q96, amount0));
        if (sqrtPrice <= MIN_SQRT_PRICE || sqrtPrice >= MAX_SQRT_PRICE) revert BadPrice();
        return uint160(sqrtPrice);
    }

    function _fullRange(int24 tickSpacing) internal pure returns (int24 lower, int24 upper) {
        upper = (MAX_TICK / tickSpacing) * tickSpacing;
        lower = -upper;
    }

    /// @dev Full-range liquidity from both sides, taking the smaller one. The exact formulas carry
    ///      a factor of sqrtUpper / (sqrtUpper - sqrtP) and 1 / (1 - sqrtLower / sqrtP); at full
    ///      range both are 1 to within a rounding error and dropping them can only ASK FOR LESS
    ///      than we hold, never more, so the mint can never fail on a missing wei.
    function _liquidityFor(uint160 sqrtPriceX96, uint256 amount0, uint256 amount1)
        internal
        pure
        returns (uint128)
    {
        uint256 l0 = Math.mulDiv(amount0, sqrtPriceX96, Q96);
        uint256 l1 = Math.mulDiv(amount1, Q96, sqrtPriceX96);
        uint256 l = l0 < l1 ? l0 : l1;
        // One part in a million of headroom for the dropped factors above.
        l -= l / 1_000_000;
        return uint128(l);
    }

    function _receivePair(address pairToken, uint256 amount) internal {
        if (pairToken == address(0)) {
            if (msg.value != amount) revert FundsNotReceived();
        } else {
            IERC20(pairToken).safeTransferFrom(msg.sender, address(this), amount);
        }
    }

    function _approveForPositionManager(address erc20, uint256 amount) internal {
        IERC20(erc20).forceApprove(address(permit2), amount);
        permit2.approve(erc20, address(positionManager), uint160(amount), uint48(block.timestamp + 1));
    }
}
