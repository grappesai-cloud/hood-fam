// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import {IGraduationHandler} from "../../src/interfaces/IGraduationHandler.sol";
import {IHoodBag} from "../../src/interfaces/IHoodBag.sol";
import {IHoodFactory} from "../../src/interfaces/IHoodFactory.sol";
import {IHoodFeeRouter} from "../../src/interfaces/IHoodFeeRouter.sol";
import {IHoodPot} from "../../src/interfaces/IHoodPot.sol";
import {IHoodToken} from "../../src/interfaces/IHoodToken.sol";
import {PairTransfer} from "../../src/libraries/PairTransfer.sol";
import {BagOutlet, BagSource} from "../../src/bag/BagTypes.sol";
import {Launch} from "../../src/HoodTypes.sol";

/// @notice A Bag that takes everything and splits nothing: it records every intake, per source
///         and per asset, and just holds the money. What the curve machine's tests need to see is
///         that the right door was used with the right amount; the rules behind the door are the
///         real Bag's own suite.
contract MockBag is IHoodBag {
    struct Take {
        BagSource source;
        address asset;
        uint256 amount;
        address token;
        address pot;
        address from;
    }

    address public immutable house;
    Take[] internal _takes;
    mapping(address asset => mapping(BagSource source => uint256)) internal _in;

    constructor(address house_) {
        house = house_;
    }

    /// @dev Plain pushes are refused: everything must come in through a `take*` door, so a test
    ///      that sends at the receive by mistake fails loudly instead of counting as an intake.
    receive() external payable {
        revert("use a take* door");
    }

    function takeTradeFee(address asset, uint256 amount, address token) external payable {
        _take(BagSource.Trade, asset, amount, token, address(0));
    }

    /// @dev `dev` is recorded in the `pot` field of the take.
    function takeGraduationFee(address asset, uint256 amount, address token, address dev) external payable {
        _take(BagSource.Graduation, asset, amount, token, dev);
    }

    function takeBoost(address asset, uint256 amount, address token, uint64) external payable {
        _take(BagSource.Boost, asset, amount, token, address(0));
    }

    function takeHouseFee(address asset, uint256 amount, address token) external payable {
        _take(BagSource.House, asset, amount, token, address(0));
    }

    function takeHouseCoinLeg(address asset, uint256 amount) external payable {
        _take(BagSource.HouseCoin, asset, amount, address(0), address(0));
    }

    function releaseHeld(address) external {}

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
        return _in[asset][source];
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

    function takeCount() external view returns (uint256) {
        return _takes.length;
    }

    function takeAt(uint256 i) external view returns (Take memory) {
        return _takes[i];
    }

    function lastTake() external view returns (Take memory) {
        return _takes[_takes.length - 1];
    }

    function _take(BagSource source, address asset, uint256 amount, address token, address pot) internal {
        PairTransfer.pull(asset, msg.sender, amount, msg.value);
        _in[asset][source] += amount;
        _takes.push(Take({source: source, asset: asset, amount: amount, token: token, pot: pot, from: msg.sender}));
        emit BagIn(source, asset, amount, token);
    }
}

