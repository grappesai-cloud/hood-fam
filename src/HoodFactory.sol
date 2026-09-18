// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import {CurveConfig, FeeModel, Launch, LaunchMode, LaunchParams} from "./HoodTypes.sol";
import {HoodCurve} from "./HoodCurve.sol";
import {HoodDeployer} from "./HoodDeployer.sol";
import {PairTransfer} from "./libraries/PairTransfer.sol";
import {IGraduationHandler} from "./interfaces/IGraduationHandler.sol";
import {IHoodCurve} from "./interfaces/IHoodCurve.sol";
import {IHoodFactory} from "./interfaces/IHoodFactory.sol";

/// @title HoodFactory
/// @notice The launchpad. Prints a token, opens its curve, keeps the registry, and runs the
///         copycat lock that keeps a working ticker from being reused while it is hot.
/// @dev The owner can change what FUTURE launches get: presets, the launch fee, the pair allow
///      list, the graduation handler. Nothing the owner can do reaches a token that already
///      exists: its curve holds every parameter as an immutable, and its fee model is written
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

    struct VolumeWindow {
        uint64 start;
        uint192 volume;
    }

    /// @notice Holds the token and curve bytecode, so this contract stays under the size limit.
    HoodDeployer public immutable deployer;

    address public treasury;
    address public feeRouter;
    address public staking;
    /// @notice Handler handed to new launches. Live curves keep the one they were born with.
    address public graduationHandler;
    /// @notice Charged on every launch, in native currency, paid to the treasury.
    uint256 public launchFee;

    uint256 public configCount;
    mapping(uint256 configId => CurveConfig) internal _configs;
    mapping(address token => Launch) internal _launches;
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
        FeeModel feeModel
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
    event CreatorFeeRecipientTransferred(address indexed token, address indexed from, address indexed to);
    event ConfigAdded(uint256 indexed configId);
    event ConfigEnabled(uint256 indexed configId, bool enabled);
    event TickerLocked(address indexed token, bytes32 indexed symbolHash, uint64 until);
    event ModulesSet(address feeRouter, address staking, address graduationHandler);
    event PortalSet(address portal);
    event DirectLaunchRegistered(address indexed token, address indexed creator, address hook);
    event TreasurySet(address treasury);
    event LaunchFeeSet(uint256 fee);
    event PairAllowed(address pairToken, bool allowed, uint256 lockThreshold);

    error ConfigDisabled();
    error PairNotAllowed();
    error BadEconomics();
    error BadFee();
    error TickerLockedError();
    error ImageLockedError();
    error NotRecipient();
    error NotACurve();
    error ZeroAddress();
    error ModulesAlreadySet();
    error BadConfig();
    error SymbolTooLong();
    error NotPortal();
    error AlreadyRegistered();

    /// @dev Takes refunds from a creator's first buy on the way back out to them.
    receive() external payable {}

    constructor(address owner_, address treasury_, address deployer_) Ownable(owner_) {
        if (treasury_ == address(0) || deployer_ == address(0)) revert ZeroAddress();
        deployer = HoodDeployer(deployer_);
        treasury = treasury_;
        pairAllowed[address(0)] = true;
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

    function setLaunchFee(uint256 fee) external onlyOwner {
        launchFee = fee;
        emit LaunchFeeSet(fee);
    }

    function setPair(address pairToken, bool allowed, uint256 threshold) external onlyOwner {
        pairAllowed[pairToken] = allowed;
        lockThreshold[pairToken] = threshold;
        emit PairAllowed(pairToken, allowed, threshold);
    }

    /// @notice Adds a launch preset. Presets are append-only: an existing one is never edited, so
    ///         nothing can change under a token that already launched on it.
    function addConfig(CurveConfig calldata c) external onlyOwner returns (uint256 configId) {
        if (c.totalSupply == 0 || c.curveSupplyBps == 0 || c.curveSupplyBps >= BPS) revert BadConfig();
        if (c.graduationCap <= c.startCap || c.startCap == 0) revert BadConfig();
        // The pool has to get the lion's share of the raise, or graduation is an exit.
        if (c.liquidityBps < 8000 || c.liquidityBps > BPS) revert BadConfig();
        if (uint256(c.protocolFeeBps) + c.creatorFeeBps > 500) revert BadFee();
        if (c.tickSpacing <= 0) revert BadConfig();
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

    function feeModel(address token) external view returns (FeeModel) {
        return _launches[token].feeModel;
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
        uint256 launchFee_ = launchFee;
        if (msg.value < launchFee_) revert BadFee();
        if (!pairAllowed[p.pairToken]) revert PairNotAllowed();
        if (p.econ != bytes32(0) && p.econ != previewLaunchEconomics(p.configId, p.pairToken)) revert BadEconomics();
        if (p.feeModel == FeeModel.CreatorKeep && p.creatorFeeRecipient == address(0)) revert ZeroAddress();

        bytes32 sHash = symbolHash(p.symbol);
        bytes32 iHash = keccak256(bytes(p.image));
        if (symbolLockedUntil[sHash] > block.timestamp) revert TickerLockedError();
        if (bytes(p.image).length != 0 && imageLockedUntil[iHash] > block.timestamp) revert ImageLockedError();

        (token, curve) = _deploy(p, c);
        _register(token, curve, p, sHash, iHash);

        PairTransfer.push(address(0), treasury, launchFee_);
        bought = _firstBuy(p, curve, msg.value - launchFee_);
    }

    function _deploy(LaunchParams calldata p, CurveConfig memory c) internal returns (address token, address curve) {
        bytes32 salt = keccak256(abi.encode(msg.sender, p.salt));
        token = deployer.deployToken(
            p.name, p.symbol, p.image, p.description, c.totalSupply, address(this), salt
        );

        // Filled field by field rather than as one literal: as a literal this is sixteen live
        // values at once and the Yul optimizer runs out of stack slots.
        HoodCurve.InitParams memory ip;
        ip.factory = address(this);
        ip.token = token;
        ip.pairToken = p.pairToken;
        ip.treasury = treasury;
        ip.feeRouter = feeRouter;
        ip.graduationHandler = graduationHandler;
        ip.curveSupply = Math.mulDiv(c.totalSupply, c.curveSupplyBps, BPS);
        ip.lpSupply = c.totalSupply - ip.curveSupply;
        ip.p0 = Math.mulDiv(c.startCap, WAD, c.totalSupply);
        ip.p1 = Math.mulDiv(c.graduationCap, WAD, c.totalSupply);
        ip.liquidityBps = c.liquidityBps;
        ip.protocolFeeBps = c.protocolFeeBps;
        ip.creatorFeeBps = p.feeModel == FeeModel.ZeroFee ? 0 : c.creatorFeeBps;
        ip.poolFee = c.poolFee;
        ip.tickSpacing = c.tickSpacing;

        curve = deployer.deployCurve(ip, salt);
        IERC20(token).safeTransfer(curve, c.totalSupply);

        // Open the pool now, at the price this launch is heading for, so nobody can open it first
        // at a price of their own. A handler that cannot do it must not be able to stop a launch.
        uint256 plannedPair = Math.mulDiv(IHoodCurve(curve).raiseTarget(), c.liquidityBps, BPS);
        try IGraduationHandler(graduationHandler).prepare(
            token, p.pairToken, c.totalSupply - ip.curveSupply, plannedPair, c.poolFee, c.tickSpacing
        ) {} catch {}
    }

    function _register(address token, address curve, LaunchParams calldata p, bytes32 sHash, bytes32 iHash) internal {
        _launches[token] = Launch({
            curve: curve,
            creator: msg.sender,
            creatorFeeRecipient: p.creatorFeeRecipient == address(0) ? msg.sender : p.creatorFeeRecipient,
            pairToken: p.pairToken,
            configId: p.configId,
            feeModel: p.feeModel,
            symbolHash: sHash,
            imageHash: iHash,
            launchedAt: uint64(block.timestamp),
            exists: true,
            mode: LaunchMode.Curve,
            hook: address(0),
            splitter: address(0),
            locker: address(0)
        });
        tokenOfCurve[curve] = token;

        emit Launched(token, curve, msg.sender, p.configId, p.pairToken, p.feeModel);
        emit LaunchMetadata(
            token, p.name, p.symbol, p.image, p.description, p.website, p.twitter, p.telegram
        );
    }

    function _firstBuy(LaunchParams calldata p, address curve, uint256 nativeLeft) internal returns (uint256 bought) {
        if (p.pairToken == address(0)) {
            if (nativeLeft == 0) return 0;
            // Measured, not swept: `address(this).balance` would hand this creator whatever native
            // currency happened to be sitting here from anywhere else, and a contract with a
            // `receive` accumulates strays.
            uint256 before = address(this).balance - nativeLeft;
            bought = IHoodCurve(curve).buy{value: nativeLeft}(nativeLeft, 0, msg.sender);
            // The curve hands back whatever it could not absorb; it belongs to the creator.
            PairTransfer.push(address(0), msg.sender, address(this).balance - before);
        } else {
            if (nativeLeft != 0) revert BadFee();
            uint256 amount = p.firstBuy;
            if (amount == 0) return 0;
            IERC20(p.pairToken).safeTransferFrom(msg.sender, address(this), amount);
            IERC20(p.pairToken).forceApprove(curve, amount);
            bought = IHoodCurve(curve).buy(amount, 0, msg.sender);
        }
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
            feeModel: FeeModel.ZeroFee,
            symbolHash: sHash,
            imageHash: iHash,
            launchedAt: uint64(block.timestamp),
            exists: true,
            mode: LaunchMode.Direct,
            hook: hook,
            splitter: splitter,
            locker: locker
        });
        emit DirectLaunchRegistered(token, creator, hook);
    }

    /// @inheritdoc IHoodFactory
    function recordVolume(address token, uint256 pairAmount) external {
        Launch memory l = _launches[token];
        // Either machine may report: a curve for its own token, a hook for its own pool.
        bool reporter = (l.curve != address(0) && msg.sender == l.curve) || (l.hook != address(0) && msg.sender == l.hook);
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

        uint64 until = uint64(block.timestamp) + LOCK_DURATION;
        if (symbolLockedUntil[l.symbolHash] + LOCK_REFRESH < until) {
            symbolLockedUntil[l.symbolHash] = until;
            symbolLockOwner[l.symbolHash] = token;
            if (l.imageHash != EMPTY_HASH) {
                imageLockedUntil[l.imageHash] = until;
                imageLockOwner[l.imageHash] = token;
            }
            emit TickerLocked(token, l.symbolHash, until);
        }
    }
}
