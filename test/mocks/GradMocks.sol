// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {StateLibrary} from "@uniswap/v4-core/src/libraries/StateLibrary.sol";
import {PoolId} from "@uniswap/v4-core/src/types/PoolId.sol";

import {BagOutlet, BagSource} from "../../src/bag/BagTypes.sol";
import {IHoodBag} from "../../src/interfaces/IHoodBag.sol";
import {IHoodFactory} from "../../src/interfaces/IHoodFactory.sol";
import {IHoodFeeRouter} from "../../src/interfaces/IHoodFeeRouter.sol";
import {IHoodPot} from "../../src/interfaces/IHoodPot.sol";
import {IHoodStaking} from "../../src/interfaces/IHoodStaking.sol";
import {CurveConfig, FeeSplit, Launch} from "../../src/HoodTypes.sol";

/// @notice A launch token as the graduator and the hook see it: an ERC-20 that can burn and names a pot.
contract MockLaunchToken is ERC20 {
    address public pot;

    constructor() ERC20("Graduated", "GRAD") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function burn(uint256 amount) external {
        _burn(msg.sender, amount);
    }

    function setPot(address pot_) external {
        pot = pot_;
    }
}

/// @notice A six-decimal quote, the shape of a dollar pair.
contract MockGradQuote is ERC20 {
    constructor() ERC20("Mock Dollar", "mUSD") {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

/// @notice A pot that records every deposit and who was excluded, and holds the money.
contract MockPot is IHoodPot {
    using SafeERC20 for IERC20;

    struct Deposit {
        uint256 amount;
        bytes32 reason;
        address payer;
    }

    address public immutable token;
    address public immutable asset;
    address public excluder;
    uint256 public totalDeposited;
    mapping(address => bool) public excluded;
    Deposit[] internal _deposits;

    error WrongValue();
    error NotExcluder();

    constructor(address token_, address asset_) {
        token = token_;
        asset = asset_;
    }

    function setExcluder(address who) external {
        excluder = who;
    }

    function exclude(address who) external {
        if (msg.sender != excluder) revert NotExcluder();
        excluded[who] = true;
    }

    function depositForHolders(uint256 amount, bytes32 reason, address payer) external payable {
        if (asset == address(0)) {
            if (msg.value != amount) revert WrongValue();
        } else {
            if (msg.value != 0) revert WrongValue();
            IERC20(asset).safeTransferFrom(msg.sender, address(this), amount);
        }
        _deposits.push(Deposit({amount: amount, reason: reason, payer: payer}));
        totalDeposited += amount;
        emit HoldersPaid(reason, payer, amount, 0);
    }

    function depositCount() external view returns (uint256) {
        return _deposits.length;
    }

    function lastDeposit() external view returns (Deposit memory) {
        return _deposits[_deposits.length - 1];
    }

    function pending(address) external pure returns (uint256) {
        return 0;
    }

    function claim(address) external pure returns (uint256) {
        return 0;
    }

    function pushMany(address[] calldata, uint256) external pure returns (uint256, uint256) {
        return (0, 0);
    }

    function totalPaid() external pure returns (uint256) {
        return 0;
    }
}

/// @notice A Bag that books what came in, per source, asset and token, and can be told to refuse.
contract MockBag is IHoodBag {
    using SafeERC20 for IERC20;

    bool public broken;
    mapping(address asset => mapping(address token => uint256)) public tradeFee;
    mapping(address asset => mapping(BagSource source => uint256)) internal _totalIn;

    error WrongValue();
    error Broken();

    function setBroken(bool broken_) external {
        broken = broken_;
    }

    function takeTradeFee(address asset, uint256 amount, address token) external payable {
        _take(asset, amount, BagSource.Trade);
        tradeFee[asset][token] += amount;
        emit BagIn(BagSource.Trade, asset, amount, token);
    }

    function takeGraduationFee(address asset, uint256 amount, address token, address) external payable {
        _take(asset, amount, BagSource.Graduation);
        emit BagIn(BagSource.Graduation, asset, amount, token);
    }

    function takeBoost(address asset, uint256 amount, address token, uint64) external payable {
        _take(asset, amount, BagSource.Boost);
        emit BagIn(BagSource.Boost, asset, amount, token);
    }

    function takeHouseFee(address asset, uint256 amount, address token) external payable {
        _take(asset, amount, BagSource.House);
        emit BagIn(BagSource.House, asset, amount, token);
    }

    function takeHouseCoinLeg(address asset, uint256 amount) external payable {
        _take(asset, amount, BagSource.HouseCoin);
        emit BagIn(BagSource.HouseCoin, asset, amount, address(0));
    }

    function releaseHeld(address) external {}

    function house() external pure returns (address) {
        return address(0);
    }

    function vault() external pure returns (address) {
        return address(0);
    }

    function payday() external pure returns (address) {
        return address(0);
    }

    function burnClock() external pure returns (address) {
        return address(0);
    }

    function totalIn(address asset, BagSource source) external view returns (uint256) {
        return _totalIn[asset][source];
    }

    function totalOut(address, BagOutlet) external pure returns (uint256) {
        return 0;
    }

    function heldForVault(address) external pure returns (uint256) {
        return 0;
    }

    function heldForBurn(address) external pure returns (uint256) {
        return 0;
    }

    function _take(address asset, uint256 amount, BagSource source) internal {
        if (broken) revert Broken();
        if (asset == address(0)) {
            if (msg.value != amount) revert WrongValue();
        } else {
            if (msg.value != 0) revert WrongValue();
            IERC20(asset).safeTransferFrom(msg.sender, address(this), amount);
        }
        _totalIn[asset][source] += amount;
    }
}

/// @notice The creator leg's door, with the real router's payment convention: native as value, an
///         ERC-20 transferred before the call.
contract MockFeeRouter is IHoodFeeRouter {
    address public immutable factory;
    mapping(address token => uint256) public accrued;
    mapping(address asset => uint256) public accounted;

    error FundsNotReceived();

    constructor(address factory_) {
        factory = factory_;
    }

    receive() external payable {}

    function accrue(address token, uint256 amount) external payable {
        address asset = IHoodFactory(factory).getLaunch(token).pairToken;
        if (asset == address(0)) {
            if (msg.value != amount) revert FundsNotReceived();
        } else {
            if (msg.value != 0) revert FundsNotReceived();
            if (IERC20(asset).balanceOf(address(this)) < accounted[asset] + amount) revert FundsNotReceived();
        }
        accounted[asset] += amount;
        accrued[token] += amount;
    }

    function flush(address) external {}

    function flushBuyback(address, uint256) external {}
}

/// @notice The Vault, with the real vault's payment convention (push, then notify).
contract MockVault is IHoodStaking {
    address public houseToken;
    mapping(address asset => uint256) public rewards;
    mapping(address asset => uint256) public accounted;

    error FundsNotReceived();

    receive() external payable {}

    function setHouseToken(address houseToken_) external {
        houseToken = houseToken_;
    }

    function notifyReward(address asset, uint256 amount) external payable {
        if (asset == address(0)) {
            if (msg.value != amount) revert FundsNotReceived();
        } else {
            if (msg.value != 0) revert FundsNotReceived();
            if (IERC20(asset).balanceOf(address(this)) < accounted[asset] + amount) revert FundsNotReceived();
        }
        accounted[asset] += amount;
        rewards[asset] += amount;
    }

    function totalWeight() external pure returns (uint256) {
        return 0;
    }

    function stakeFor(address, uint256, uint64) external pure returns (uint256) {
        return 0;
    }

    function isTier(uint64) external pure returns (bool) {
        return false;
    }
}

/// @notice Exactly what the hook and the graduator read off the factory.
contract MockFactory {
    address public owner;
    address public treasury;
    address public feeRouter;
    address public staking;
    address public graduationHandler;
    address public referrals;
    address public bag;

    mapping(address token => Launch) internal _launches;

    constructor(address owner_) {
        owner = owner_;
        treasury = owner_;
    }

    function setModules(address feeRouter_, address staking_, address graduationHandler_, address bag_) external {
        feeRouter = feeRouter_;
        staking = staking_;
        graduationHandler = graduationHandler_;
        bag = bag_;
    }

    function setLaunch(address token, address curve, address pairToken, address pot) external {
        Launch storage l = _launches[token];
        l.curve = curve;
        l.creator = msg.sender;
        l.creatorFeeRecipient = msg.sender;
        l.pairToken = pairToken;
        l.pot = pot;
        l.exists = true;
    }

    function getLaunch(address token) external view returns (Launch memory) {
        return _launches[token];
    }

    function getConfig(uint256) external pure returns (CurveConfig memory config) {
        return config;
    }

    function creatorFeeRecipient(address token) external view returns (address) {
        return _launches[token].creatorFeeRecipient;
    }

    function feeSplit(address token) external view returns (FeeSplit memory) {
        return _launches[token].feeSplit;
    }

    function recordVolume(address, uint256) external {}
}

/// @notice A curve that only remembers the handler it was born with.
contract MockCurve {
    address public immutable graduationHandler;

    constructor(address handler) {
        graduationHandler = handler;
    }
}

/// @notice A position manager that takes the call and the value and mints nothing, so a graduation
///         can be driven end to end with no PositionManager deployed: everything the graduator
///         hands it stays where it is and shows up as leftovers.
contract MockPositionManager {
    uint256 public nextTokenId = 1;
    uint256 public calls;

    receive() external payable {}

    function modifyLiquidities(bytes calldata, uint256) external payable {
        calls++;
        nextTokenId++;
    }

    function getPositionLiquidity(uint256) external pure returns (uint128) {
        return 0;
    }
}

contract MockPermit2 {
    function approve(address, address, uint160, uint48) external {}
}

/// @notice The two reads the graduator makes of StateView, answered off the real PoolManager.
contract MockStateView {
    using StateLibrary for IPoolManager;

    IPoolManager public immutable pm;

    constructor(IPoolManager pm_) {
        pm = pm_;
    }

    function getSlot0(bytes32 id) external view returns (uint160, int24, uint24, uint24) {
        return pm.getSlot0(PoolId.wrap(id));
    }

    function getLiquidity(bytes32 id) external view returns (uint128) {
        return pm.getLiquidity(PoolId.wrap(id));
    }
}
