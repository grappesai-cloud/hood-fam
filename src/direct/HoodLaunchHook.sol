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
import {SafeCast} from "@uniswap/v4-core/src/libraries/SafeCast.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import {BagSplits} from "../bag/BagTypes.sol";
import {IHoodBag} from "../interfaces/IHoodBag.sol";
import {ReferralLeg} from "../libraries/ReferralLeg.sol";
import {SnipeSchedule} from "../libraries/SnipeSchedule.sol";
import {DirectPay} from "./lib/DirectPay.sol";

interface IVolumeSink {
    function recordVolume(address token, uint256 quoteAmount) external;
}

/// @title HoodLaunchHook
/// @notice The tax office of a direct launch. One per launch, attached to its pool, holding the
///         numbers the creator fixed at launch and nothing else.
/// @dev Everything here is taken in the quote asset, so the splitter downstream only ever handles
///      one currency. On every swap:
///
///      **The creator's tax.** A fixed rate per side, between 1% and 10%, plus the 70 bps creator
///      leg of the platform fee. All of it goes to the splitter and follows the creator's
///      Allocations.
///
///      **The platform fee.** 1% of the quote side of every trade: 70 bps ride with the creator's
///      tax above, 30 bps go to the Bag through `takeTradeFee`. The buyback module's own buys are
///      the launch's money coming back and pay the base creator tax only; the portal's opening
///      buy pays the platform fee like anyone. A referral the portal's registry names for this
///      launch takes its share of those 30 bps as they are routed, and the Bag takes the rest.
///
///      **The opening tax.** The one schedule every launch runs (SnipeSchedule): 99% of a buy in
///      the launch's own second, 6.18% in the next, 0.19% in the one after, then nothing. It is
///      trading fee, split the way the platform fee is (70 to the creator's leg, 30 to the Bag),
///      and it never pushes a trade past MAX_COMBINED_BPS all in. Buys only. Exempt are the
///      portal (the launch transaction's own buys), the buyback module, and, keyed on
///      `tx.origin`, the launcher, the creator fee recipient and the wallets named at launch.
///      A hook sees the router as `sender`, so the wallet behind a swap is `tx.origin`; a wallet
///      behind a smart-account relayer is seen as the relayer.
///
///      **How money physically leaves.** Fees on the quote as the trade's INPUT (buys) are taken
///      while that input is unsettled, so they are minted to this contract as ERC-6909 claims and
///      routed at the next swap or by anyone calling `flushClaims`. Fees on the quote as the
///      trade's OUTPUT (sells) are a slice of what the pool pays out, which exists, so they are
///      taken and routed inside the swap.
contract HoodLaunchHook is BaseHook, IUnlockCallback {
    using PoolIdLibrary for PoolKey;
    using StateLibrary for IPoolManager;
    using CurrencyLibrary for Currency;
    using SafeERC20 for IERC20;

    uint256 internal constant BPS = 10_000;
    /// @notice Creator tax, platform fee and opening tax together can never take more than this.
    uint256 public constant MAX_COMBINED_BPS = 9_900;
    /// @dev Gas a referrer's receive may burn. Enough for a Safe, not enough to fail a trade.
    uint256 internal constant REFERRAL_GAS = 60_000;

    // transient slots: what one swap carries from beforeSwap to afterSwap
    uint256 internal constant T_BUSY = 1;
    uint256 internal constant T_CREATOR = 3;
    uint256 internal constant T_BAG = 4;
    uint256 internal constant T_SNIPE = 5;

    address public immutable portal;

    address public token;
    address public quote;
    address public splitter;
    address public factory;
    /// @notice The shared buyback module. Its buys are the launch's own money coming back, so they
    ///         pay the base tax and never the opening tax or the platform fee.
    address public buybackModule;
    /// @notice The Bag: where the platform's 30 bps go.
    address public bag;
    bool public tokenIsZero;

    uint16 public buyTaxBps;
    uint16 public sellTaxBps;
    uint64 public launchTime;
    int24 public tickBond;
    bool public bonded;
    /// @notice Wallets (by tx.origin) that pay no opening tax, fixed at launch.
    mapping(address => bool) public snipeExempt;

    PoolKey internal _key;

    /// @notice Quote held as ERC-6909 claims from buys, waiting to be routed. Of it, `bagClaims`
    ///         is the Bag's; the rest is the creator's.
    uint256 public claimsHeld;
    uint256 public bagClaims;

    event Taxed(bool isBuy, uint256 fee, uint256 volume);
    event ClaimsFlushed(uint256 amount);
    event Bonded(uint64 at, int24 tick);
    /// @notice A buy in the opening window paid the opening tax. `tax` is inside `Taxed.fee`.
    event Sniped(address indexed payer, uint256 tax);
    /// @notice The wallets that pay no opening tax, once, from `initialize`.
    event SnipeExempt(address[] wallets);
    /// @notice The referral leg the portal's registry names for this launch, paid out of the Bag's
    ///         share of the platform fee as it is routed.
    event ReferralPaid(address indexed to, uint256 amount);

    error NotPortal();
    error AlreadyInitialized();
    error BadTax();
    error NoBag();
    error WrongPool();
    error Reentered();

    constructor(IPoolManager manager, address portal_) BaseHook(manager) {
        portal = portal_;
    }

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

    struct InitParams {
        address token;
        address quote;
        address splitter;
        address factory;
        address buybackModule;
        address bag;
        bool tokenIsZero;
        uint16 buyTaxBps;
        uint16 sellTaxBps;
        int24 tickBond;
        address[] exempt;
        PoolKey key;
    }

    function initialize(InitParams calldata p) external {
        if (msg.sender != portal) revert NotPortal();
        if (token != address(0)) revert AlreadyInitialized();
        if (p.bag == address(0)) revert NoBag();
        if (p.buyTaxBps < 100 || p.buyTaxBps > 1_000 || p.sellTaxBps < 100 || p.sellTaxBps > 1_000) revert BadTax();

        token = p.token;
        quote = p.quote;
        splitter = p.splitter;
        factory = p.factory;
        buybackModule = p.buybackModule;
        bag = p.bag;
        tokenIsZero = p.tokenIsZero;
        buyTaxBps = p.buyTaxBps;
        sellTaxBps = p.sellTaxBps;
        tickBond = p.tickBond;
        launchTime = uint64(block.timestamp);
        for (uint256 i; i < p.exempt.length; ++i) {
            if (p.exempt[i] != address(0)) snipeExempt[p.exempt[i]] = true;
        }
        emit SnipeExempt(p.exempt);
        _key = p.key;
    }

    // ---------------------------------------------------------------- rates

    /// @notice What a trade pays right now, all in, for a wallet that is not exempt: creator tax,
    ///         platform fee and the opening tax.
    function currentTaxBps(bool isBuy) public view returns (uint256) {
        uint256 base = (isBuy ? buyTaxBps : sellTaxBps) + BagSplits.PLATFORM_FEE_BPS;
        uint256 total = base + (isBuy ? SnipeSchedule.bpsAt(block.timestamp - launchTime) : 0);
        return total > MAX_COMBINED_BPS ? MAX_COMBINED_BPS : total;
    }

    /// @notice The opening tax on a buy sent by `origin` right now, in bps, before the all-in cap.
    function currentSnipeTaxBps(address origin) public view returns (uint256) {
        if (snipeExempt[origin]) return 0;
        return SnipeSchedule.bpsAt(block.timestamp - launchTime);
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
        if (_tload(T_BUSY) != 0) revert Reentered();
        bool exactInput = params.amountSpecified < 0;
        bool isBuy = _isBuy(params.zeroForOne);

        // Only the case where the quote asset is the specified side is priced here. The other
        // cases are priced in afterSwap, where the quote is the unspecified side.
        Currency specified = exactInput == params.zeroForOne ? key.currency0 : key.currency1;
        if (Currency.unwrap(specified) != quote) return (BaseHook.beforeSwap.selector, toBeforeSwapDelta(0, 0), 0);

        uint256 amount = exactInput ? uint256(-params.amountSpecified) : uint256(params.amountSpecified);
        (uint256 creatorFee, uint256 bagFee, uint256 snipe) = _fees(sender, isBuy, amount);
        uint256 total = creatorFee + bagFee;
        if (total == 0) return (BaseHook.beforeSwap.selector, toBeforeSwapDelta(0, 0), 0);

        // A buy's input is not settled yet: hold the fee as a claim, route it once it is. A sell's
        // output is the pool's own reserves: taken in afterSwap, once the pool has moved.
        if (isBuy) poolManager.mint(address(this), specified.toId(), total);
        _tstore(T_CREATOR, creatorFee);
        _tstore(T_BAG, bagFee);
        _tstore(T_SNIPE, snipe);
        return (BaseHook.beforeSwap.selector, toBeforeSwapDelta(SafeCast.toInt128(total), 0), 0);
    }

    function _afterSwap(address sender, PoolKey calldata key, SwapParams calldata params, BalanceDelta delta, bytes calldata)
        internal
        override
        returns (bytes4, int128)
    {
        _onlyOurPool(key);
        if (_tload(T_BUSY) != 0) revert Reentered();
        _tstore(T_BUSY, 1);
        _latch(key);
        // Claims from EARLIER swaps, whose inputs have long been settled, can be realized now that
        // the manager is unlocked. This swap's own are booked after, so they wait for the next one.
        _flushClaims();

        bool exactInput = params.amountSpecified < 0;
        bool isBuy = _isBuy(params.zeroForOne);
        bool specifiedIsZero = exactInput == params.zeroForOne;
        int128 ret;
        if (Currency.unwrap(specifiedIsZero ? key.currency0 : key.currency1) == quote) {
            // Priced in beforeSwap on the amount offered or asked. A binding price limit can leave
            // part of an exact-input order unfilled, so the volume is read off the pool's delta.
            uint256 creatorFee = _tload(T_CREATOR);
            uint256 bagFee = _tload(T_BAG);
            uint256 snipe = _tload(T_SNIPE);
            _tstore(T_CREATOR, 0);
            _tstore(T_BAG, 0);
            _tstore(T_SNIPE, 0);
            uint256 moved = _abs(specifiedIsZero ? delta.amount0() : delta.amount1());
            if (isBuy) {
                _book(creatorFee, bagFee);
            } else {
                _settleSell(creatorFee, bagFee);
            }
            if (snipe != 0) emit Sniped(tx.origin, snipe);
            if (creatorFee + bagFee != 0) _report(moved, creatorFee + bagFee, isBuy);
        } else {
            // The specified side is the token, so the unspecified side is the quote in both
            // directions: what the pool pays out on a sell, what the swapper pays in on an
            // exact-output buy.
            Currency unspecified = specifiedIsZero ? key.currency1 : key.currency0;
            int128 unspecifiedDelta = specifiedIsZero ? delta.amount1() : delta.amount0();
            if (unspecifiedDelta != 0) {
                uint256 amount = _abs(unspecifiedDelta);
                (uint256 creatorFee, uint256 bagFee, uint256 snipe) = _fees(sender, isBuy, amount);
                uint256 total = creatorFee + bagFee;
                if (isBuy) {
                    if (total != 0) poolManager.mint(address(this), unspecified.toId(), total);
                    _book(creatorFee, bagFee);
                } else {
                    _settleSell(creatorFee, bagFee);
                }
                if (snipe != 0) emit Sniped(tx.origin, snipe);
                if (total != 0) _report(amount, total, isBuy);
                ret = SafeCast.toInt128(total);
            }
        }
        _tstore(T_BUSY, 0);
        return (BaseHook.afterSwap.selector, ret);
    }

    /// @dev The PoolManager calls a hook for every pool that names it. Anyone can initialize a
    ///      second pool on this hook's address, and a swap there must not latch the bond, report
    ///      volume or drop strange tokens into the splitter. One hook, one pool.
    function _onlyOurPool(PoolKey calldata key) internal view {
        if (PoolId.unwrap(key.toId()) != PoolId.unwrap(_key.toId())) revert WrongPool();
    }

    // ---------------------------------------------------------------- pricing

    /// @dev The creator's leg and the Bag's leg, the opening tax folded into both the way the
    ///      platform fee splits. `snipe` is the opening tax alone, for the tape.
    function _fees(address sender, bool isBuy, uint256 amount)
        internal
        view
        returns (uint256 creatorFee, uint256 bagFee, uint256 snipe)
    {
        uint256 creatorBps = isBuy ? buyTaxBps : sellTaxBps;
        if (sender == buybackModule) return ((amount * creatorBps) / BPS, 0, 0);
        creatorBps += BagSplits.PLATFORM_CREATOR_BPS;
        creatorFee = (amount * creatorBps) / BPS;
        bagFee = (amount * BagSplits.PLATFORM_BAG_BPS) / BPS;
        // The launch transaction's own buys come from the portal, and the portal never sells.
        if (!isBuy || sender == portal) return (creatorFee, bagFee, 0);
        uint256 rate = currentSnipeTaxBps(tx.origin);
        if (rate == 0) return (creatorFee, bagFee, 0);
        uint256 room = MAX_COMBINED_BPS - creatorBps - BagSplits.PLATFORM_BAG_BPS;
        if (rate > room) rate = room;
        snipe = (amount * rate) / BPS;
        uint256 toCreator = (snipe * BagSplits.PLATFORM_CREATOR_BPS) / BagSplits.PLATFORM_FEE_BPS;
        creatorFee += toCreator;
        bagFee += snipe - toCreator;
    }

    // ---------------------------------------------------------------- after a trade

    function _book(uint256 creatorFee, uint256 bagFee) internal {
        claimsHeld += creatorFee + bagFee;
        bagClaims += bagFee;
    }

    /// @dev The quote the pool is paying out exists, so both legs leave right now: the creator's
    ///      to the splitter, the Bag's through this contract.
    function _settleSell(uint256 creatorFee, uint256 bagFee) internal {
        Currency q = Currency.wrap(quote);
        if (creatorFee != 0) poolManager.take(q, splitter, creatorFee);
        if (bagFee == 0) return;
        poolManager.take(q, address(this), bagFee);
        _sendBag(bagFee);
    }

    // ---------------------------------------------------------------- routing

    /// @dev The Bag's 30 bps, less the referral leg the portal's registry names for this launch.
    ///      The cut is pushed best-effort: a referrer that cannot take it (no receive, a blocked
    ///      address, a receive that needs more gas) forfeits it to the Bag, because nothing about
    ///      a referrer may stop a trade or a flush. Only what was actually paid is announced.
    function _sendBag(uint256 amount) internal {
        (address referrer, uint256 cut) = ReferralLeg.cut(portal, token, amount);
        if (cut != 0 && _tryPush(referrer, cut)) {
            amount -= cut;
            emit ReferralPaid(referrer, cut);
        }
        DirectPay.payWithCall(quote, bag, amount, abi.encodeCall(IHoodBag.takeTradeFee, (quote, amount, token)));
    }

    function _tryPush(address to, uint256 amount) internal returns (bool ok) {
        address q = quote;
        if (q == address(0)) {
            (ok,) = to.call{value: amount, gas: REFERRAL_GAS}("");
        } else {
            ok = IERC20(q).trySafeTransfer(to, amount);
        }
    }

    // ---------------------------------------------------------------- claims

    function _flushClaims() internal {
        uint256 held = claimsHeld;
        if (held == 0) return;
        Currency q = Currency.wrap(quote);
        poolManager.burn(address(this), q.toId(), held);
        uint256 toBag = bagClaims;
        uint256 toCreator = held - toBag;
        claimsHeld = 0;
        bagClaims = 0;
        if (toCreator != 0) poolManager.take(q, splitter, toCreator);
        if (toBag != 0) {
            poolManager.take(q, address(this), toBag);
            _sendBag(toBag);
        }
        emit ClaimsFlushed(held);
    }

    /// @notice Permissionless. Routes whatever tax is still held as claims.
    function flushClaims() external {
        if (claimsHeld == 0) return;
        poolManager.unlock(bytes(""));
    }

    function unlockCallback(bytes calldata) external onlyPoolManager returns (bytes memory) {
        _flushClaims();
        return bytes("");
    }

    // ---------------------------------------------------------------- internals

    function _isBuy(bool zeroForOne) internal view returns (bool) {
        // buying the token means paying the quote in
        return tokenIsZero ? !zeroForOne : zeroForOne;
    }

    function _abs(int128 x) internal pure returns (uint256) {
        return x < 0 ? uint256(uint128(-x)) : uint256(uint128(x));
    }

    /// @dev `volume` is the quote the pool itself moved on the trade, read off its delta, not the
    ///      tax taken out of it and not the size the order asked for. `fee` is everything taken,
    ///      the opening tax included; `Sniped` says how much of it that was.
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

    function _tstore(uint256 slot, uint256 value) internal {
        assembly {
            tstore(slot, value)
        }
    }

    function _tload(uint256 slot) internal view returns (uint256 value) {
        assembly {
            value := tload(slot)
        }
    }
}
