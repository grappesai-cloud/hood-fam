// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {BaseHook} from "@uniswap/v4-periphery/src/utils/BaseHook.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "@uniswap/v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {BalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {BeforeSwapDelta, toBeforeSwapDelta} from "@uniswap/v4-core/src/types/BeforeSwapDelta.sol";
import {Currency, CurrencyLibrary} from "@uniswap/v4-core/src/types/Currency.sol";
import {PoolId, PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {SwapParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";

import {BagSplits} from "../bag/BagTypes.sol";
import {IHoodBag} from "../interfaces/IHoodBag.sol";
import {IHoodCurve} from "../interfaces/IHoodCurve.sol";
import {IHoodFactory} from "../interfaces/IHoodFactory.sol";
import {IHoodFeeRouter} from "../interfaces/IHoodFeeRouter.sol";
import {PairTransfer} from "../libraries/PairTransfer.sol";

/// @title HoodGraduationHook
/// @notice The tax office of every graduated pool. One contract serves all of them: a v4 hook is
///         handed the PoolKey on every callback, so each pool has a row keyed by its PoolId, and the
///         graduator writes that row when it opens the pool. A pool with no row cannot trade.
/// @dev One thing happens on a swap, in the quote (whichever currency of the pool is not the
///      launch token): **the platform fee.** 1% of the quote side of every swap, 70 bps booked to
///      the creator's leg through the fee router and 30 bps into the Bag. It is not paid out on the
///      swap that earned it: the quote as a trade's INPUT has not been settled when the hook runs,
///      so a tax on it cannot leave the manager in the same breath (measured on a fork; see
///      HoodLaunchHook). The hook takes every fee as an ERC-6909 claim on the manager instead, per
///      pool, and turns the claims into money later: on the first swap of a pool after
///      FLUSH_INTERVAL, or when anybody calls `flushClaims`. Holding the fee as a claim on every
///      shape, including the sell side where it could be taken at once, keeps the swap path free of
///      external calls: two pushes and two calls once an hour per pool instead of on every trade,
///      and a fee router or Bag that cannot take the money can never stop a trade (the in-swap
///      flush is a self-call whose failure is caught). The tape still sees every fee: `Taxed` fires
///      per swap. There are no sell penalties: a graduated pool charges the fee and nothing else.
contract HoodGraduationHook is BaseHook, IUnlockCallback {
    using PoolIdLibrary for PoolKey;
    using CurrencyLibrary for Currency;
    using SafeERC20 for IERC20;

    uint256 internal constant BPS = BagSplits.BPS;
    uint256 internal constant FEE_BPS = BagSplits.PLATFORM_FEE_BPS;
    /// @notice How long a pool's fee claims may sit before a swap on that pool flushes them.
    uint256 public constant FLUSH_INTERVAL = 1 hours;

    address public immutable factory;
    address public immutable bag;
    address public immutable feeRouter;

    /// @notice A graduated pool's row. The quote is whichever currency of the key is not `token`.
    struct Pool {
        address token;
        uint40 lastFlushAt;
        address pot;
    }

    mapping(PoolId id => Pool) internal _pools;
    /// @notice Quote held as ERC-6909 claims for a pool, waiting to be flushed.
    mapping(PoolId id => uint256) public claimsHeld;

    event PoolRegistered(PoolId indexed id, address indexed token, address indexed pot);
    event Taxed(PoolId indexed id, address indexed token, bool isBuy, uint256 fee, uint256 volume);
    event ClaimsFlushed(PoolId indexed id, address indexed token, uint256 toCreator, uint256 toBag);

    error NotGraduator();
    error NotRegistered();
    error AlreadyRegistered();
    error WrongHook();
    error TokenNotInPool();
    error NotSelf();

    constructor(IPoolManager manager, address factory_, address bag_, address feeRouter_) BaseHook(manager) {
        factory = factory_;
        bag = bag_;
        feeRouter = feeRouter_;
    }

    /// @dev The manager pays native quote to the hook when claims are taken.
    receive() external payable {}

    function getHookPermissions() public pure override returns (Hooks.Permissions memory) {
        return Hooks.Permissions({
            beforeInitialize: false,
            afterInitialize: false,
            beforeAddLiquidity: false,
            afterAddLiquidity: false,
            beforeRemoveLiquidity: false,
            afterRemoveLiquidity: false,
            beforeSwap: true,
            afterSwap: true,
            beforeDonate: false,
            afterDonate: false,
            beforeSwapReturnDelta: true,
            afterSwapReturnDelta: true,
            afterAddLiquidityReturnDelta: false,
            afterRemoveLiquidityReturnDelta: false
        });
    }

    // ---------------------------------------------------------------- registration

    /// @notice Writes a graduated pool's row. Graduator only, once per pool.
    /// @param key the pool, which must name this hook and contain `token`
    /// @param token the launch token; the other currency is the quote every fee is paid in
    /// @param pot the launch's pot (IHoodPot), or zero for a launch without one
    function register(PoolKey calldata key, address token, address pot) external {
        if (!_isGraduator(msg.sender, token)) revert NotGraduator();
        if (address(key.hooks) != address(this)) revert WrongHook();
        if (Currency.unwrap(key.currency0) != token && Currency.unwrap(key.currency1) != token) {
            revert TokenNotInPool();
        }
        PoolId id = key.toId();
        if (_pools[id].token != address(0)) revert AlreadyRegistered();

        _pools[id] = Pool({token: token, lastFlushAt: uint40(block.timestamp), pot: pot});
        emit PoolRegistered(id, token, pot);
    }

    function poolOf(PoolId id) external view returns (Pool memory) {
        return _pools[id];
    }

    /// @dev The factory's current handler, or the handler a curve was born with: a curve pins its
    ///      handler at launch, so a launch from before the handler was rotated still graduates.
    function _isGraduator(address who, address token) internal view returns (bool) {
        if (who == IHoodFactory(factory).graduationHandler()) return true;
        address curve = IHoodFactory(factory).getLaunch(token).curve;
        return curve != address(0) && who == IHoodCurve(curve).graduationHandler();
    }

    // ---------------------------------------------------------------- swaps

    function _beforeSwap(address, PoolKey calldata key, SwapParams calldata params, bytes calldata)
        internal
        override
        returns (bytes4, BeforeSwapDelta, uint24)
    {
        PoolId id = key.toId();
        Pool storage p = _pools[id];
        address token = p.token;
        if (token == address(0)) revert NotRegistered();

        // Everything held from earlier swaps was settled long ago, which makes this the one place a
        // flush is always safe. The clock advances whether or not the flush goes through, so a sink
        // that refuses the money is retried once an interval, not once a swap.
        if (block.timestamp - p.lastFlushAt >= FLUSH_INTERVAL) {
            p.lastFlushAt = uint40(block.timestamp);
            if (claimsHeld[id] != 0) {
                try this.realizeClaims(key) {} catch {}
            }
        }

        bool tokenIsZero = Currency.unwrap(key.currency0) == token;
        bool exactInput = params.amountSpecified < 0;

        // The specified side is currency0 when exact input and zeroForOne agree. Only the case where
        // that side is the quote is taxed here (an exact-input buy, an exact-output sell); the
        // other two shapes are taxed in afterSwap, where the quote is the unspecified side.
        bool specifiedIsQuote = (exactInput == params.zeroForOne) != tokenIsZero;
        if (!specifiedIsQuote) return (BaseHook.beforeSwap.selector, toBeforeSwapDelta(0, 0), 0);

        uint256 amount = exactInput ? uint256(-params.amountSpecified) : uint256(params.amountSpecified);
        uint256 fee = (amount * FEE_BPS) / BPS;
        if (fee == 0) return (BaseHook.beforeSwap.selector, toBeforeSwapDelta(0, 0), 0);

        _hold(id, tokenIsZero ? key.currency1 : key.currency0, fee);
        // forge-lint: disable-next-line(unsafe-typecast)
        return (BaseHook.beforeSwap.selector, toBeforeSwapDelta(int128(int256(fee)), 0), 0);
    }

    function _afterSwap(address, PoolKey calldata key, SwapParams calldata params, BalanceDelta delta, bytes calldata)
        internal
        override
        returns (bytes4, int128)
    {
        PoolId id = key.toId();
        Pool storage p = _pools[id];
        // The manager calls both halves or neither, and beforeSwap already refused an unknown pool.
        address token = p.token;
        bool tokenIsZero = Currency.unwrap(key.currency0) == token;
        bool exactInput = params.amountSpecified < 0;
        bool isBuy = tokenIsZero ? !params.zeroForOne : params.zeroForOne;
        bool specifiedIsQuote = (exactInput == params.zeroForOne) != tokenIsZero;
        Currency quote = tokenIsZero ? key.currency1 : key.currency0;

        // Volume is what the pool itself moved in the quote, read off its delta: a binding price
        // limit can leave part of an exact-input order unfilled, and an empty pool moves nothing.
        int128 quoteDelta = tokenIsZero ? delta.amount1() : delta.amount0();
        uint256 moved = quoteDelta < 0 ? uint256(uint128(-quoteDelta)) : uint256(uint128(quoteDelta));
        if (moved == 0) return (BaseHook.afterSwap.selector, 0);

        if (specifiedIsQuote) {
            // Taxed in beforeSwap, on the amount offered.
            uint256 offered = exactInput ? uint256(-params.amountSpecified) : uint256(params.amountSpecified);
            emit Taxed(id, token, isBuy, (offered * FEE_BPS) / BPS, moved);
            return (BaseHook.afterSwap.selector, 0);
        }

        // Past the line above the quote is the unspecified side: what the swapper pays in on an
        // exact-output buy, what the pool pays out on an exact-input sell. Both are taxed on the
        // pool's delta.
        uint256 fee = (moved * FEE_BPS) / BPS;
        if (fee != 0) _hold(id, quote, fee);
        emit Taxed(id, token, isBuy, fee, moved);
        // forge-lint: disable-next-line(unsafe-typecast)
        return (BaseHook.afterSwap.selector, int128(int256(fee)));
    }

    /// @dev Holds `fee` of `quote` as a claim: the hook is credited the same amount by the manager
    ///      once the swap is accounted, so the two cancel and the money stays in the manager.
    function _hold(PoolId id, Currency quote, uint256 fee) internal {
        poolManager.mint(address(this), quote.toId(), fee);
        claimsHeld[id] += fee;
    }

    // ---------------------------------------------------------------- claims

    /// @notice Permissionless. Turns a pool's held fee claims into money: 70 bps of the trade to the
    ///         fee router as the creator's leg, 30 bps into the Bag.
    function flushClaims(PoolKey calldata key) external {
        if (claimsHeld[key.toId()] == 0) return;
        poolManager.unlock(abi.encode(key));
    }

    function unlockCallback(bytes calldata data) external onlyPoolManager returns (bytes memory) {
        _realize(abi.decode(data, (PoolKey)));
        return bytes("");
    }

    /// @notice Only this contract calls it, from inside a swap, where the manager is already
    ///         unlocked. External so that its failure can be caught and the swap go on.
    function realizeClaims(PoolKey calldata key) external {
        if (msg.sender != address(this)) revert NotSelf();
        _realize(key);
    }

    function _realize(PoolKey memory key) internal {
        PoolId id = key.toId();
        address token = _pools[id].token;
        if (token == address(0)) revert NotRegistered();
        uint256 amount = claimsHeld[id];
        if (amount == 0) return;
        claimsHeld[id] = 0;

        Currency quote = Currency.unwrap(key.currency0) == token ? key.currency1 : key.currency0;
        poolManager.burn(address(this), quote.toId(), amount);
        poolManager.take(quote, address(this), amount);

        uint256 toCreator = (amount * BagSplits.PLATFORM_CREATOR_BPS) / BagSplits.PLATFORM_FEE_BPS;
        uint256 toBag = amount - toCreator;
        address q = Currency.unwrap(quote);
        if (toCreator != 0) {
            PairTransfer.pushAndCall(
                q, feeRouter, toCreator, abi.encodeCall(IHoodFeeRouter.accrue, (token, toCreator))
            );
        }
        if (toBag != 0) {
            _approve(q, bag, toBag);
            IHoodBag(bag).takeTradeFee{value: _value(q, toBag)}(q, toBag, token);
        }
        emit ClaimsFlushed(id, token, toCreator, toBag);
    }

    // ---------------------------------------------------------------- internals

    function _approve(address asset, address spender, uint256 amount) internal {
        if (asset != address(0)) IERC20(asset).forceApprove(spender, amount);
    }

    function _value(address asset, uint256 amount) internal pure returns (uint256) {
        return asset == address(0) ? amount : 0;
    }
}
