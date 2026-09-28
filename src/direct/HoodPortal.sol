// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "@uniswap/v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {BalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {SwapParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {StateLibrary} from "@uniswap/v4-core/src/libraries/StateLibrary.sol";
import {LiquidityAmounts} from "@uniswap/v4-periphery/src/libraries/LiquidityAmounts.sol";

import {DirectConfig, DirectLaunch, Socials} from "./DirectTypes.sol";
import {HoodDirectDeployer} from "./HoodDirectDeployer.sol";
import {HoodLaunchHook} from "./HoodLaunchHook.sol";
import {HoodLaunchToken} from "./HoodLaunchToken.sol";
import {HoodLocker} from "./HoodLocker.sol";
import {HoodRevenueSplitter} from "./HoodRevenueSplitter.sol";
import {PairTransfer} from "../libraries/PairTransfer.sol";
import {PenaltyConfig} from "../bag/BagTypes.sol";
import {IHoodBag} from "../interfaces/IHoodBag.sol";
import {IHoodTokenLock} from "../interfaces/IHoodTokenLock.sol";
import {ITeamEvents, TeamBuy} from "../TeamTypes.sol";

interface IPositionManagerLite {
    function modifyLiquidities(bytes calldata unlockData, uint256 deadline) external payable;
    function nextTokenId() external view returns (uint256);
}

interface IPermit2Lite {
    function approve(address token, address spender, uint160 amount, uint48 expiration) external;
}

interface IOpeningAuction {
    function register(address token, uint64 endBlock, uint256 minBid) external;
    function SLOT_BLOCKS() external view returns (uint64);
}

interface IRegistry {
    function registerDirectLaunch(
        address token,
        address creator,
        address quote,
        address hook,
        address splitter,
        address locker,
        string calldata symbol,
        string calldata image
    ) external;
    function firstBuyLocker() external view returns (address);
}

