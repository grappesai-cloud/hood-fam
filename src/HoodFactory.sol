// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import {CurveConfig, FeeSplit, Launch, LaunchMode, LaunchParams} from "./HoodTypes.sol";
import {PenaltyConfig} from "./bag/BagTypes.sol";
import {HoodCurve} from "./HoodCurve.sol";
import {HoodDeployer} from "./HoodDeployer.sol";
import {PairTransfer} from "./libraries/PairTransfer.sol";
import {IGraduationHandler} from "./interfaces/IGraduationHandler.sol";
import {IHoodBag} from "./interfaces/IHoodBag.sol";
import {IHoodCurve} from "./interfaces/IHoodCurve.sol";
import {IHoodFactory} from "./interfaces/IHoodFactory.sol";
import {IHoodStaking} from "./interfaces/IHoodStaking.sol";
import {IHoodToken} from "./interfaces/IHoodToken.sol";
import {IHoodTokenLock} from "./interfaces/IHoodTokenLock.sol";

/// @dev The one administrative call the factory makes into a pot. Not on IHoodPot, whose surface
///      is for payers and holders.
interface IHoodPotAdmin {
    function exclude(address who) external;
}

/// @title HoodFactory
/// @notice The launchpad. Prints a token, opens its curve, keeps the registry, and runs the
///         copycat lock that keeps a working ticker from being reused while it is hot.
/// @dev The owner can change what FUTURE launches get: presets, the launch fee, the pair allow
///      list, the graduation handler. Nothing the owner can do reaches a token that already
///      exists: its curve holds every parameter as an immutable, and its fee split is written
///      once at launch.
contract HoodFactory is IHoodFactory, Ownable2Step, ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint256 internal constant BPS = 10_000;
    uint256 internal constant WAD = 1e18;
    /// @notice Volume that counts towards the copycat lock is measured over this window.
    uint64 public constant VOLUME_WINDOW = 24 hours;
    /// @notice How long a ticker and an artwork stay locked after the volume threshold is hit.
    uint64 public constant LOCK_DURATION = 48 hours;
    /// @notice A live lock is only rewritten this often, so a hot token does not pay for a lock
    ///         refresh on every single trade.
    uint64 internal constant LOCK_REFRESH = 1 hours;
    bytes32 internal constant EMPTY_HASH = keccak256("");
    /// @notice The launch fee is owner-settable up to here and no further.
    uint256 public constant MAX_LAUNCH_FEE = 0.01 ether;

    struct VolumeWindow {
        uint64 start;
        uint192 volume;
    }

    /// @notice Holds the token and curve bytecode, so this contract stays under the size limit.
    HoodDeployer public immutable deployer;

    address public treasury;
    address public feeRouter;
    address public staking;
    /// @notice Where a creator's first buy is held. Not the staking vault: that one is for the
    ///         house coin alone, and a launched token has no business in it.
    address public firstBuyLocker;
    /// @notice Handler handed to new launches. Live curves keep the one they were born with.
    address public graduationHandler;
    /// @notice Charged on every launch, in native currency, paid into the Bag as a house fee.
    uint256 public launchFee;
    /// @notice The referral registry a curve reads when the protocol's share is claimed. Zero
    ///         turns the leg off for every curve launched here.
    address public referrals;
    /// @notice The Bag: where the launch fee goes, and where every curve launched here sends its
    ///         protocol legs. Set once. No launch is possible before it is.
    address public bag;

    uint256 public configCount;
    mapping(uint256 configId => CurveConfig) internal _configs;
    mapping(address token => Launch) internal _launches;
    /// @dev Kept off the Launch row so the modules that load a row on every flush do not pay for
    ///      fields only the graduation hook reads.
    mapping(address token => PenaltyConfig) internal _penalties;
    mapping(address curve => address token) public tokenOfCurve;
    /// @notice The direct-launch portal, allowed to register launches of its own kind.
    address public portal;
    mapping(address pairToken => bool) public pairAllowed;
    /// @notice 24h volume, in pair units, that locks a ticker and an artwork. Zero disables the lock.
    mapping(address pairToken => uint256) public lockThreshold;

    mapping(address token => VolumeWindow) public volumeWindow;
    mapping(bytes32 symbolHash => uint64) public symbolLockedUntil;
    mapping(bytes32 symbolHash => address) public symbolLockOwner;
    mapping(bytes32 imageHash => uint64) public imageLockedUntil;
    mapping(bytes32 imageHash => address) public imageLockOwner;

    /// @dev Split in two on purpose. Thirteen values in one event puts the Yul optimizer over its
    ///      stack limit, and an indexer wants the compact row separately from the prose anyway.
    event Launched(
        address indexed token,
        address indexed curve,
        address indexed creator,
        uint256 configId,
        address pairToken,
        FeeSplit feeSplit
    );
    /// @dev Fires only when a creator locked their own first buy, in the same transaction and right
    ///      after `Launched`. The amount and the unlock also sit on the registry row, so an app can
    ///      show the lock without replaying any logs; the position id is only here.
    event FirstBuyLocked(
        address indexed token, address indexed creator, uint256 positionId, uint256 amount, uint64 unlockAt
    );
    event LaunchMetadata(
        address indexed token,
        string name,
        string symbol,
        string image,
        string description,
        string website,
        string twitter,
        string telegram
    );
    /// @dev Fires right after `Launched`, in the same transaction, for every curve launch.
    event PotDeployed(address indexed token, address indexed pot);
    /// @dev Fires after `PotDeployed`, all zero when the creator turned nothing on.
    event LaunchPenalties(address indexed token, PenaltyConfig penalties);
    event CreatorFeeRecipientTransferred(address indexed token, address indexed from, address indexed to);
    event ConfigAdded(uint256 indexed configId);
    event ConfigEnabled(uint256 indexed configId, bool enabled);
    event TickerLocked(address indexed token, bytes32 indexed symbolHash, uint64 until);
    event ModulesSet(address feeRouter, address staking, address graduationHandler);
    event FirstBuyLockerSet(address locker);
    event PortalSet(address portal);
    event DirectLaunchRegistered(address indexed token, address indexed creator, address hook);
    event TreasurySet(address treasury);
    event BagSet(address bag);
    event ReferralsSet(address referrals);
    event LaunchFeeSet(uint256 fee);
    event PairAllowed(address pairToken, bool allowed, uint256 lockThreshold);
    event CustomPairLaunched(address indexed pairToken, uint8 decimals, uint256 indexed configId);

    error ConfigDisabled();
    error PairNotAllowed();
    error PairMismatch();
    error BadEconomics();
    error BadFee();
    error BadSplit();
    error BadLock();
    error NoHouseToken();
    error NoFirstBuy();
    error TickerLockedError();
    error ImageLockedError();
    error NotRecipient();
    error NotACurve();
    error ZeroAddress();
    error ModulesAlreadySet();
    error BadConfig();
    error SymbolTooLong();
    error InvalidPairToken();
    error UnsupportedPairDecimals();
    error NotPortal();
    error AlreadyRegistered();
    error NoBag();
    error BadPenalties();

    /// @dev Takes refunds from a creator's first buy on the way back out to them.
    receive() external payable {}

    constructor(address owner_, address treasury_, address deployer_) Ownable(owner_) {
        if (treasury_ == address(0) || deployer_ == address(0)) revert ZeroAddress();
        deployer = HoodDeployer(deployer_);
        treasury = treasury_;
        pairAllowed[address(0)] = true;
    }

    /// @dev Both `Ownable` and `IHoodFactory` declare it; the modules ask the factory who its owner
    ///      is, so the interface has to carry it.
    function owner() public view override(Ownable, IHoodFactory) returns (address) {
        return Ownable.owner();
    }

    // ---------------------------------------------------------------- admin

    /// @notice Wires the modules that have to know the factory address. Callable once.
    function setModules(address feeRouter_, address staking_, address graduationHandler_) external onlyOwner {
        if (feeRouter != address(0) || staking != address(0)) revert ModulesAlreadySet();
        if (feeRouter_ == address(0) || staking_ == address(0) || graduationHandler_ == address(0)) {
            revert ZeroAddress();
        }
        feeRouter = feeRouter_;
        staking = staking_;
        graduationHandler = graduationHandler_;
        emit ModulesSet(feeRouter_, staking_, graduationHandler_);
    }

    /// @notice Names the contract that holds creators' first buys. Once.
    /// @dev Separate from `setModules` so an existing deployment can be given one without being
    ///      redeployed, and once-only because a launch that recorded a lock has to keep pointing at
    ///      the contract actually holding those tokens.
    function setFirstBuyLocker(address locker) external onlyOwner {
        if (locker == address(0)) revert ZeroAddress();
        if (firstBuyLocker != address(0)) revert ModulesAlreadySet();
        firstBuyLocker = locker;
        emit FirstBuyLockerSet(locker);
    }

    /// @notice Points new launches at a different graduation handler. Live curves are untouched.
    function setGraduationHandler(address handler) external onlyOwner {
        if (handler == address(0)) revert ZeroAddress();
        graduationHandler = handler;
        emit ModulesSet(feeRouter, staking, handler);
    }

    /// @notice Lets the direct-launch portal write into this registry.
    /// @dev One registry for both machines, so a ticker lock, the staking vault, the points and
    ///      the bridge see one platform rather than two.
    function setPortal(address portal_) external onlyOwner {
        portal = portal_;
        emit PortalSet(portal_);
    }

    function setTreasury(address treasury_) external onlyOwner {
        if (treasury_ == address(0)) revert ZeroAddress();
        treasury = treasury_;
        emit TreasurySet(treasury_);
    }

    /// @notice Names the Bag. Once: every curve pins it at launch, and the Bag itself has no owner
    ///         and no setter, so there is nothing a second Bag could be for except a second set of
    ///         rules under tokens already sold on the first.
    function setBag(address bag_) external onlyOwner {
        if (bag_ == address(0)) revert ZeroAddress();
        if (bag != address(0)) revert ModulesAlreadySet();
        bag = bag_;
        emit BagSet(bag_);
    }

    /// @notice Sets the launch fee, up to `MAX_LAUNCH_FEE`.
    function setLaunchFee(uint256 fee) external onlyOwner {
        if (fee > MAX_LAUNCH_FEE) revert BadFee();
        launchFee = fee;
        emit LaunchFeeSet(fee);
    }

    /// @notice Points every curve, live ones included, at a referral registry. Zero switches the
    ///         leg off; a registry that fails to answer is treated the same way by the curves.
    function setReferrals(address referrals_) external onlyOwner {
        referrals = referrals_;
        emit ReferralsSet(referrals_);
    }

    function setPair(address pairToken, bool allowed, uint256 threshold) external onlyOwner {
        pairAllowed[pairToken] = allowed;
        lockThreshold[pairToken] = threshold;
        emit PairAllowed(pairToken, allowed, threshold);
    }

    /// @notice Adds a launch preset. Presets are append-only: an existing one is never edited, so
    ///         nothing can change under a token that already launched on it.
    function addConfig(CurveConfig calldata c) external onlyOwner returns (uint256 configId) {
        _validateConfig(c);
        // A preset for an asset this pad does not take is a preset nobody can ever launch on.
        if (!pairAllowed[c.pairToken]) revert PairNotAllowed();
        configId = configCount++;
        _configs[configId] = c;
        _configs[configId].enabled = true;
        emit ConfigAdded(configId);
    }

    function setConfigEnabled(uint256 configId, bool enabled) external onlyOwner {
        _configs[configId].enabled = enabled;
        emit ConfigEnabled(configId, enabled);
    }

    // ---------------------------------------------------------------- views

    function getConfig(uint256 configId) external view returns (CurveConfig memory) {
        return _configs[configId];
    }

    function getLaunch(address token) external view returns (Launch memory) {
        return _launches[token];
    }

    function creatorFeeRecipient(address token) external view returns (address) {
        return _launches[token].creatorFeeRecipient;
    }

    function feeSplit(address token) external view returns (FeeSplit memory) {
        return _launches[token].feeSplit;
    }

    /// @inheritdoc IHoodFactory
    function penaltiesOf(address token) external view returns (PenaltyConfig memory) {
        return _penalties[token];
    }

    /// @notice Hash of everything that decides a launch's economics right now.
    /// @dev A creator reads this, then passes it back in `LaunchParams.econ`. If anything moved in
    ///      between, the launch reverts instead of landing on terms nobody agreed to.
    function previewLaunchEconomics(uint256 configId, address pairToken) public view returns (bytes32) {
        CurveConfig memory c = _configs[configId];
        return keccak256(
            abi.encode(
                configId,
                pairToken,
                c.totalSupply,
                c.curveSupplyBps,
                c.startCap,
                c.graduationCap,
                c.liquidityBps,
                c.protocolFeeBps,
                c.creatorFeeBps,
                c.poolFee,
                c.tickSpacing,
                launchFee,
                feeRouter,
                staking,
                graduationHandler
            )
        );
    }

    /// @notice Whether a ticker can be used for a new launch right now.
    function isSymbolAvailable(string calldata symbol_) external view returns (bool) {
        bytes32 h = symbolHash(symbol_);
        return symbolLockedUntil[h] <= block.timestamp;
    }

    /// @notice Case-insensitive hash of a ticker, which is what the copycat lock keys on.
    function symbolHash(string memory symbol_) public pure returns (bytes32) {
        bytes memory b = bytes(symbol_);
        if (b.length > 32) revert SymbolTooLong();
        for (uint256 i; i < b.length; ++i) {
            if (b[i] >= 0x41 && b[i] <= 0x5A) b[i] = bytes1(uint8(b[i]) + 32);
        }
        return keccak256(b);
    }

    // ---------------------------------------------------------------- launching

    /// @notice Prints a token and opens its curve. Anything sent above the launch fee is spent on
    ///         the creator's own first buy, in the same transaction, so nobody can front-run it.
    function launch(LaunchParams calldata p)
        external
        payable
        nonReentrant
        returns (address token, address curve, uint256 bought)
    {
        CurveConfig memory c = _configs[p.configId];
        if (!c.enabled) revert ConfigDisabled();
        return _launch(p, c, p.configId);
    }

    /// @notice Permissionless meme-to-meme launch. The creator supplies the curve in the custom
    ///         quote's smallest units; no owner allow-list transaction is required first.
    /// @dev The quote still has to be a conventional ERC-20 with at most eighteen decimals. Tokens
    ///      that tax transfers are rejected by PairTransfer on the first trade instead of corrupting
    ///      the reserve. Every custom curve is persisted as its own immutable preset so indexers and
    ///      buyers can reconstruct exactly what the creator signed.
    function launchCustom(LaunchParams calldata p, CurveConfig calldata custom)
        external
        payable
        nonReentrant
        returns (address token, address curve, uint256 bought)
    {
        if (p.pairToken == address(0) || p.pairToken.code.length == 0) revert InvalidPairToken();
        if (custom.pairToken != p.pairToken) revert PairMismatch();

        uint8 decimals;
        try IERC20Metadata(p.pairToken).decimals() returns (uint8 d) {
            decimals = d;
        } catch {
            revert InvalidPairToken();
        }
        if (decimals > 18) revert UnsupportedPairDecimals();

        CurveConfig memory c = custom;
        c.enabled = true;
        _validateConfig(c);

        uint256 configId = configCount++;
        _configs[configId] = c;
        if (!pairAllowed[p.pairToken]) {
            pairAllowed[p.pairToken] = true;
            emit PairAllowed(p.pairToken, true, 0);
        }
        emit ConfigAdded(configId);
        emit CustomPairLaunched(p.pairToken, decimals, configId);
        return _launch(p, c, configId);
    }

    function _launch(LaunchParams calldata p, CurveConfig memory c, uint256 configId)
        internal
        returns (address token, address curve, uint256 bought)
    {
        uint256 launchFee_ = launchFee;
        if (msg.value < launchFee_) revert BadFee();
        if (!pairAllowed[p.pairToken]) revert PairNotAllowed();
        // The preset's caps are in its own pair's units, so launching one against another asset
        // would open at a valuation nobody chose. The contract refuses rather than leaving it to
        // whichever app the creator happened to use.
        if (p.pairToken != c.pairToken) revert PairMismatch();
        if (p.econ != bytes32(0) && p.econ != previewLaunchEconomics(configId, p.pairToken)) revert BadEconomics();
        // The four legs have to be the whole of the creator leg. All four at zero fails the same
        // check, because money booked with nowhere to go could never leave the router again.
        uint256 legs =
            uint256(p.feeSplit.stakersBps) + p.feeSplit.buybackBps + p.feeSplit.liquidityBps + p.feeSplit.creatorBps;
        if (legs != BPS) revert BadSplit();
        // The stakers leg pays whoever locked the house coin. Until the owner has named that coin
        // there is nobody to pay, and a launch that promised a share to stakers would be pointing
        // at an empty room for the rest of its life. Refused rather than accrued into nothing.
        if (p.feeSplit.stakersBps != 0 && IHoodStaking(staking).houseToken() == address(0)) revert NoHouseToken();
        if (p.feeSplit.creatorBps != 0 && p.creatorFeeRecipient == address(0)) revert ZeroAddress();
        _checkFirstBuyLock(p, msg.value - launchFee_);
        _validatePenalties(p.penalties);

        bytes32 sHash = symbolHash(p.symbol);
        bytes32 iHash = keccak256(bytes(p.image));
        if (symbolLockedUntil[sHash] > block.timestamp) revert TickerLockedError();
        if (bytes(p.image).length != 0 && imageLockedUntil[iHash] > block.timestamp) revert ImageLockedError();

        address pot;
        (token, curve, pot) = _deploy(p, c);
        _register(token, curve, pot, p, configId, sHash, iHash);

        // The fee is the house's, and the house is paid through the Bag like everything else, so
        // the Bag's tape shows it. Skipped at zero: nothing to book, nothing to emit.
        if (launchFee_ != 0) IHoodBag(bag).takeHouseFee{value: launchFee_}(address(0), launchFee_, token);
        bought = _firstBuy(p, token, curve, msg.value - launchFee_);
    }

    /// @dev The creator's options are capped where a tax stops being a deterrent and becomes a
    ///      trap: a quarter on a flip or a dump, an hour to count as a flip, twenty percent of
    ///      price move to count as a dump, half of the holder share into the king pot.
    function _validatePenalties(PenaltyConfig calldata pc) internal pure {
        if (pc.jeetTaxBps > 2_500 || pc.whaleTaxBps > 2_500) revert BadPenalties();
        if (pc.jeetWindowSeconds > 1 hours) revert BadPenalties();
        if (pc.whaleTickLimit > 2_000) revert BadPenalties();
        if (pc.kingBps > 5_000) revert BadPenalties();
    }

    function _validateConfig(CurveConfig memory c) internal pure {
        if (c.totalSupply == 0 || c.curveSupplyBps == 0 || c.curveSupplyBps >= BPS) revert BadConfig();
        if (c.graduationCap <= c.startCap || c.startCap == 0) revert BadConfig();
        // A cap so small that it rounds the opening price to zero creates free tokens.
        if (Math.mulDiv(c.startCap, WAD, c.totalSupply) == 0) revert BadConfig();
        // The pool has to get the lion's share of the raise, or graduation is an exit.
        if (c.liquidityBps < 8000 || c.liquidityBps > BPS) revert BadConfig();
        if (uint256(c.protocolFeeBps) + c.creatorFeeBps > 500) revert BadFee();
        if (c.tickSpacing <= 0) revert BadConfig();
    }

    /// @dev A lock is one of the locker's lengths or nothing: asked in seconds of its own, the app,
    ///      this factory and the locker would each round the same number their own way and the
    ///      creator would be shown an unlock date the locker does not hold them to.
    function _checkFirstBuyLock(LaunchParams calldata p, uint256 nativeLeft) internal view {
        if (p.firstBuyLock == 0) return;
        address locker = firstBuyLocker;
        if (locker == address(0) || !IHoodTokenLock(locker).isTier(p.firstBuyLock)) revert BadLock();
        // Locking nothing leaves a creator believing their first buy is locked when there was no
        // first buy at all, so it is refused rather than quietly ignored.
        if ((p.pairToken == address(0) ? nativeLeft : p.firstBuy) == 0) revert NoFirstBuy();
    }

    function _deploy(LaunchParams calldata p, CurveConfig memory c)
        internal
        returns (address token, address curve, address pot)
    {
        // A curve pins its Bag for life. Without one it could never claim a fee or finalize, so a
        // launch before the Bag is named would print a token that can never graduate.
        address bag_ = bag;
        if (bag_ == address(0)) revert NoBag();

        bytes32 salt = keccak256(abi.encode(msg.sender, p.salt));
        token = deployer.deployToken(p.name, p.symbol, p.image, p.description, c.totalSupply, address(this), salt);
        // Named before the supply moves, so the pot sees every balance from the first transfer.
        pot = deployer.deployPot(address(this), token, p.pairToken);
        IHoodToken(token).setPot(pot);

        // Filled field by field rather than as one literal: as a literal this is sixteen live
        // values at once and the Yul optimizer runs out of stack slots.
        HoodCurve.InitParams memory ip;
        ip.factory = address(this);
        ip.token = token;
        ip.pairToken = p.pairToken;
        ip.bag = bag_;
        ip.pot = pot;
        ip.feeRouter = feeRouter;
        ip.graduationHandler = graduationHandler;
        ip.curveSupply = Math.mulDiv(c.totalSupply, c.curveSupplyBps, BPS);
        ip.lpSupply = c.totalSupply - ip.curveSupply;
        ip.p0 = Math.mulDiv(c.startCap, WAD, c.totalSupply);
        ip.p1 = Math.mulDiv(c.graduationCap, WAD, c.totalSupply);
        ip.liquidityBps = c.liquidityBps;
        ip.protocolFeeBps = c.protocolFeeBps;
        ip.creatorFeeBps = c.creatorFeeBps;
        ip.poolFee = c.poolFee;
        ip.tickSpacing = c.tickSpacing;

        curve = deployer.deployCurve(ip, salt);
        // Nobody who holds tokens for the machine's own sake earns from the pot: the curve and the
        // graduator hold the supply on its way to buyers and to the pool, the pot never holds any,
        // and the first-buy locker and the staking vault hold what is somebody else's for months
        // with no way to pass a payout on. Excluded before the supply moves, so nothing to unwind.
        _exclude(pot, curve);
        _exclude(pot, graduationHandler);
        _exclude(pot, pot);
        _exclude(pot, firstBuyLocker);
        _exclude(pot, staking);
        IERC20(token).safeTransfer(curve, c.totalSupply);

        // Open the pool now, at the price this launch is heading for, so nobody can open it first
        // at a price of their own. A handler that cannot do it must not be able to stop a launch.
        uint256 plannedPair = Math.mulDiv(IHoodCurve(curve).raiseTarget(), c.liquidityBps, BPS);
        try IGraduationHandler(graduationHandler)
            .prepare(token, p.pairToken, c.totalSupply - ip.curveSupply, plannedPair, c.poolFee, c.tickSpacing) {}
            catch {}
    }

    function _exclude(address pot, address who) internal {
        if (who != address(0)) IHoodPotAdmin(pot).exclude(who);
    }

    function _register(
        address token,
        address curve,
        address pot,
        LaunchParams calldata p,
        uint256 configId,
        bytes32 sHash,
        bytes32 iHash
    ) internal {
        _launches[token] = Launch({
            curve: curve,
            creator: msg.sender,
            creatorFeeRecipient: p.creatorFeeRecipient == address(0) ? msg.sender : p.creatorFeeRecipient,
            pairToken: p.pairToken,
            configId: configId,
            feeSplit: p.feeSplit,
            symbolHash: sHash,
            imageHash: iHash,
            launchedAt: uint64(block.timestamp),
            exists: true,
            mode: LaunchMode.Curve,
            firstBuyLocked: 0,
            firstBuyUnlockAt: 0,
            hook: address(0),
            splitter: address(0),
            locker: address(0),
            pot: pot
        });
        tokenOfCurve[curve] = token;
        _penalties[token] = p.penalties;

        emit Launched(token, curve, msg.sender, configId, p.pairToken, p.feeSplit);
        emit LaunchMetadata(token, p.name, p.symbol, p.image, p.description, p.website, p.twitter, p.telegram);
        emit PotDeployed(token, pot);
        emit LaunchPenalties(token, p.penalties);
    }

    function _firstBuy(LaunchParams calldata p, address token, address curve, uint256 nativeLeft)
        internal
        returns (uint256 bought)
    {
        // A locked first buy is bought to this contract and staked from here, so the tokens never
        // pass through the creator's wallet on the way to the vault.
        address to = p.firstBuyLock == 0 ? msg.sender : address(this);
        if (p.pairToken == address(0)) {
            if (nativeLeft == 0) return 0;
            // Measured, not swept: `address(this).balance` would hand this creator whatever native
            // currency happened to be sitting here from anywhere else, and a contract with a
            // `receive` accumulates strays.
            uint256 before = address(this).balance - nativeLeft;
            bought = IHoodCurve(curve).buy{value: nativeLeft}(nativeLeft, 0, to);
            // The curve hands back whatever it could not absorb; it belongs to the creator.
            PairTransfer.push(address(0), msg.sender, address(this).balance - before);
        } else {
            if (nativeLeft != 0) revert BadFee();
            uint256 amount = p.firstBuy;
            if (amount == 0) return 0;
            // The curve refunds an oversized buy to its caller (this factory), not directly to
            // the creator. Measure this launch's balance delta so existing stray funds stay put.
            uint256 before = IERC20(p.pairToken).balanceOf(address(this));
            PairTransfer.pull(p.pairToken, msg.sender, amount, 0);
            IERC20(p.pairToken).forceApprove(curve, amount);
            bought = IHoodCurve(curve).buy(amount, 0, to);
            PairTransfer.push(p.pairToken, msg.sender, IERC20(p.pairToken).balanceOf(address(this)) - before);
        }
        if (to != msg.sender) _lockFirstBuy(token, bought, p.firstBuyLock);
    }

    /// @dev The creator's first buy, held in the locker in their name instead of in their wallet.
    ///      It earns nothing: the tokens are there to say one thing, which is that the person who
    ///      bought ahead of everyone else cannot sell into the people who bought next. The locker
    ///      will not let them out a second early, and nobody, including this factory, can.
    function _lockFirstBuy(address token, uint256 amount, uint64 lockDuration) internal {
        address locker = firstBuyLocker;
        IERC20(token).forceApprove(locker, amount);
        uint256 positionId = IHoodTokenLock(locker).lockFor(token, msg.sender, amount, lockDuration);
        uint64 unlockAt = uint64(block.timestamp) + lockDuration;
        Launch storage l = _launches[token];
        l.firstBuyLocked = amount;
        l.firstBuyUnlockAt = unlockAt;
        emit FirstBuyLocked(token, msg.sender, positionId, amount, unlockAt);
    }

    // ---------------------------------------------------------------- registry writes

    /// @notice Hands the creator fee stream to somebody else. One step, current recipient only.
    function transferCreatorFeeRecipient(address token, address to) external {
        Launch storage l = _launches[token];
        if (msg.sender != l.creatorFeeRecipient) revert NotRecipient();
        if (to == address(0)) revert ZeroAddress();
        l.creatorFeeRecipient = to;
        emit CreatorFeeRecipientTransferred(token, msg.sender, to);
    }

    /// @notice Registers a launch the portal made, under the same rules as one made here.
    function registerDirectLaunch(
        address token,
        address creator,
        address quote,
        address hook,
        address splitter,
        address locker,
        string calldata symbol_,
        string calldata image
    ) external {
        if (msg.sender != portal || portal == address(0)) revert NotPortal();
        if (_launches[token].exists) revert AlreadyRegistered();

        bytes32 sHash = symbolHash(symbol_);
        bytes32 iHash = keccak256(bytes(image));
        if (symbolLockedUntil[sHash] > block.timestamp) revert TickerLockedError();
        if (bytes(image).length != 0 && imageLockedUntil[iHash] > block.timestamp) revert ImageLockedError();

        _launches[token] = Launch({
            curve: address(0),
            creator: creator,
            creatorFeeRecipient: creator,
            pairToken: quote,
            configId: 0,
            // A direct launch never books anything in the fee router; its tax is split in its own
            // splitter, under allocations the portal writes there and nothing here can read.
            feeSplit: FeeSplit({stakersBps: 0, buybackBps: 0, liquidityBps: 0, creatorBps: 0}),
            symbolHash: sHash,
            imageHash: iHash,
            launchedAt: uint64(block.timestamp),
            exists: true,
            mode: LaunchMode.Direct,
            firstBuyLocked: 0,
            firstBuyUnlockAt: 0,
            hook: hook,
            splitter: splitter,
            locker: locker,
            // A direct launch's splitter is its pot: same accumulator, same IHoodPot surface.
            pot: splitter
        });
        emit DirectLaunchRegistered(token, creator, hook);
    }

    /// @inheritdoc IHoodFactory
    function recordVolume(address token, uint256 pairAmount) external {
        // This runs on every trade, so it reads the launch row a field at a time from storage rather
        // than copying the whole struct into memory: the common path (a trade under the copycat
        // lock's threshold, which is most trades) only needs the reporter check and the pair asset,
        // three slots instead of the sixteen a `Launch memory` load would fetch cold. The ticker
        // hashes are read only if a trade actually trips the lock.
        Launch storage l = _launches[token];
        // Either machine may report: a curve for its own token, a hook for its own pool.
        address curve = l.curve;
        address hook = l.hook;
        bool reporter = (curve != address(0) && msg.sender == curve) || (hook != address(0) && msg.sender == hook);
        if (!reporter) revert NotACurve();

        VolumeWindow memory w = volumeWindow[token];
        if (block.timestamp - w.start >= VOLUME_WINDOW) {
            w.start = uint64(block.timestamp);
            w.volume = 0;
        }
        w.volume += uint192(pairAmount);
        volumeWindow[token] = w;

        uint256 threshold = lockThreshold[l.pairToken];
        if (threshold == 0 || w.volume < threshold) return;

        bytes32 sHash = l.symbolHash;
        uint64 until = uint64(block.timestamp) + LOCK_DURATION;
        if (symbolLockedUntil[sHash] + LOCK_REFRESH < until) {
            symbolLockedUntil[sHash] = until;
            symbolLockOwner[sHash] = token;
            bytes32 iHash = l.imageHash;
            if (iHash != EMPTY_HASH) {
                imageLockedUntil[iHash] = until;
                imageLockOwner[iHash] = token;
            }
            emit TickerLocked(token, sHash, until);
        }
    }
}
