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

import {PenaltyConfig, BagReasons, BagSplits} from "../bag/BagTypes.sol";
import {IHoodBag} from "../interfaces/IHoodBag.sol";
import {IHoodPot} from "../interfaces/IHoodPot.sol";
import {IHoodStaking} from "../interfaces/IHoodStaking.sol";
import {PairTransfer} from "../libraries/PairTransfer.sol";
import {ReferralLeg} from "../libraries/ReferralLeg.sol";
import {DirectPay} from "./lib/DirectPay.sol";
import {BuybackMath} from "./lib/BuybackMath.sol";

interface IVolumeSink {
    function recordVolume(address token, uint256 quoteAmount) external;
}

/// @dev What the hook asks of its launch's splitter beyond the IHoodPot surface.
interface IHookSplitter {
    function sweep() external;
    function buybackPot() external view returns (uint256);
    function releaseBuybackUpTo(uint256 max) external returns (uint256);
    function depositForKing(uint256 amount) external payable;
    function crownKing(address buyer) external;
    function kingPot() external view returns (uint256);
}

interface IModuleClock {
    function lastRunBlock(address token) external view returns (uint64);
}

interface IBurnable {
    function burn(uint256 amount) external;
}

/// @title HoodLaunchHook
/// @notice The tax office of a direct launch. One per launch, attached to its pool, holding the
///         numbers the creator fixed at launch and nothing else.
/// @dev Everything here is taken in the quote asset, so the splitter downstream only ever handles
///      one currency. On every swap:
///
///      **The creator's tax.** A fixed rate per side, between 1% and 10%, plus the 30 bps creator
///      leg of the platform fee. All of it goes to the splitter and follows the creator's
///      Allocations.
///
///      **The platform fee.** 1% of the quote side of every trade: 30 bps ride with the creator's
///      tax above, 70 bps go to the Bag through `takeTradeFee`. The buyback module's own buys are
///      the launch's money coming back and pay the base creator tax only; the portal's opening
///      buy pays the platform fee like anyone. A referral the portal's registry names for this
///      launch takes its share of those 70 bps as they are routed, and the Bag takes the rest.
///
///      **Penalties.** Separate from the tax and routed 80% to the launch's pot (holders) and 20%
///      to the Bag through `takePenaltyCut`. The snipe surcharge on buys decays quadratically to
///      nothing over a few seconds. The jeet tax hits a sell within `jeetWindowSeconds` of that
///      wallet's last buy; the whale tax hits a sell that moves the price more than
///      `whaleTickLimit` ticks. When `penaltiesToVault` is on, the jeet and whale holder shares go
///      to the Vault's lockers instead, and when `kingBps` is on that slice of every holder share
///      fills the splitter's king pot.
///
///      **Identity.** Hooks see the router as `sender`, so buyers and sellers are tracked by
///      `tx.origin`. The limitation: a flipper who moves tokens to a fresh wallet before selling
///      escapes the jeet window, and everything a smart-account relayer sends looks like one
///      wallet. It is a deterrent priced into the open, not a wall.
///
///      **Bots buy the dip.** A sell that pays a penalty triggers a buyback right away, inline,
///      with the splitter's buyback pot: the hook swaps against its own pool inside afterSwap
///      (v4 skips a hook's callbacks for its own swaps, so the buyback pays no tax and cannot
///      re-enter the tax logic), capped at the same three percent of price impact as the keeper's
///      run and once per block across both. When it cannot run it says `BuybackWanted` and the
///      keeper picks it up.
///
///      **How money physically leaves.** Fees on the quote as the trade's INPUT (buys) are taken
///      while that input is unsettled, so they are minted to this contract as ERC-6909 claims and
///      routed at the next swap or by anyone calling `flushClaims`; buy-side snipe penalties
///      are booked in the pot then, in one deposit with this hook as payer, and the sniper is on
///      the `Penalty` event. Fees on the quote as the trade's OUTPUT (sells) are a slice of what
///      the pool pays out, which exists, so they are taken and routed inside the swap.
contract HoodLaunchHook is BaseHook, IUnlockCallback {
    using PoolIdLibrary for PoolKey;
    using StateLibrary for IPoolManager;
    using CurrencyLibrary for Currency;
    using SafeERC20 for IERC20;

    uint256 internal constant BPS = 10_000;
    /// @notice Creator tax, platform fee and snipe surcharge together can never take more than this.
    uint256 public constant MAX_COMBINED_BPS = 9_900;
    /// @notice The longest the opening surcharge may take to decay away: ten minutes.
    /// @dev Without a ceiling the surcharge is not a surcharge. `snipeDecaySeconds` is a uint32, so
    ///      a launch could set a 98% rate decaying over a century and call it an opening tax: a
    ///      honeypot that every screener would read as the 1% base rate, and immutable by design
    ///      like everything else here. The window is what makes it a race and not a trap.
    uint32 public constant MAX_SNIPE_DECAY_SECONDS = 600;
    /// @notice A buy counts for the crown when it is worth at least this fraction of the king pot.
    uint256 public constant KING_FLOOR_DIVISOR = 100;
    /// @dev Gas a referrer's receive may burn. Enough for a Safe, not enough to fail a trade.
    uint256 internal constant REFERRAL_GAS = 60_000;

    // transient slots: what one swap carries from beforeSwap to afterSwap
    uint256 internal constant T_BUSY = 1;
    uint256 internal constant T_TICK = 2;
    uint256 internal constant T_CREATOR = 3;
    uint256 internal constant T_BAG = 4;
    uint256 internal constant T_PEN1 = 5;
    uint256 internal constant T_PEN2 = 6;

    address public immutable portal;

    address public token;
    address public quote;
    address public splitter;
    address public factory;
    /// @notice The shared buyback module. Its buys are the launch's own money coming back, so they
    ///         pay the base tax and never the opening surcharge or the platform fee.
    address public buybackModule;
    /// @notice The Bag: where the platform's 70 bps and every penalty's 20% go.
    address public bag;
    /// @notice The Vault (HoodStaking), read off the Bag at init. Zero means "no vault yet", in
    ///         which case `penaltiesToVault` falls back to the holders.
    address public vault;
    bool public tokenIsZero;

    uint16 public buyTaxBps;
    uint16 public sellTaxBps;
    uint16 public snipeTaxBps;
    uint32 public snipeDecaySeconds;
    uint64 public launchTime;
    int24 public tickBond;
    bool public bonded;
    PenaltyConfig public penalties;

    PoolKey internal _key;

    /// @notice Quote held as ERC-6909 claims from buys, waiting to be routed. Of it, `bagClaims`
    ///         is the Bag's and `snipeClaims` is snipe penalties; the rest is the creator's.
    uint256 public claimsHeld;
    uint256 public bagClaims;
    uint256 public snipeClaims;
    /// @notice When a wallet (by tx.origin) last bought. What the jeet window is measured from.
    mapping(address => uint64) public lastBuyAt;
    /// @notice The block the inline buyback last ran in. One buyback per block, keeper's included.
    uint64 public lastBuybackBlock;
    /// @notice Quote an inline buyback could not spend under the impact cap, kept for the next one.
    uint256 public buybackCarry;

    event Taxed(bool isBuy, uint256 fee, uint256 volume);
    event ClaimsFlushed(uint256 amount);
    event Bonded(uint64 at, int24 tick);
    /// @notice One per penalty per swap. `amount` is the whole penalty; `toHolders` went to the
    ///         pot or the Vault, `toBag` to the Bag, and the remainder is the king pot's slice.
    event Penalty(bytes32 indexed reason, address indexed payer, uint256 amount, uint256 toHolders, uint256 toBag, bool isBuy);
    event BuybackTriggered(uint256 spent, uint256 burned);
    event BuybackWanted(address token);
    /// @notice The referral leg the portal's registry names for this launch, paid out of the Bag's
    ///         share of the platform fee as it is routed.
    event ReferralPaid(address indexed to, uint256 amount);

    error NotPortal();
    error NotSelf();
    error AlreadyInitialized();
    error BadTax();
    error BadPenalty();
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
        uint16 snipeTaxBps;
        uint32 snipeDecaySeconds;
        int24 tickBond;
        PenaltyConfig penalties;
        PoolKey key;
    }

    function initialize(InitParams calldata p) external {
        if (msg.sender != portal) revert NotPortal();
        if (token != address(0)) revert AlreadyInitialized();
        if (p.bag == address(0)) revert NoBag();
        if (p.buyTaxBps < 100 || p.buyTaxBps > 1_000 || p.sellTaxBps < 100 || p.sellTaxBps > 1_000) revert BadTax();
        // The platform's percent is not in this sum: at swap time it comes off the surcharge's
        // room instead, so a 1% tax with a 98% surcharge is still a legal opening.
        if (uint256(p.buyTaxBps) + p.snipeTaxBps > MAX_COMBINED_BPS) revert BadTax();
        // A surcharge with no window to decay over would be a surcharge that never applies, and one
        // with no ceiling on the window would be a permanent tax wearing the word "opening".
        if (p.snipeTaxBps != 0 && p.snipeDecaySeconds == 0) revert BadTax();
        if (p.snipeDecaySeconds > MAX_SNIPE_DECAY_SECONDS) revert BadTax();
        if (p.penalties.jeetTaxBps > 2_500 || p.penalties.whaleTaxBps > 2_500 || p.penalties.kingBps > 5_000) {
            revert BadPenalty();
        }

        token = p.token;
        quote = p.quote;
        splitter = p.splitter;
        factory = p.factory;
        buybackModule = p.buybackModule;
        bag = p.bag;
        vault = IHoodBag(p.bag).vault();
        tokenIsZero = p.tokenIsZero;
        buyTaxBps = p.buyTaxBps;
        sellTaxBps = p.sellTaxBps;
        snipeTaxBps = p.snipeTaxBps;
        snipeDecaySeconds = p.snipeDecaySeconds;
        tickBond = p.tickBond;
        penalties = p.penalties;
        launchTime = uint64(block.timestamp);
        _key = p.key;
    }

    // ---------------------------------------------------------------- rates

    /// @notice What a trade pays right now, all in: creator tax, platform fee and the surcharge.
    ///         Jeet and whale penalties depend on the seller and the size, so they are not here.
    function currentTaxBps(bool isBuy) public view returns (uint256) {
        uint256 base = (isBuy ? buyTaxBps : sellTaxBps) + BagSplits.PLATFORM_FEE_BPS;
        uint256 total = base + (isBuy ? currentSnipeBps() : 0);
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
        if (_tload(T_BUSY) != 0) revert Reentered();
        bool exactInput = params.amountSpecified < 0;
        bool isBuy = _isBuy(params.zeroForOne);
        if (!isBuy && penalties.whaleTaxBps != 0) {
            (, int24 tick,,) = poolManager.getSlot0(key.toId());
            _tstore(T_TICK, uint256(int256(tick)));
        }

        // Only the case where the quote asset is the specified side is priced here. The other
        // cases are priced in afterSwap, where the quote is the unspecified side.
        Currency specified = exactInput == params.zeroForOne ? key.currency0 : key.currency1;
        if (Currency.unwrap(specified) != quote) return (BaseHook.beforeSwap.selector, toBeforeSwapDelta(0, 0), 0);

        uint256 amount = exactInput ? uint256(-params.amountSpecified) : uint256(params.amountSpecified);
        (uint256 creatorFee, uint256 bagFee, uint256 pen1) = _fees(sender, isBuy, amount);
        uint256 pen2;
        if (!isBuy) pen2 = _whaleFeeByEstimate(sender, amount + creatorFee + bagFee + pen1, amount);
        uint256 total = creatorFee + bagFee + pen1 + pen2;
        if (total == 0) return (BaseHook.beforeSwap.selector, toBeforeSwapDelta(0, 0), 0);

        // A buy's input is not settled yet: hold the fee as a claim, route it once it is. A sell's
        // output is the pool's own reserves: taken in afterSwap, once the pool has moved.
        if (isBuy) poolManager.mint(address(this), specified.toId(), total);
        _tstore(T_CREATOR, creatorFee);
        _tstore(T_BAG, bagFee);
        _tstore(T_PEN1, pen1);
        _tstore(T_PEN2, pen2);
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
            uint256 pen1 = _tload(T_PEN1);
            uint256 pen2 = _tload(T_PEN2);
            _tstore(T_CREATOR, 0);
            _tstore(T_BAG, 0);
            _tstore(T_PEN1, 0);
            _tstore(T_PEN2, 0);
            uint256 moved = _abs(specifiedIsZero ? delta.amount0() : delta.amount1());
            if (isBuy) {
                _book(creatorFee, bagFee, pen1);
                _afterBuy(sender, pen1, moved);
            } else {
                _settleSell(creatorFee, bagFee, pen1, pen2);
            }
            if (creatorFee + bagFee + pen1 + pen2 != 0) _report(moved, creatorFee + bagFee, isBuy);
        } else {
            // The specified side is the token, so the unspecified side is the quote in both
            // directions: what the pool pays out on a sell, what the swapper pays in on an
            // exact-output buy.
            Currency unspecified = specifiedIsZero ? key.currency1 : key.currency0;
            int128 unspecifiedDelta = specifiedIsZero ? delta.amount1() : delta.amount0();
            if (unspecifiedDelta != 0) {
                uint256 amount = _abs(unspecifiedDelta);
                (uint256 creatorFee, uint256 bagFee, uint256 pen1) = _fees(sender, isBuy, amount);
                uint256 total;
                if (isBuy) {
                    total = creatorFee + bagFee + pen1;
                    if (total != 0) poolManager.mint(address(this), unspecified.toId(), total);
                    _book(creatorFee, bagFee, pen1);
                    _afterBuy(sender, pen1, amount);
                } else {
                    uint256 pen2 = _whaleFeeByTick(sender, amount, key);
                    total = _settleSell(creatorFee, bagFee, pen1, pen2);
                }
                if (total != 0) _report(amount, creatorFee + bagFee, isBuy);
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

    /// @dev The creator's leg, the Bag's leg, and the one penalty known before the swap: the snipe
    ///      surcharge on a buy, the jeet tax on a sell.
    function _fees(address sender, bool isBuy, uint256 amount)
        internal
        view
        returns (uint256 creatorFee, uint256 bagFee, uint256 pen1)
    {
        uint256 creatorBps = isBuy ? buyTaxBps : sellTaxBps;
        if (sender == buybackModule) return ((amount * creatorBps) / BPS, 0, 0);
        creatorBps += BagSplits.PLATFORM_CREATOR_BPS;
        creatorFee = (amount * creatorBps) / BPS;
        bagFee = (amount * BagSplits.PLATFORM_BAG_BPS) / BPS;
        // The launch's own opening buy is not a snipe, and the portal never sells.
        if (sender == portal) return (creatorFee, bagFee, 0);
        if (isBuy) {
            uint256 snipe = currentSnipeBps();
            if (snipe != 0) {
                uint256 room = MAX_COMBINED_BPS - creatorBps - BagSplits.PLATFORM_BAG_BPS;
                if (snipe > room) snipe = room;
                pen1 = (amount * snipe) / BPS;
            }
        } else {
            uint16 jeet = penalties.jeetTaxBps;
            if (jeet != 0) {
                uint64 at = lastBuyAt[tx.origin];
                if (at != 0 && block.timestamp - at <= penalties.jeetWindowSeconds) pen1 = (amount * jeet) / BPS;
            }
        }
    }

    /// @dev An exact-output sell asks for the quote before the pool has moved, so the tick move is
    ///      measured from what the range holds: if the quote leaving (fees included) is more than
    ///      the pool gives up within `whaleTickLimit` ticks, the price moves further than that.
    function _whaleFeeByEstimate(address sender, uint256 quoteOut, uint256 amount) internal view returns (uint256) {
        uint16 rate = penalties.whaleTaxBps;
        if (rate == 0 || sender == portal || sender == buybackModule) return 0;
        (uint256 available, bool known) =
            BuybackMath.quoteWithinTicks(poolManager, _key, tokenIsZero, int24(penalties.whaleTickLimit));
        if (!known || quoteOut <= available) return 0;
        return (amount * rate) / BPS;
    }

    function _whaleFeeByTick(address sender, uint256 amount, PoolKey calldata key) internal view returns (uint256) {
        uint16 rate = penalties.whaleTaxBps;
        if (rate == 0 || sender == portal || sender == buybackModule) return 0;
        (, int24 tickNow,,) = poolManager.getSlot0(key.toId());
        int256 before = int256(_tload(T_TICK));
        int256 move = int256(tickNow) > before ? int256(tickNow) - before : before - int256(tickNow);
        return move > int256(uint256(penalties.whaleTickLimit)) ? (amount * rate) / BPS : 0;
    }

    // ---------------------------------------------------------------- after a buy

    function _book(uint256 creatorFee, uint256 bagFee, uint256 snipeFee) internal {
        claimsHeld += creatorFee + bagFee + snipeFee;
        bagClaims += bagFee;
        snipeClaims += snipeFee;
    }

    /// @dev The buyer is remembered for the jeet window, the sniper is named on the tape, and the
    ///      crown moves when king of the hill is on and the buy is worth at least a hundredth of
    ///      the pot. The buyback module is the launch buying itself and counts for none of it.
    function _afterBuy(address sender, uint256 snipeFee, uint256 volume) internal {
        if (sender == buybackModule) return;
        lastBuyAt[tx.origin] = uint64(block.timestamp);
        if (snipeFee != 0) {
            (uint256 toHolders, uint256 toBag) = _splitPenalty(snipeFee);
            emit Penalty(BagReasons.SNIPE, tx.origin, snipeFee, toHolders, toBag, true);
        }
        if (penalties.kingBps != 0 && volume * KING_FLOOR_DIVISOR >= IHookSplitter(splitter).kingPot()) {
            IHookSplitter(splitter).crownKing(tx.origin);
        }
    }

    // ---------------------------------------------------------------- after a sell

    /// @dev The quote the pool is paying out exists, so every leg leaves right now: the creator's
    ///      to the splitter, the Bag's and the penalties through this contract.
    function _settleSell(uint256 creatorFee, uint256 bagFee, uint256 jeet, uint256 whale) internal returns (uint256) {
        Currency q = Currency.wrap(quote);
        if (creatorFee != 0) poolManager.take(q, splitter, creatorFee);
        uint256 mine = bagFee + jeet + whale;
        if (mine == 0) return creatorFee;
        poolManager.take(q, address(this), mine);
        if (bagFee != 0) _sendBag(bagFee);
        if (jeet != 0) {
            (uint256 toHolders, uint256 toBag) = _sendPenalty(BagReasons.JEET, jeet, tx.origin, true);
            emit Penalty(BagReasons.JEET, tx.origin, jeet, toHolders, toBag, false);
        }
        if (whale != 0) {
            (uint256 toHolders, uint256 toBag) = _sendPenalty(BagReasons.WHALE, whale, tx.origin, true);
            emit Penalty(BagReasons.WHALE, tx.origin, whale, toHolders, toBag, false);
        }
        if (jeet + whale != 0) _tryBuyback();
        return creatorFee + mine;
    }

    // ---------------------------------------------------------------- routing

    /// @dev The Bag's 70 bps, less the referral leg the portal's registry names for this launch.
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

    function _splitPenalty(uint256 amount) internal view returns (uint256 toHolders, uint256 toBag) {
        toBag = (amount * BagSplits.PENALTY_BAG_BPS) / BPS;
        toHolders = amount - toBag;
        uint16 kingBps = penalties.kingBps;
        if (kingBps != 0) toHolders -= (toHolders * kingBps) / BPS;
    }

    /// @dev 80% to holders, 20% to the Bag. Of the holder share, the king pot's slice first, then
    ///      the Vault when the launch chose "lockers eat the jeets" and the penalty is one of those.
    function _sendPenalty(bytes32 reason, uint256 amount, address payer, bool vaultEligible)
        internal
        returns (uint256 toHolders, uint256 toBag)
    {
        (toHolders, toBag) = _splitPenalty(amount);
        uint256 toKing = amount - toHolders - toBag;
        address q = quote;
        if (toKing != 0) {
            DirectPay.payWithCall(q, splitter, toKing, abi.encodeCall(IHookSplitter.depositForKing, (toKing)));
        }
        if (toHolders != 0) {
            address v = vault;
            if (vaultEligible && penalties.penaltiesToVault && v != address(0)) {
                PairTransfer.pushAndCall(q, v, toHolders, abi.encodeCall(IHoodStaking.notifyReward, (q, toHolders)));
            } else {
                DirectPay.payWithCall(
                    q, splitter, toHolders, abi.encodeCall(IHoodPot.depositForHolders, (toHolders, reason, payer))
                );
            }
        }
        if (toBag != 0) {
            DirectPay.payWithCall(q, bag, toBag, abi.encodeCall(IHoodBag.takePenaltyCut, (q, toBag, token)));
        }
    }

    // ---------------------------------------------------------------- claims

    function _flushClaims() internal {
        uint256 held = claimsHeld;
        if (held == 0) return;
        Currency q = Currency.wrap(quote);
        poolManager.burn(address(this), q.toId(), held);
        uint256 toBag = bagClaims;
        uint256 toSnipe = snipeClaims;
        uint256 toCreator = held - toBag - toSnipe;
        claimsHeld = 0;
        bagClaims = 0;
        snipeClaims = 0;
        if (toCreator != 0) poolManager.take(q, splitter, toCreator);
        if (toBag + toSnipe != 0) poolManager.take(q, address(this), toBag + toSnipe);
        if (toBag != 0) _sendBag(toBag);
        // Snipers were named on their own Penalty events; the pot sees one deposit from this hook.
        if (toSnipe != 0) _sendPenalty(BagReasons.SNIPE, toSnipe, address(this), false);
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

    // ---------------------------------------------------------------- bots buy the dip

    function _tryBuyback() internal {
        if (lastBuybackBlock == block.number || IModuleClock(buybackModule).lastRunBlock(token) == block.number) {
            emit BuybackWanted(token);
            return;
        }
        try this.buybackInline() returns (uint256 spent, uint256 burned) {
            if (spent == 0) emit BuybackWanted(token);
            else emit BuybackTriggered(spent, burned);
        } catch {
            emit BuybackWanted(token);
        }
    }

    /// @notice The inline buyback. Self-call only, from inside a swap: the manager is unlocked and
    ///         the hook swaps against its own pool, which v4 runs without calling the hook back.
    function buybackInline() external returns (uint256 spent, uint256 burned) {
        if (msg.sender != address(this)) revert NotSelf();
        IHookSplitter s = IHookSplitter(splitter);
        s.sweep();
        uint256 carry = buybackCarry;
        uint256 available = s.buybackPot() + carry;
        if (available == 0) return (0, 0);
        bool zeroForOne = !tokenIsZero;
        (uint256 cap, uint160 sqrtLimit) =
            BuybackMath.sizeToCap(poolManager, _key, zeroForOne, 0, BuybackMath.MAX_IMPACT_TICKS);
        uint256 amount = cap < available ? cap : available;
        if (amount == 0) return (0, 0);
        uint256 fromCarry = carry < amount ? carry : amount;
        if (amount > fromCarry) s.releaseBuybackUpTo(amount - fromCarry);

        BalanceDelta d = poolManager.swap(
            _key,
            SwapParams({zeroForOne: zeroForOne, amountSpecified: -SafeCast.toInt256(amount), sqrtPriceLimitX96: sqrtLimit}),
            bytes("")
        );
        int128 quoteDelta = zeroForOne ? d.amount0() : d.amount1();
        spent = quoteDelta < 0 ? _abs(quoteDelta) : 0;
        if (spent != 0) {
            if (quote == address(0)) {
                poolManager.settle{value: spent}();
            } else {
                poolManager.sync(Currency.wrap(quote));
                IERC20(quote).safeTransfer(address(poolManager), spent);
                poolManager.settle();
            }
        }
        int128 out = zeroForOne ? d.amount1() : d.amount0();
        if (out > 0) {
            burned = _abs(out);
            poolManager.take(Currency.wrap(token), address(this), burned);
            IBurnable(token).burn(burned);
        }
        buybackCarry = carry - fromCarry + (amount - spent);
        lastBuybackBlock = uint64(block.number);
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
    ///      tax taken out of it and not the size the order asked for. `fee` is the schedule
    ///      everyone pays (creator tax plus platform fee); penalties have their own event.
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