/// @title HoodPortal
/// @notice The other way to launch: no curve, no graduation, no migration. The entire supply goes
///         into one Uniswap v4 position above the opening price, and buys walk the price up
///         through it. The liquidity is real from the first block and it is already locked.
/// @dev What this buys you over a bonding curve: there is no moment where a contract holds the
///      raise and has to be trusted to hand it over. What it costs you: the launch has to pick its
///      opening price and its bonding price up front, and a tax hook has to sit on the pool.
///
///      The hook's address is mined off chain because Uniswap v4 keeps a hook's permissions in the
///      low bits of its address. `HoodDirectDeployer.hookInitCodeHash` gives a miner everything it
///      needs, and this contract refuses a salt that does not land on the right bits.
///
///      The creator's first buy happens inside the launch transaction when they ask for one, swapped
///      straight against the PoolManager rather than through a router: that keeps the hook's view
///      of the caller honest (the portal, exempt from the opening surcharge) and the token's view of
///      the recipient honest (the creator, whom the launch block belongs to). The window's buy cap
///      still applies to it, so a creator gets first dibs, not the whole open.
///
///      A team launch (`createTeamLaunch`) does the same for a list of declared wallets: each one's
///      buy is swapped by this portal inside the launch transaction, so the hook sees the portal
///      and takes no surcharge, and then handed to the wallet, or written into the token lock in
///      its name. The hand-over is a transfer, so the launch's own hold cap applies to every team
///      wallet. Each wallet, its spend, its tokens and its lock are emitted for the app to label.
contract HoodPortal is Ownable2Step, ReentrancyGuard, IUnlockCallback, ITeamEvents {
    using SafeERC20 for IERC20;
    using PoolIdLibrary for PoolKey;
    using StateLibrary for IPoolManager;

    uint160 internal constant EXPECTED_FLAGS = 0xCC; // beforeSwap, afterSwap, and both return deltas
    uint160 internal constant FLAG_MASK = 0x3FFF;
    /// @dev v4's dynamic-fee flag. A pool opened with it has a zero LP fee that only a hook can set,
    ///      and this hook never does, so the locked position would earn nothing.
    uint24 internal constant DYNAMIC_FEE_FLAG = 0x800000;
    uint24 internal constant MAX_LP_FEE = 1_000_000;
    uint8 internal constant MINT_POSITION = 0x02;
    uint8 internal constant SETTLE_PAIR = 0x0d;
    /// @notice The longest the per-wallet caps may hold: two minutes at this chain's 100ms blocks.
    uint32 public constant MAX_RESTRICTION_BLOCKS = 1_200;
    /// @notice The ceilings on what a launch may charge as penalties and how long it may auction.
    uint16 public constant MAX_PENALTY_BPS = 2_500;
    uint32 public constant MAX_JEET_WINDOW_SECONDS = 3_600;
    uint24 public constant MAX_WHALE_TICK_LIMIT = 2_000;
    uint16 public constant MAX_KING_BPS = 5_000;
    uint32 public constant MAX_AUCTION_BLOCKS = 300;
    /// @notice The launch fee can be raised by the owner, but never past this.
    uint256 public constant MAX_LAUNCH_FEE = 0.01 ether;
    /// @notice Most wallets a team launch may buy for, so it never runs out of gas half way.
    uint256 public constant MAX_TEAM_LEGS = 40;
    /// @notice The most a launch may print. Above this the caps and the position maths silently
    ///         truncate: `maxHold` is a uint128 and Permit2's allowance is a uint160.
    uint256 public constant MAX_SUPPLY = type(uint128).max;

    HoodDirectDeployer public immutable deployer;
    address public immutable tokenImplementation;
    IPoolManager public immutable poolManager;
    IPositionManagerLite public immutable positionManager;
    IPermit2Lite public immutable permit2;
    /// @dev Set once after deployment: the module needs this portal's address, and this portal
    ///      needs the module's, so one of the two has to be wired second.
    address public buybackModule;

    address public treasury;
    address public registry;
    /// @notice The Bag: where the launch fee goes, and where every hook sends the platform's fee.
    ///         Set once; no launch can be created before it is.
    address public bag;
    /// @notice The shared sniper auction. Set once; a launch may only ask for an auction after.
    address public auction;
    /// @notice The referral registry a splitter reads when the protocol's tenth is claimed. Zero
    ///         turns the leg off for every direct launch.
    address public referrals;
    uint256 public launchFee = 0.002 ether;
    /// @notice A gate on NEW launches only: a staged open, or a stop on printing. Existing tokens
    ///         never notice it.
    bool public launchEnabled = true;
    bool public whitelistOnly;
    mapping(address => bool) public whitelisted;
    mapping(address quote => bool) public quoteAllowed;
    mapping(address token => DirectLaunch) internal _launches;
    address[] public allLaunches;

    event DirectLaunched(
        address indexed token,
        address indexed creator,
        address indexed quote,
        address hook,
        address splitter,
        address locker,
        uint256 positionId,
        uint64 restrictionsEndBlock,
        uint256 initialBuy
    );
    event DirectMetadata(address indexed token, string name, string symbol, string logo, string description);
    event TreasurySet(address treasury);
    event ReferralsSet(address referrals);
    event LaunchFeeSet(uint256 fee);
    event QuoteAllowed(address quote, bool allowed);
    event RegistrySet(address registry);
    event LaunchGateSet(bool enabled, bool whitelistOnly);
    event WhitelistSet(address indexed who, bool allowed);
    event BagSet(address bag);
    event AuctionSet(address auction);
    /// @notice The launch's penalty and auction settings, next to PoolOpened.
    event LaunchRules(
        address indexed token,
        uint16 jeetTaxBps,
        uint32 jeetWindowSeconds,
        uint16 whaleTaxBps,
        uint24 whaleTickLimit,
        uint16 kingBps,
        bool penaltiesToVault,
        uint32 auctionBlocks,
        uint64 auctionEndBlock
    );
    /// @notice Everything an indexer needs to follow the pool without calling back into the hook.
    event PoolOpened(
        address indexed token,
        bytes32 indexed poolId,
        uint24 fee,
        int24 tickSpacing,
        int24 tickStart,
        int24 tickBond,
        uint16 buyTaxBps,
        uint16 sellTaxBps,
        uint16 snipeTaxBps,
        uint32 snipeDecaySeconds,
        uint16 maxHoldBps,
        uint16 maxBuyBps
    );

    error BadHookSalt();
    error BadFee();
    error QuoteNotAllowed();
    error BadTicks();
    error BadSupply();
    error AlreadyWired();
    error NotPoolManager();
    error UnknownToken();
    error NotWired();
    error LaunchesPaused();
    error NotWhitelisted();
    error BadPoolFee();
    error BadWindow();
    error PoolAlreadyOpen();
    error BadPenalty();
    error NoAuction();
    error NoLegs();
    error TooManyLegs();
    error BadLeg();
    error UseLegs();

    struct LaunchInput {
        string name;
        string symbol;
        string logo;
        string description;
        Socials socials;
        address quote;
        /// Address allowed to claim the creator leg of the trading tax. Zero means msg.sender.
        address creatorFeeRecipient;
        uint256 supply;
        uint24 poolFee;
        int24 tickSpacing;
        DirectConfig config;
        bytes32 salt;
        /// Quote spent on the creator's own first buy, inside this transaction. Zero to skip.
        uint256 initialBuy;
    }

    struct BuyContext {
        PoolKey key;
        address quote;
        address token;
        uint256 amount;
        bool zeroForOne;
        address recipient;
    }

    constructor(
        address owner_,
        address treasury_,
        address deployer_,
        address tokenImplementation_,
        address poolManager_,
        address positionManager_,
        address permit2_
    ) Ownable(owner_) {
        treasury = treasury_;
        deployer = HoodDirectDeployer(deployer_);
        tokenImplementation = tokenImplementation_;
        poolManager = IPoolManager(poolManager_);
        positionManager = IPositionManagerLite(positionManager_);
        permit2 = IPermit2Lite(permit2_);
        quoteAllowed[address(0)] = true;
    }

    receive() external payable {}

    // ---------------------------------------------------------------- admin

    function setBuybackModule(address module) external onlyOwner {
        if (buybackModule != address(0)) revert AlreadyWired();
        buybackModule = module;
    }

    function setLaunchGate(bool enabled, bool whitelistOnly_) external onlyOwner {
        launchEnabled = enabled;
        whitelistOnly = whitelistOnly_;
        emit LaunchGateSet(enabled, whitelistOnly_);
    }

    function setWhitelisted(address who, bool allowed) external onlyOwner {
        whitelisted[who] = allowed;
        emit WhitelistSet(who, allowed);
    }

    function setTreasury(address t) external onlyOwner {
        treasury = t;
        emit TreasurySet(t);
    }

    function setLaunchFee(uint256 fee) external onlyOwner {
        if (fee > MAX_LAUNCH_FEE) revert BadFee();
        launchFee = fee;
        emit LaunchFeeSet(fee);
    }

    /// @notice Names the Bag, once. Launches are refused until it is set.
    function setBag(address bag_) external onlyOwner {
        if (bag != address(0)) revert AlreadyWired();
        bag = bag_;
        emit BagSet(bag_);
    }

    /// @notice Names the shared opening auction, once.
    function setAuction(address auction_) external onlyOwner {
        if (auction != address(0)) revert AlreadyWired();
        auction = auction_;
        emit AuctionSet(auction_);
    }

    /// @notice Points every splitter, live ones included, at a referral registry. Zero switches
    ///         the leg off; a registry that fails to answer is treated the same way by the splitters.
    function setReferrals(address referrals_) external onlyOwner {
        referrals = referrals_;
        emit ReferralsSet(referrals_);
    }

    function setQuote(address quote, bool allowed) external onlyOwner {
        quoteAllowed[quote] = allowed;
        emit QuoteAllowed(quote, allowed);
    }

    /// @notice Points direct launches at the shared registry, so a ticker lock, the staking vault
    ///         and the bridge see both kinds of launch as one platform.
    function setRegistry(address registry_) external onlyOwner {
        registry = registry_;
        emit RegistrySet(registry_);
    }

    // ---------------------------------------------------------------- views

    /// @notice Whether `who` may launch right now. The app and any router read this first.
    function canLaunch(address who) public view returns (bool) {
        if (!launchEnabled || buybackModule == address(0) || bag == address(0)) return false;
        return !whitelistOnly || whitelisted[who];
    }

    function getLaunch(address token) external view returns (DirectLaunch memory) {
        return _launches[token];
    }

    function launchCount() external view returns (uint256) {
        return allLaunches.length;
    }

    /// @notice What a miner has to hit: a hook address whose low fourteen bits equal this.
    function expectedHookFlags() external pure returns (uint160) {
        return EXPECTED_FLAGS;
    }

    /// @notice How far a launch is from bonding, in the shape Pons publishes it.
    /// @return currentTick where the price is now
    /// @return bondTick where it counts as bonded
    /// @return progressBps 0 at the open, 10,000 at the bonding tick, clamped
    /// @return bonded whether the latch has closed, which it never reopens
    function graduationStatus(address token)
        external
        view
        returns (int24 currentTick, int24 bondTick, uint256 progressBps, bool bonded)
    {
        DirectLaunch memory l = _launches[token];
        if (!l.exists) revert UnknownToken();
        HoodLaunchHook hook = HoodLaunchHook(payable(l.hook));
        PoolKey memory key = hook.poolKey();
        (, currentTick,,) = poolManager.getSlot0(key.toId());
        bondTick = hook.tickBond();
        bonded = hook.bonded();

        // The opening tick is the position's other edge: below the bond tick when the token is
        // currency0, above it otherwise.
        int24 startTick = _startTickOf(l.hook);
        int256 span = int256(bondTick) - int256(startTick);
        int256 travelled = int256(currentTick) - int256(startTick);
        if (span == 0) return (currentTick, bondTick, bonded ? 10_000 : 0, bonded);
        int256 bps = (travelled * 10_000) / span;
        if (bps < 0) bps = 0;
        if (bps > 10_000) bps = 10_000;
        progressBps = bonded ? 10_000 : uint256(bps);
    }

    /// @notice Where each launch's price opened. Public so an indexer arriving late can still
    ///         measure progress from the real start rather than from wherever the price is now.
    mapping(address hook => int24) public startTick;

    function _startTickOf(address hook) internal view returns (int24) {
        return startTick[hook];
    }

    // ---------------------------------------------------------------- launching

    struct Addresses {
        address token;
        address splitter;
        address hook;
        address locker;
        uint256 positionId;
    }

    function createLaunch(LaunchInput calldata p, bytes32 hookSalt)
        external
        payable
        nonReentrant
        returns (Addresses memory out)
    {
        PoolKey memory key;
        bool tokenIsZero;
        (out, key, tokenIsZero) = _create(p, hookSalt);

        uint256 spent = launchFee;
        if (p.initialBuy != 0) {
            _initialBuy(p, out.token, key, tokenIsZero, msg.sender);
            if (p.quote == address(0)) spent += p.initialBuy;
        }
        _settleValue(out.token, spent);
    }

    /// @notice A launch whose opening buys are a declared team's: every wallet in `legs` buys in
    ///         the launch transaction, before anyone else can. Send the launch fee, the legs (on a
    ///         native quote) and their gas; approve the legs on an ERC-20 quote.
    function createTeamLaunch(LaunchInput calldata p, bytes32 hookSalt, TeamBuy[] calldata legs)
        external
        payable
        nonReentrant
        returns (Addresses memory out)
    {
        if (p.initialBuy != 0) revert UseLegs();
        uint256 n = legs.length;
        if (n == 0) revert NoLegs();
        if (n > MAX_TEAM_LEGS) revert TooManyLegs();
        // Checked before anything is deployed, so a short payment says so instead of running
        // dry half way through the swaps.
        (uint256 total, uint256 gas) = _legTotals(legs);
        if (msg.value < launchFee + gas + (p.quote == address(0) ? total : 0)) revert BadFee();
        PoolKey memory key;
        bool tokenIsZero;
        (out, key, tokenIsZero) = _create(p, hookSalt);

        if (p.quote != address(0)) IERC20(p.quote).safeTransferFrom(msg.sender, address(this), total);
        address tokenLock = registry == address(0) ? address(0) : IRegistry(registry).firstBuyLocker();
        uint256 got;
        for (uint256 i; i < n; ++i) {
            got += _teamLeg(out.token, key, tokenIsZero, p.quote, tokenLock, legs[i], i);
        }
        emit TeamLaunched(out.token, out.hook, msg.sender, n, total, got);
        _settleValue(out.token, launchFee + gas + (p.quote == address(0) ? total : 0));
    }

    function _legTotals(TeamBuy[] calldata legs) internal pure returns (uint256 total, uint256 gas) {
        for (uint256 i; i < legs.length; ++i) {
            TeamBuy calldata l = legs[i];
            if (l.wallet == address(0) || l.pairIn == 0) revert BadLeg();
            for (uint256 j; j < i; ++j) {
                if (legs[j].wallet == l.wallet) revert BadLeg();
            }
            total += l.pairIn;
            gas += l.gas;
        }
    }

    /// @dev Swapped to this portal (exempt everywhere, so neither the launch block rule nor the buy
    ///      cap stops it), then handed over: a transfer to the wallet, which the hold cap still
    ///      sees, or a lock in the wallet's name.
    function _teamLeg(
        address token,
        PoolKey memory key,
        bool tokenIsZero,
        address quote,
        address tokenLock,
        TeamBuy calldata l,
        uint256 index
    ) internal returns (uint256 got) {
        uint256 before = IERC20(token).balanceOf(address(this));
        poolManager.unlock(
            abi.encode(
                BuyContext({
                    key: key, quote: quote, token: token, amount: l.pairIn, zeroForOne: !tokenIsZero, recipient: address(this)
                })
            )
        );
        got = IERC20(token).balanceOf(address(this)) - before;
        if (got < l.minTokensOut) revert BadLeg();

        uint256 lockId;
        uint64 unlockAt;
        if (l.lock == 0) {
            IERC20(token).safeTransfer(l.wallet, got);
        } else {
            if (tokenLock == address(0) || !IHoodTokenLock(tokenLock).isTier(l.lock)) revert BadLeg();
            IERC20(token).forceApprove(tokenLock, got);
            lockId = IHoodTokenLock(tokenLock).lockFor(token, l.wallet, got, l.lock);
            unlockAt = uint64(block.timestamp) + l.lock;
        }
        if (l.gas != 0) {
            PairTransfer.push(address(0), l.wallet, l.gas);
            emit TeamGas(token, l.wallet, l.gas);
        }
        emit TeamLeg(token, l.wallet, index, l.pairIn, got, lockId, unlockAt);
    }

    /// @dev The fee to the Bag and any native change back to the caller.
    function _settleValue(address token, uint256 spent) internal {
        if (msg.value < spent) revert BadFee();
        // Creators pay to be seen: the fee is the house's, through the Bag.
        IHoodBag(bag).takeHouseFee{value: launchFee}(address(0), launchFee, token);
        if (msg.value > spent) PairTransfer.push(address(0), msg.sender, msg.value - spent);
    }

    function _create(LaunchInput calldata p, bytes32 hookSalt)
        internal
        returns (Addresses memory out, PoolKey memory key, bool tokenIsZero)
    {
        if (buybackModule == address(0) || bag == address(0)) revert NotWired();
        if (!launchEnabled) revert LaunchesPaused();
        if (whitelistOnly && !whitelisted[msg.sender]) revert NotWhitelisted();
        if (!quoteAllowed[p.quote]) revert QuoteNotAllowed();
        if (msg.value < launchFee) revert BadFee();
        if (p.supply == 0 || p.supply > MAX_SUPPLY) revert BadSupply();
        if (p.poolFee & DYNAMIC_FEE_FLAG != 0 || p.poolFee > MAX_LP_FEE) revert BadPoolFee();
        _checkTicks(p);
        _checkWindow(p.config);
        _checkPenalties(p.config);

        bytes32 salt = keccak256(abi.encode(msg.sender, p.salt));
        out.token = deployer.cloneToken(tokenImplementation, salt);
        out.splitter = deployer.deploySplitter(treasury, buybackModule, out.token, p.quote, salt);
        // The hook salt is bound to the creator too: see HoodDirectDeployer.hookAddressFor.
        out.hook = deployer.deployHook(address(poolManager), keccak256(abi.encode(msg.sender, hookSalt)));
        if (uint160(out.hook) & FLAG_MASK != EXPECTED_FLAGS) revert BadHookSalt();
        out.locker = deployer.deployLocker(
            address(poolManager), address(positionManager), out.token, p.quote, out.splitter, salt
        );

        HoodLaunchToken(out.token).initialize(
            p.name, p.symbol, p.logo, p.description, p.socials, p.supply, msg.sender,
            p.config.restrictionBlocks, p.config.maxHoldBps, p.config.maxBuyBps
        );

        key = _poolKey(out.token, p.quote, p.poolFee, p.tickSpacing, out.hook);
        tokenIsZero = Currency.unwrap(key.currency0) == out.token;

        // Order matters, and the chain taught it: the pool has to be exempt from the opening window
        // and excluded from dividends BEFORE the supply is deposited into it, or the token's own
        // anti-snipe cap rejects its own liquidity and the dividend accumulator counts the pool as
        // the largest holder alive.
        _wire(p, out, key, tokenIsZero, p.creatorFeeRecipient == address(0) ? msg.sender : p.creatorFeeRecipient);

        // The token and the hook are CREATE2 addresses derived from a salt that is public the
        // moment the launch transaction is, so somebody watching can compute this pool's key and
        // open it first, at a price of their own, purely to make the launch revert. They cannot
        // take anything by it and the creator can come back with another salt; this is here so the
        // failure says what happened instead of surfacing v4's own error.
        try poolManager.initialize(key, TickMath.getSqrtPriceAtTick(p.config.tickStart)) returns (int24) {}
        catch {
            revert PoolAlreadyOpen();
        }
        out.positionId = _mintPosition(p, out, key, tokenIsZero);
        HoodLocker(payable(out.locker)).setPosition(out.positionId, key);

        // The liquidity maths asks for a hair less than the whole supply. The remainder is burned
        // rather than left in this contract, so no launch leaves a balance behind.
        uint256 dust = IERC20(out.token).balanceOf(address(this));
        if (dust != 0) HoodLaunchToken(out.token).burn(dust);

        startTick[out.hook] = p.config.tickStart;
        _register(p, out, msg.sender);
        _announcePool(p, out.token, key);
        _openAuction(p, out.token);
    }

    /// @dev Straight against the PoolManager, so the hook sees the portal as the caller and the
    ///      token sees the creator as the recipient. The window's buy cap applies as it would to
    ///      anyone: first dibs, not the whole open.
    function _initialBuy(LaunchInput calldata p, address token, PoolKey memory key, bool tokenIsZero, address creator)
        internal
    {
        if (p.quote != address(0)) IERC20(p.quote).safeTransferFrom(creator, address(this), p.initialBuy);
        poolManager.unlock(
            abi.encode(
                BuyContext({
                    key: key,
                    quote: p.quote,
                    token: token,
                    amount: p.initialBuy,
                    zeroForOne: !tokenIsZero,
                    recipient: creator
                })
            )
        );
    }

    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        if (msg.sender != address(poolManager)) revert NotPoolManager();
        BuyContext memory c = abi.decode(data, (BuyContext));

        BalanceDelta delta = poolManager.swap(
            c.key,
            SwapParams({
                zeroForOne: c.zeroForOne,
                amountSpecified: -int256(c.amount),
                sqrtPriceLimitX96: c.zeroForOne ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1
            }),
            bytes("")
        );

        if (c.quote == address(0)) {
            poolManager.settle{value: c.amount}();
        } else {
            poolManager.sync(Currency.wrap(c.quote));
            IERC20(c.quote).safeTransfer(address(poolManager), c.amount);
            poolManager.settle();
        }

        int128 out = c.zeroForOne ? delta.amount1() : delta.amount0();
        if (out > 0) poolManager.take(Currency.wrap(c.token), c.recipient, uint256(uint128(out)));
        return bytes("");
    }

    /// @dev The buy cap is per wallet and cumulative, the hold cap is per wallet and absolute. A
    ///      buy cap far above the hold cap is a cap on nothing; Pons pins it at 1.1x, and so do we.
    ///      The window also has a ceiling: `restrictionBlocks` is a uint32, and a launch that set
    ///      it to four billion with a hold cap of one basis point would be a token nobody can ever
    ///      hold more than a hundredth of a percent of. Every limit here expires by itself, and
    ///      MAX_RESTRICTION_BLOCKS is what makes that sentence true.
    function _checkWindow(DirectConfig calldata c) internal pure {
        if (c.restrictionBlocks == 0) return;
        if (c.restrictionBlocks > MAX_RESTRICTION_BLOCKS) revert BadWindow();
        if (c.maxHoldBps == 0 || c.maxBuyBps == 0) revert BadWindow();
        if (c.maxHoldBps > 10_000 || c.maxBuyBps > (uint256(c.maxHoldBps) * 11) / 10) revert BadWindow();
    }

    /// @dev The ceilings that keep a penalty a penalty: a quarter of the trade at most, a flip
    ///      window of an hour at most, a whale line no further than a doubling of the price, and
    ///      an auction that ends within half a minute of blocks.
    function _checkPenalties(DirectConfig calldata c) internal view {
        PenaltyConfig calldata pc = c.penalties;
        if (pc.jeetTaxBps > MAX_PENALTY_BPS || pc.whaleTaxBps > MAX_PENALTY_BPS) revert BadPenalty();
        if (pc.jeetWindowSeconds > MAX_JEET_WINDOW_SECONDS || pc.whaleTickLimit > MAX_WHALE_TICK_LIMIT) revert BadPenalty();
        if (pc.kingBps > MAX_KING_BPS) revert BadPenalty();
        // a rate with no window, or a whale line at zero, is a tax on everyone wearing another name
        if (pc.jeetTaxBps != 0 && pc.jeetWindowSeconds == 0) revert BadPenalty();
        if (pc.whaleTaxBps != 0 && pc.whaleTickLimit == 0) revert BadPenalty();
        if (c.auctionBlocks > MAX_AUCTION_BLOCKS) revert BadWindow();
        if (c.auctionBlocks != 0 && auction == address(0)) revert NoAuction();
    }

    /// @dev The sniper auction, when the launch chose it: the window starts after the creator's
    ///      block. For a launch quoted in the chain's own currency the first bid must at least
    ///      match the launch fee; for any other quote the market sets the floor.
    function _openAuction(LaunchInput calldata p, address token) internal {
        uint32 blocks = p.config.auctionBlocks;
        uint64 endBlock;
        if (blocks != 0) {
            endBlock = uint64(block.number) + blocks;
            IOpeningAuction a = IOpeningAuction(auction);
            a.register(token, endBlock, p.quote == address(0) ? launchFee : 0);
            HoodLaunchToken(token).setOpeningAuction(auction, endBlock, a.SLOT_BLOCKS());
        }
        PenaltyConfig calldata pc = p.config.penalties;
        emit LaunchRules(
            token, pc.jeetTaxBps, pc.jeetWindowSeconds, pc.whaleTaxBps, pc.whaleTickLimit, pc.kingBps,
            pc.penaltiesToVault, blocks, endBlock
        );
    }

    function _announcePool(LaunchInput calldata p, address token, PoolKey memory key) internal {
        DirectConfig calldata c = p.config;
        emit PoolOpened(
            token, PoolId.unwrap(key.toId()), key.fee, key.tickSpacing, c.tickStart, c.tickBond,
            c.buyTaxBps, c.sellTaxBps, c.snipeTaxBps, c.snipeDecaySeconds, c.maxHoldBps, c.maxBuyBps
        );
    }

    function _checkTicks(LaunchInput calldata p) internal pure {
        int24 spacing = p.tickSpacing;
        if (spacing <= 0) revert BadTicks();
        if (p.config.tickStart % spacing != 0 || p.config.tickBond % spacing != 0) revert BadTicks();
        if (p.config.tickStart == p.config.tickBond) revert BadTicks();
    }

    function _poolKey(address token, address quote, uint24 fee, int24 spacing, address hook)
        internal
        pure
        returns (PoolKey memory)
    {
        (address c0, address c1) = quote < token ? (quote, token) : (token, quote);
        return PoolKey({
            currency0: Currency.wrap(c0),
            currency1: Currency.wrap(c1),
            fee: fee,
            tickSpacing: spacing,
            hooks: IHooks(hook)
        });
    }

    /// @dev The whole supply, one position, entirely on the token side, sitting where the price has
    ///      to travel to reach it. Which side of the current price that is depends on which
    ///      currency the token sorted into.
    function _mintPosition(LaunchInput calldata p, Addresses memory out, PoolKey memory key, bool tokenIsZero)
        internal
        returns (uint256 positionId)
    {
        (int24 lower, int24 upper) = tokenIsZero
            ? (p.config.tickStart, p.config.tickBond)
            : (p.config.tickBond, p.config.tickStart);
        if (lower >= upper) revert BadTicks();

        uint160 sqrtLower = TickMath.getSqrtPriceAtTick(lower);
        uint160 sqrtUpper = TickMath.getSqrtPriceAtTick(upper);
        uint128 liquidity = tokenIsZero
            ? LiquidityAmounts.getLiquidityForAmount0(sqrtLower, sqrtUpper, p.supply)
            : LiquidityAmounts.getLiquidityForAmount1(sqrtLower, sqrtUpper, p.supply);

        IERC20(out.token).forceApprove(address(permit2), p.supply);
        permit2.approve(out.token, address(positionManager), uint160(p.supply), uint48(block.timestamp + 1));

        positionId = positionManager.nextTokenId();
        bytes memory actions = abi.encodePacked(MINT_POSITION, SETTLE_PAIR);
        bytes[] memory params = new bytes[](2);
        params[0] = abi.encode(key, lower, upper, liquidity, p.supply, p.supply, out.locker, bytes(""));
        params[1] = abi.encode(key.currency0, key.currency1);
        positionManager.modifyLiquidities(abi.encode(actions, params), block.timestamp);
    }

    function _wire(
        LaunchInput calldata p,
        Addresses memory out,
        PoolKey memory key,
        bool tokenIsZero,
        address creatorFeeRecipient
    ) internal {
        HoodLaunchHook.InitParams memory hp;
        hp.token = out.token;
        hp.quote = p.quote;
        hp.splitter = out.splitter;
        hp.factory = registry;
        hp.tokenIsZero = tokenIsZero;
        hp.buyTaxBps = p.config.buyTaxBps;
        hp.sellTaxBps = p.config.sellTaxBps;
        hp.snipeTaxBps = p.config.snipeTaxBps;
        hp.snipeDecaySeconds = p.config.snipeDecaySeconds;
        hp.tickBond = p.config.tickBond;
        hp.buybackModule = buybackModule;
        hp.bag = bag;
        hp.penalties = p.config.penalties;
        hp.key = key;
        HoodLaunchHook(payable(out.hook)).initialize(hp);

        HoodRevenueSplitter(payable(out.splitter)).initialize(creatorFeeRecipient, out.locker, p.config.allocations);
        HoodRevenueSplitter(payable(out.splitter)).setHook(out.hook);
        HoodRevenueSplitter(payable(out.splitter)).exclude(address(poolManager));
        // The token lock holds locked first buys and team legs for months in their owners' names.
        // It is not a holder with a share of anything, and the hold cap is for wallets, not for it.
        address tokenLock = registry == address(0) ? address(0) : IRegistry(registry).firstBuyLocker();
        if (tokenLock != address(0)) HoodRevenueSplitter(payable(out.splitter)).exclude(tokenLock);

        // In v4 every pool's tokens sit in the PoolManager, so that is the address a buy comes from.
        HoodLaunchToken(out.token).setLaunchAddresses(
            address(poolManager), out.splitter, out.locker, out.hook, buybackModule, tokenLock
        );
    }

    function _register(LaunchInput calldata p, Addresses memory out, address creator) internal {
        _launches[out.token] = DirectLaunch({
            token: out.token,
            quote: p.quote,
            hook: out.hook,
            splitter: out.splitter,
            locker: out.locker,
            creator: creator,
            positionId: out.positionId,
            launchedAt: uint64(block.timestamp),
            restrictionsEndBlock: uint64(block.number) + p.config.restrictionBlocks,
            exists: true
        });
        allLaunches.push(out.token);

        address r = registry;
        if (r != address(0)) {
            IRegistry(r).registerDirectLaunch(
                out.token, creator, p.quote, out.hook, out.splitter, out.locker, p.symbol, p.logo
            );
        }

        emit DirectLaunched(
            out.token, creator, p.quote, out.hook, out.splitter, out.locker, out.positionId,
            uint64(block.number) + p.config.restrictionBlocks, p.initialBuy
        );
        emit DirectMetadata(out.token, p.name, p.symbol, p.logo, p.description);
    }
}
