// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {BaseHook} from "@uniswap/v4-periphery/src/utils/BaseHook.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "@uniswap/v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {StateLibrary} from "@uniswap/v4-core/src/libraries/StateLibrary.sol";
import {BalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {BeforeSwapDelta, toBeforeSwapDelta} from "@uniswap/v4-core/src/types/BeforeSwapDelta.sol";
import {Currency, CurrencyLibrary} from "@uniswap/v4-core/src/types/Currency.sol";
import {PoolId, PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {SwapParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";

import {BagReasons, BagSplits, PenaltyConfig} from "../bag/BagTypes.sol";
import {IHoodBag} from "../interfaces/IHoodBag.sol";
import {IHoodCurve} from "../interfaces/IHoodCurve.sol";
import {IHoodFactory} from "../interfaces/IHoodFactory.sol";
import {IHoodFeeRouter} from "../interfaces/IHoodFeeRouter.sol";
import {IHoodPot} from "../interfaces/IHoodPot.sol";
import {IHoodStaking} from "../interfaces/IHoodStaking.sol";
import {PairTransfer} from "../libraries/PairTransfer.sol";

/// @title HoodGraduationHook
/// @notice The tax office of every graduated pool. One contract serves all of them: a v4 hook is
///         handed the PoolKey on every callback, so each pool has a row keyed by its PoolId, and the
///         graduator writes that row when it opens the pool. A pool with no row cannot trade.
/// @dev Two things happen on a swap, both in the quote (whichever currency of the pool is not the
///      launch token):
///
///      **The platform fee.** 1% of the quote side of every swap, 30 bps booked to the creator's leg
///      through the fee router and 70 bps into the Bag. It is not paid out on the swap that earned
///      it: the quote as a trade's INPUT has not been settled when the hook runs, so a tax on it
///      cannot leave the manager in the same breath (measured on a fork; see HoodLaunchHook). The
///      hook takes every fee as an ERC-6909 claim on the manager instead, per pool, and turns the
///      claims into money later: on the first swap of a pool after FLUSH_INTERVAL, or when anybody
///      calls `flushClaims`. Holding the fee as a claim on every shape, including the sell side
///      where it could be taken at once, keeps the swap path free of external calls: two pushes and
///      two calls once an hour per pool instead of on every trade, and a fee router or Bag that
///      cannot take the money can never stop a trade (the in-swap flush is a self-call whose
///      failure is caught). The tape still sees every fee: `Taxed` fires per swap.
///
///      **The penalties.** On a sell, the launch's PenaltyConfig: a jeet tax when the seller bought
///      inside `jeetWindowSeconds`, a whale tax when the sell moved the pool past `whaleTickLimit`
///      ticks. Each is 80% to that token's pot (or to the Vault, when the creator turned on
///      "lockers eat the jeets", or when the launch has no pot) and 20% into the Bag, paid out in
///      the same swap out of the quote the pool is paying the seller, with the seller as the payer
///      on the pot's books. `kingBps` is ignored here on purpose: the king pot is a feature of the
///      direct machine's hook, which holds the timer and the last buyer, and a graduated pool has
///      neither. A sell that asks for an exact amount of quote out is refused on a pool with
///      penalties (`ExactOutputSellRefused`): the whale tax depends on where the swap ends and an
///      afterSwap return can only charge the token side, which would be a tax in the wrong asset.
///      Exact-input sells, which is what every router sends, are served.
///
///      **Who bought.** A hook sees the router as `sender`, so buys and sells are matched by
///      `tx.origin`, recorded on buys and read on sells. A wallet behind a smart account or a
///      bundler is seen as the bundler, and a flipper who buys from one wallet and sells from
///      another is not caught. That is the limit of what a hook can know, and it is documented here
///      rather than hidden.
contract HoodGraduationHook is BaseHook, IUnlockCallback {
    using PoolIdLibrary for PoolKey;
    using StateLibrary for IPoolManager;
    using CurrencyLibrary for Currency;
    using SafeERC20 for IERC20;

    uint256 internal constant BPS = BagSplits.BPS;
    uint256 internal constant FEE_BPS = BagSplits.PLATFORM_FEE_BPS;
    /// @notice How long a pool's fee claims may sit before a swap on that pool flushes them.
    uint256 public constant FLUSH_INTERVAL = 1 hours;
    /// @dev Transient slot: the tick a sell started from, written in beforeSwap, read in afterSwap.
    ///      keccak256("HoodGraduationHook.tickBefore").
    uint256 internal constant TICK_BEFORE_SLOT = 0x8cba35dbb1d809a8ddaed52d48ef0ce175ddb0585d0f0367dc740e433fbf1df9;

    address public immutable factory;
    address public immutable bag;
    address public immutable feeRouter;
    address public immutable vault;

    /// @notice A graduated pool's row. The quote is whichever currency of the key is not `token`.
    struct Pool {
        address token;
        uint40 lastFlushAt;
        uint16 jeetTaxBps;
        uint16 whaleTaxBps;
        uint24 whaleTickLimit;
        address pot;
        uint32 jeetWindowSeconds;
        bool penaltiesToVault;
    }

    mapping(PoolId id => Pool) internal _pools;
    /// @notice Quote held as ERC-6909 claims for a pool, waiting to be flushed.
    mapping(PoolId id => uint256) public claimsHeld;
    /// @notice When a wallet (by tx.origin) last bought on a pool. Only kept on pools with a jeet tax.
    mapping(PoolId id => mapping(address origin => uint64)) public lastBuyAt;

    event PoolRegistered(PoolId indexed id, address indexed token, address indexed pot, PenaltyConfig penalties);
    event Taxed(PoolId indexed id, address indexed token, bool isBuy, uint256 fee, uint256 volume);
    event ClaimsFlushed(PoolId indexed id, address indexed token, uint256 toCreator, uint256 toBag);
    event Penalty(
        bytes32 indexed reason,
        address indexed payer,
        address indexed token,
        uint256 amount,
        uint256 toHolders,
        uint256 toBag
    );

    error NotGraduator();
    error NotRegistered();
    error AlreadyRegistered();
    error WrongHook();
    error TokenNotInPool();
    error BadPenalty();
    error ExactOutputSellRefused();
    error NotSelf();

    constructor(IPoolManager manager, address factory_, address bag_, address feeRouter_, address vault_)
        BaseHook(manager)
    {
        factory = factory_;
        bag = bag_;
        feeRouter = feeRouter_;
        vault = vault_;
    }

    /// @dev The manager pays native quote to the hook when claims and penalties are taken.
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
    /// @param penalties the launch's sell-side penalties, fixed at launch
    function register(PoolKey calldata key, address token, address pot, PenaltyConfig calldata penalties) external {
        if (!_isGraduator(msg.sender, token)) revert NotGraduator();
        if (address(key.hooks) != address(this)) revert WrongHook();
        if (Currency.unwrap(key.currency0) != token && Currency.unwrap(key.currency1) != token) {
            revert TokenNotInPool();
        }
        // Everything charged on a sell comes out of what the pool pays the seller, so it has to fit.
        if (uint256(penalties.jeetTaxBps) + penalties.whaleTaxBps + FEE_BPS > BPS) revert BadPenalty();
        PoolId id = key.toId();
        if (_pools[id].token != address(0)) revert AlreadyRegistered();

        _pools[id] = Pool({
            token: token,
            lastFlushAt: uint40(block.timestamp),
            jeetTaxBps: penalties.jeetTaxBps,
            whaleTaxBps: penalties.whaleTaxBps,
            whaleTickLimit: penalties.whaleTickLimit,
            pot: pot,
            jeetWindowSeconds: penalties.jeetWindowSeconds,
            penaltiesToVault: penalties.penaltiesToVault
        });
        emit PoolRegistered(id, token, pot, penalties);
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
        bool isBuy = tokenIsZero ? !params.zeroForOne : params.zeroForOne;

        if (!isBuy && (p.jeetTaxBps != 0 || p.whaleTaxBps != 0)) {
            if (!exactInput) revert ExactOutputSellRefused();
            if (p.whaleTaxBps != 0) {
                (, int24 tick,,) = poolManager.getSlot0(id);
                _setTickBefore(tick);
            }
        }

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

        if (isBuy && p.jeetTaxBps != 0) lastBuyAt[id][tx.origin] = uint64(block.timestamp);

        if (specifiedIsQuote) {
            // Taxed in beforeSwap, on the amount offered.
            uint256 offered = exactInput ? uint256(-params.amountSpecified) : uint256(params.amountSpecified);
            emit Taxed(id, token, isBuy, (offered * FEE_BPS) / BPS, moved);
            return (BaseHook.afterSwap.selector, 0);
        }

        // Past the line above the quote is the unspecified side: what the swapper pays in on an
        // exact-output buy, what the pool pays out on an exact-input sell. Both are taxed on the
        // pool's delta, and a sell also pays its penalties out of the same quote.
        uint256 fee = (moved * FEE_BPS) / BPS;
        if (fee != 0) _hold(id, quote, fee);
        uint256 taken = fee;
        if (!isBuy) taken += _penalties(id, p, quote, token, moved);
        emit Taxed(id, token, isBuy, fee, moved);
        // forge-lint: disable-next-line(unsafe-typecast)
        return (BaseHook.afterSwap.selector, int128(int256(taken)));
    }

    /// @dev Holds `fee` of `quote` as a claim: the hook is credited the same amount by the manager
    ///      once the swap is accounted, so the two cancel and the money stays in the manager.
    function _hold(PoolId id, Currency quote, uint256 fee) internal {
        poolManager.mint(address(this), quote.toId(), fee);
        claimsHeld[id] += fee;
    }

    // ---------------------------------------------------------------- penalties

    function _penalties(PoolId id, Pool storage p, Currency quote, address token, uint256 gross)
        internal
        returns (uint256 taken)
    {
        uint16 jeet = p.jeetTaxBps;
        if (jeet != 0) {
            uint64 last = lastBuyAt[id][tx.origin];
            if (last != 0 && block.timestamp < uint256(last) + p.jeetWindowSeconds) {
                taken += _penalty(p, quote, token, (gross * jeet) / BPS, BagReasons.JEET);
            }
        }
        uint16 whale = p.whaleTaxBps;
        if (whale != 0) {
            (, int24 tick,,) = poolManager.getSlot0(id);
            int256 movedTicks = int256(tick) - int256(_tickBefore());
            if (movedTicks < 0) movedTicks = -movedTicks;
            if (uint256(movedTicks) > p.whaleTickLimit) {
                taken += _penalty(p, quote, token, (gross * whale) / BPS, BagReasons.WHALE);
            }
        }
    }

    /// @dev A sell pays out of the pool, and that quote exists, so the penalty is taken and paid on
    ///      in the same swap: 80% to the holders' side, 20% into the Bag.
    function _penalty(Pool storage p, Currency quote, address token, uint256 amount, bytes32 reason)
        internal
        returns (uint256)
    {
        if (amount == 0) return 0;
        uint256 toHolders = (amount * BagSplits.PENALTY_HOLDERS_BPS) / BPS;
        uint256 toBag = amount - toHolders;
        address q = Currency.unwrap(quote);
        poolManager.take(quote, address(this), amount);

        address pot = p.pot;
        if (toHolders != 0) {
            if (p.penaltiesToVault || pot == address(0)) {
                PairTransfer.pushAndCall(
                    q, vault, toHolders, abi.encodeCall(IHoodStaking.notifyReward, (q, toHolders))
                );
            } else {
                _approve(q, pot, toHolders);
                IHoodPot(pot).depositForHolders{value: _value(q, toHolders)}(toHolders, reason, tx.origin);
            }
        }
        if (toBag != 0) {
            _approve(q, bag, toBag);
            IHoodBag(bag).takePenaltyCut{value: _value(q, toBag)}(q, toBag, token);
        }
        emit Penalty(reason, tx.origin, token, amount, toHolders, toBag);
        return amount;
    }

    // ---------------------------------------------------------------- claims

    /// @notice Permissionless. Turns a pool's held fee claims into money: 30 bps of the trade to the
    ///         fee router as the creator's leg, 70 bps into the Bag.
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

    function _setTickBefore(int24 tick) internal {
        int256 v = tick;
        assembly ("memory-safe") {
            tstore(TICK_BEFORE_SLOT, v)
        }
    }

    function _tickBefore() internal view returns (int24) {
        int256 v;
        assembly ("memory-safe") {
            v := tload(TICK_BEFORE_SLOT)
        }
        return int24(v);
    }
}
