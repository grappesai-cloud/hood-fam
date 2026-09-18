// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {BaseHook} from "@uniswap/v4-periphery/src/utils/BaseHook.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {Currency, CurrencyLibrary} from "@uniswap/v4-core/src/types/Currency.sol";
import {IUnlockCallback} from "@uniswap/v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {BalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {BeforeSwapDelta, toBeforeSwapDelta} from "@uniswap/v4-core/src/types/BeforeSwapDelta.sol";
import {SwapParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {StateLibrary} from "@uniswap/v4-core/src/libraries/StateLibrary.sol";

interface IVolumeSink {
    function recordVolume(address token, uint256 quoteAmount) external;
}

/// @title HoodLaunchHook
/// @notice The tax office of a direct launch. One per launch, attached to its pool, holding the
///         numbers the creator fixed at launch and nothing else.
/// @dev Three things happen here and they are all visible to a buyer before they buy:
///
///      **The tax.** A fixed rate per side, between 1% and 10%, taken in the quote asset so the
///      splitter downstream only ever handles one currency. On an exact-input buy it comes out of
///      the input before the swap; on an exact-input sell it comes out of the output after it.
///
///      **The snipe tax.** An extra rate at the open that decays to nothing, quadratically, over a
///      few seconds. A bot in the first block pays most of its edge to the people it is racing;
///      by the time a human has read the ticker it is gone. Launch tax plus snipe tax is capped at
///      99%, and the launch's own opening buy is exempt.
///
///      **The latch.** When the price first crosses the bonding tick the launch is bonded, and
///      that never unsets, even if the price falls back. There is nothing to migrate and nothing
///      to trust: the liquidity was real from the first block and it stays where it is.
///
///      **How the tax physically leaves.** A tax on the quote as the trade's INPUT is taken while
///      that input has not been settled yet, so it cannot be transferred out in the same breath; it
///      is minted to this contract as an ERC-6909 claim instead and flushed to the splitter at the
///      next swap, or by anyone calling `flushClaims`. A tax on the quote as the trade's OUTPUT is a
///      slice of what the pool is paying out, which exists, so it is taken directly. Measured on a
///      fork with an ERC-20 quote: the naive `take` in beforeSwap reverts the moment the PoolManager
///      does not happen to hold that currency from some other pool.
contract HoodLaunchHook is BaseHook, IUnlockCallback {
    using PoolIdLibrary for PoolKey;
    using StateLibrary for IPoolManager;
    using CurrencyLibrary for Currency;

    uint256 internal constant BPS = 10_000;
    /// @notice Launch tax and snipe tax together can never take more than this.
    uint256 public constant MAX_COMBINED_BPS = 9_900;
    /// @notice The longest the opening surcharge may take to decay away: ten minutes.
    /// @dev Without a ceiling the surcharge is not a surcharge. `snipeDecaySeconds` is a uint32, so
    ///      a launch could set a 98% rate decaying over a century and call it an opening tax: a
    ///      honeypot that every screener would read as the 1% base rate, and immutable by design
    ///      like everything else here. The window is what makes it a race and not a trap.
    uint32 public constant MAX_SNIPE_DECAY_SECONDS = 600;

    address public immutable portal;

    address public token;
    address public quote;
    address public splitter;
    address public factory;
    /// @notice The shared buyback module. Its buys are the launch's own money coming back, so they
    ///         pay the base tax and never the opening surcharge.
    address public buybackModule;
    bool public tokenIsZero;

    uint16 public buyTaxBps;
    uint16 public sellTaxBps;
    uint16 public snipeTaxBps;
    uint32 public snipeDecaySeconds;
    uint64 public launchTime;
    int24 public tickBond;
    bool public bonded;

    PoolKey internal _key;

    /// @notice Quote tax held as ERC-6909 claims, waiting to be flushed to the splitter.
    uint256 public claimsHeld;
    uint256 internal _mintedThisSwap;

    event Taxed(bool isBuy, uint256 fee, uint256 volume);
    event ClaimsFlushed(uint256 amount);
    event Bonded(uint64 at, int24 tick);

    error NotPortal();
    error AlreadyInitialized();
    error BadTax();
    error WrongPool();

    constructor(IPoolManager manager, address portal_) BaseHook(manager) {
        portal = portal_;
    }

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

    struct InitParams {
        address token;
        address quote;
        address splitter;
        address factory;
        address buybackModule;
        bool tokenIsZero;
        uint16 buyTaxBps;
        uint16 sellTaxBps;
        uint16 snipeTaxBps;
        uint32 snipeDecaySeconds;
        int24 tickBond;
        PoolKey key;
    }

    function initialize(InitParams calldata p) external {
        if (msg.sender != portal) revert NotPortal();
        if (token != address(0)) revert AlreadyInitialized();
        if (p.buyTaxBps < 100 || p.buyTaxBps > 1_000 || p.sellTaxBps < 100 || p.sellTaxBps > 1_000) revert BadTax();
        if (uint256(p.buyTaxBps) + p.snipeTaxBps > MAX_COMBINED_BPS) revert BadTax();
        if (uint256(p.sellTaxBps) + p.snipeTaxBps > MAX_COMBINED_BPS) revert BadTax();
        // A surcharge with no window to decay over would be a surcharge that never applies, and one
        // with no ceiling on the window would be a permanent tax wearing the word "opening".
        if (p.snipeTaxBps != 0 && p.snipeDecaySeconds == 0) revert BadTax();
        if (p.snipeDecaySeconds > MAX_SNIPE_DECAY_SECONDS) revert BadTax();

        token = p.token;
        quote = p.quote;
        splitter = p.splitter;
        factory = p.factory;
        buybackModule = p.buybackModule;
        tokenIsZero = p.tokenIsZero;
        buyTaxBps = p.buyTaxBps;
        sellTaxBps = p.sellTaxBps;
        snipeTaxBps = p.snipeTaxBps;
        snipeDecaySeconds = p.snipeDecaySeconds;
        tickBond = p.tickBond;
        launchTime = uint64(block.timestamp);
        _key = p.key;
    }

    // ---------------------------------------------------------------- rates

    /// @notice What a trade pays right now, all in.
    function currentTaxBps(bool isBuy) public view returns (uint256) {
        uint256 base = isBuy ? buyTaxBps : sellTaxBps;
        uint256 extra = currentSnipeBps();
        uint256 total = base + extra;
        return total > MAX_COMBINED_BPS ? MAX_COMBINED_BPS : total;
    }

    /// @notice The part of the rate that is still the snipe surcharge. Quadratic, so it falls away
    ///         fast rather than trailing off in a straight line.
    function currentSnipeBps() public view returns (uint256) {
        uint32 window = snipeDecaySeconds;
        if (window == 0 || snipeTaxBps == 0) return 0;
        uint256 elapsed = block.timestamp - launchTime;
        if (elapsed >= window) return 0;
        uint256 remaining = window - elapsed;
        return (uint256(snipeTaxBps) * remaining * remaining) / (uint256(window) * window);
    }

    function poolKey() external view returns (PoolKey memory) {
        return _key;
    }

    // ---------------------------------------------------------------- swaps

    function _beforeSwap(address sender, PoolKey calldata key, SwapParams calldata params, bytes calldata)
        internal
        override
        returns (bytes4, BeforeSwapDelta, uint24)
    {
        _onlyOurPool(key);
        bool exactInput = params.amountSpecified < 0;
        Currency specified = exactInput == params.zeroForOne ? key.currency0 : key.currency1;
        bool specifiedIsQuote = Currency.unwrap(specified) == quote;

        // Only the case where the quote asset is the specified side is handled here. The other
        // cases are taxed in afterSwap, where the quote is the unspecified side.
        if (!specifiedIsQuote) return (BaseHook.beforeSwap.selector, toBeforeSwapDelta(0, 0), 0);

        bool isBuy = _isBuy(params.zeroForOne);
        uint256 amount = exactInput ? uint256(-params.amountSpecified) : uint256(params.amountSpecified);
        uint256 fee = (amount * _rate(sender, isBuy)) / BPS;
        if (fee == 0) return (BaseHook.beforeSwap.selector, toBeforeSwapDelta(0, 0), 0);

        // The input is not settled yet: hold the tax as a claim, flush it once it is. The trade is
        // reported from afterSwap, once the pool has said how much of the order it actually filled.
        poolManager.mint(address(this), specified.toId(), fee);
        claimsHeld += fee;
        _mintedThisSwap = fee;
        return (BaseHook.beforeSwap.selector, toBeforeSwapDelta(int128(int256(fee)), 0), 0);
    }

    function _afterSwap(address sender, PoolKey calldata key, SwapParams calldata params, BalanceDelta delta, bytes calldata)
        internal
        override
        returns (bytes4, int128)
    {
        _onlyOurPool(key);
        _latch(key);
        uint256 mintedNow = _mintedThisSwap;
        _flushPriorClaims();

        bool exactInput = params.amountSpecified < 0;
        Currency specified = exactInput == params.zeroForOne ? key.currency0 : key.currency1;
        if (Currency.unwrap(specified) == quote) {
            // Taxed in beforeSwap on the amount offered. A binding price limit can leave part of an
            // exact-input order unfilled, so the volume is read off the pool's own delta rather
            // than off the order. Volume is what the pool moved in the quote on every path.
            if (mintedNow != 0) {
                int128 specifiedDelta = exactInput == params.zeroForOne ? delta.amount0() : delta.amount1();
                uint256 moved = specifiedDelta < 0 ? uint256(uint128(-specifiedDelta)) : uint256(uint128(specifiedDelta));
                _report(moved, mintedNow, _isBuy(params.zeroForOne));
            }
            return (BaseHook.afterSwap.selector, 0);
        }

        // Past the line above the specified side is the token, so the unspecified side is the quote
        // in both directions: what the pool pays out on a sell, what the swapper pays in on an
        // exact-output buy. Both are taxed; the sign says which.
        Currency unspecified = exactInput == params.zeroForOne ? key.currency1 : key.currency0;
        int128 unspecifiedDelta = exactInput == params.zeroForOne ? delta.amount1() : delta.amount0();
        if (unspecifiedDelta == 0) return (BaseHook.afterSwap.selector, 0);

        bool isBuy = _isBuy(params.zeroForOne);
        uint256 amount = unspecifiedDelta < 0 ? uint256(uint128(-unspecifiedDelta)) : uint256(uint128(unspecifiedDelta));
        uint256 fee = (amount * _rate(sender, isBuy)) / BPS;
        if (fee == 0) return (BaseHook.afterSwap.selector, 0);

        if (unspecifiedDelta < 0) {
            // exact-output buy: the quote is the input and is settled after this returns, so the
            // tax is held as a claim and flushed by the next swap, like an exact-input buy
            poolManager.mint(address(this), unspecified.toId(), fee);
            claimsHeld += fee;
        } else {
            // a sell: the quote is what the pool is paying out, and that exists
            poolManager.take(unspecified, splitter, fee);
        }
        _report(amount, fee, isBuy);
        return (BaseHook.afterSwap.selector, int128(int256(fee)));
    }

    /// @dev The PoolManager calls a hook for every pool that names it. Anyone can initialize a
    ///      second pool on this hook's address, and a swap there must not latch the bond, report
    ///      volume or drop strange tokens into the splitter. One hook, one pool.
    function _onlyOurPool(PoolKey calldata key) internal view {
        if (PoolId.unwrap(key.toId()) != PoolId.unwrap(_key.toId())) revert WrongPool();
    }

    // ---------------------------------------------------------------- claims

    /// @dev Inside a swap the manager is already unlocked, so claims from EARLIER swaps, whose
    ///      inputs have long been settled, can be turned into the real asset and sent on.
    function _flushPriorClaims() internal {
        uint256 minted = _mintedThisSwap;
        _mintedThisSwap = 0;
        uint256 flushable = claimsHeld - minted;
        if (flushable == 0) return;
        _realize(flushable);
    }

    function _realize(uint256 amount) internal {
        Currency q = Currency.wrap(quote);
        poolManager.burn(address(this), q.toId(), amount);
        poolManager.take(q, splitter, amount);
        claimsHeld -= amount;
        emit ClaimsFlushed(amount);
    }

    /// @notice Permissionless. Sends whatever tax is still held as claims to the splitter.
    function flushClaims() external {
        if (claimsHeld == 0) return;
        poolManager.unlock(bytes(""));
    }

    function unlockCallback(bytes calldata) external onlyPoolManager returns (bytes memory) {
        _realize(claimsHeld);
        return bytes("");
    }

    // ---------------------------------------------------------------- internals

    function _isBuy(bool zeroForOne) internal view returns (bool) {
        // buying the token means paying the quote in
        return tokenIsZero ? !zeroForOne : zeroForOne;
    }

    function _rate(address sender, bool isBuy) internal view returns (uint256) {
        // The launch's own opening buy is not a snipe, and neither is its own buyback.
        if (sender == portal || sender == buybackModule) return isBuy ? buyTaxBps : sellTaxBps;
        return currentTaxBps(isBuy);
    }

    /// @dev `volume` is the quote the pool itself moved on the trade, read off its delta, not the
    ///      tax taken out of it and not the size the order asked for. The ticker lock upstream is
    ///      calibrated in volume, and reporting the fee instead would make a hot launch look twenty
    ///      times quieter than it is; reporting the order would let an unfilled order count.
    function _report(uint256 volume, uint256 fee, bool isBuy) internal {
        emit Taxed(isBuy, fee, volume);
        address f = factory;
        if (f != address(0)) {
            // A registry that cannot take the report must never be able to stop a trade.
            try IVolumeSink(f).recordVolume(token, volume) {} catch {}
        }
    }

    function _latch(PoolKey calldata key) internal {
        if (bonded) return;
        (, int24 tick,,) = poolManager.getSlot0(key.toId());
        bool crossed = tokenIsZero ? tick >= tickBond : tick <= tickBond;
        if (crossed) {
            bonded = true;
            emit Bonded(uint64(block.timestamp), tick);
        }
    }
}