/// @notice A pot that only remembers: every balance sync the token sent it and every deposit. For
///         testing the token's side of the wire in isolation; the accumulator itself is HoodPot.
contract MockPot is IHoodPot {
    struct Sync {
        address from;
        address to;
        uint256 fromBalance;
        uint256 toBalance;
    }

    address public immutable token;
    address public immutable asset;
    Sync[] internal _syncs;
    uint256 public totalDeposited;
    uint256 public totalPaid;
    bytes32 public lastReason;
    address public lastPayer;
    mapping(address => bool) public excluded;

    error NotToken();

    constructor(address token_, address asset_) {
        token = token_;
        asset = asset_;
    }

    function syncBalances(address from, address to, uint256 fromBalance, uint256 toBalance) external {
        if (msg.sender != token) revert NotToken();
        _syncs.push(Sync({from: from, to: to, fromBalance: fromBalance, toBalance: toBalance}));
    }

    function exclude(address who) external {
        excluded[who] = true;
    }

    function depositForHolders(uint256 amount, bytes32 reason, address payer) external payable {
        PairTransfer.pull(asset, msg.sender, amount, msg.value);
        totalDeposited += amount;
        lastReason = reason;
        lastPayer = payer;
        emit HoldersPaid(reason, payer, amount, 0);
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

    function syncCount() external view returns (uint256) {
        return _syncs.length;
    }

    function syncAt(uint256 i) external view returns (Sync memory) {
        return _syncs[i];
    }

    function lastSync() external view returns (Sync memory) {
        return _syncs[_syncs.length - 1];
    }
}

/// @notice Stand-in pair asset with six decimals, the shape of a real stablecoin pair.
contract MockUSD is ERC20 {
    constructor() ERC20("Mock Dollar", "mUSD") {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

contract MockQuote is ERC20 {
    uint8 internal immutable _decimals;

    constructor(string memory symbol_, uint8 decimals_) ERC20("Custom Quote", symbol_) {
        _decimals = decimals_;
    }

    function decimals() public view override returns (uint8) {
        return _decimals;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

contract MockTaxQuote is MockQuote {
    constructor() MockQuote("TAX", 18) {}

    function _update(address from, address to, uint256 value) internal override {
        if (from == address(0) || to == address(0)) return super._update(from, to, value);
        uint256 tax = value / 100;
        super._update(from, address(0), tax);
        super._update(from, to, value - tax);
    }
}

/// @notice A graduation handler that behaves like a pool without needing one: it keeps the
///         liquidity, quotes a constant product for buybacks, and can hand fees back.
contract MockGraduator is IGraduationHandler {
    using SafeERC20 for IERC20;

    IHoodFactory public immutable factory;

    struct Pool {
        uint256 tokenReserve;
        uint256 pairReserve;
        bool exists;
    }

    mapping(address token => Pool) public pools;
    mapping(address token => uint256) public compounded;

    constructor(address factory_) {
        factory = IHoodFactory(factory_);
    }

    receive() external payable {}

    function isGraduated(address token) external view returns (bool) {
        return pools[token].exists;
    }

    function prepare(address, address, uint256, uint256, uint24, int24) external {}

    function graduate(address token, address, uint256 tokenAmount, uint256 pairAmount, uint24, int24) external payable {
        pools[token] = Pool({tokenReserve: tokenAmount, pairReserve: pairAmount, exists: true});
    }

    /// @notice Pretends the position earned `pairAmount` and `tokenAmount` in fees.
    function seedFees(address token, uint256 pairAmount, uint256 tokenAmount) external payable {
        pools[token].pairReserve += 0; // fees are held on top of the reserves
        pendingPair[token] += pairAmount;
        pendingToken[token] += tokenAmount;
    }

    mapping(address => uint256) public pendingPair;
    mapping(address => uint256) public pendingToken;

    function collect(address token) external {
        Launch memory l = factory.getLaunch(token);
        uint256 pairAmount = pendingPair[token];
        uint256 tokenAmount = pendingToken[token];
        pendingPair[token] = 0;
        pendingToken[token] = 0;
        if (tokenAmount != 0) IHoodToken(token).burn(tokenAmount);
        if (pairAmount != 0) {
            PairTransfer.pushAndCall(
                l.pairToken, factory.feeRouter(), pairAmount, abi.encodeCall(IHoodFeeRouter.accrue, (token, pairAmount))
            );
        }
    }

    function compound(address token, uint256 amount) external payable {
        Launch memory l = factory.getLaunch(token);
        if (l.pairToken != address(0)) IERC20(l.pairToken).safeTransferFrom(msg.sender, address(this), amount);
        pools[token].pairReserve += amount;
        compounded[token] += amount;
    }

    function buyback(address token, uint256 amount, uint256 minTokensOut) external payable returns (uint256 burned) {
        Launch memory l = factory.getLaunch(token);
        if (l.pairToken != address(0)) IERC20(l.pairToken).safeTransferFrom(msg.sender, address(this), amount);
        Pool storage p = pools[token];
        // constant product, no fee
        burned = (p.tokenReserve * amount) / (p.pairReserve + amount);
        require(burned >= minTokensOut, "slippage");
        p.pairReserve += amount;
        p.tokenReserve -= burned;
        IHoodToken(token).burn(burned);
    }
}

/// @notice Refuses every incoming native transfer, to prove the paths that must not depend on it.
contract RejectNative {
    receive() external payable {
        revert("no");
    }
}

/// @notice The little the LayerZero endpoint has to answer while an adapter is being constructed.
contract MockLZEndpoint {
    mapping(address oapp => address delegate) public delegates;

    function setDelegate(address delegate) external {
        delegates[msg.sender] = delegate;
    }

    function eid() external pure returns (uint32) {
        return 30416;
    }
}
