// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";

import {IHoodBag} from "../../src/interfaces/IHoodBag.sol";
import {IHoodStaking} from "../../src/interfaces/IHoodStaking.sol";
import {BagSource, BagOutlet} from "../../src/bag/BagTypes.sol";
import {DirectLaunch} from "../../src/direct/DirectTypes.sol";
import {PairTransfer} from "../../src/libraries/PairTransfer.sol";

/// @notice A Bag that records every intake and keeps the money, so the direct suite can prove
///         what reached it without depending on the real router.
contract MockBag is IHoodBag {
    struct Call {
        bytes32 kind;
        address asset;
        uint256 amount;
        address token;
    }

    bytes32 public constant TRADE = keccak256("trade");
    bytes32 public constant GRADUATION = keccak256("graduation");
    bytes32 public constant BOOST = keccak256("boost");
    bytes32 public constant HOUSE = keccak256("house");
    bytes32 public constant HOUSE_COIN = keccak256("houseCoin");

    Call[] public calls;
    mapping(bytes32 kind => mapping(address asset => uint256)) public total;
    address public house = address(0xB0B);
    address public vault;
    address public payday = address(0xBAD);
    address public burnClock = address(0xB00);

    receive() external payable {}

    function setVault(address v) external {
        vault = v;
    }

    function callCount() external view returns (uint256) {
        return calls.length;
    }

    function lastCall() external view returns (Call memory) {
        return calls[calls.length - 1];
    }

    function _take(bytes32 kind, address asset, uint256 amount, address token) internal {
        PairTransfer.pull(asset, msg.sender, amount, msg.value);
        calls.push(Call(kind, asset, amount, token));
        total[kind][asset] += amount;
        emit BagIn(BagSource.Trade, asset, amount, token);
    }

    function takeTradeFee(address asset, uint256 amount, address token) external payable {
        _take(TRADE, asset, amount, token);
    }

    function takeGraduationFee(address asset, uint256 amount, address token, address) external payable {
        _take(GRADUATION, asset, amount, token);
    }

    function takeBoost(address asset, uint256 amount, address token, uint64) external payable {
        _take(BOOST, asset, amount, token);
    }

    function takeHouseFee(address asset, uint256 amount, address token) external payable {
        _take(HOUSE, asset, amount, token);
    }

    function takeHouseCoinLeg(address asset, uint256 amount) external payable {
        _take(HOUSE_COIN, asset, amount, address(0));
    }

    function releaseHeld(address) external {}

    function totalIn(address, BagSource) external pure returns (uint256) {
        return 0;
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
}

/// @notice The Vault's reward intake and nothing else: push then notify, like HoodStaking.
contract MockVault is IHoodStaking {
    address public houseToken;
    uint256 public totalWeight;
    mapping(address asset => uint256) public rewards;
    mapping(address asset => uint256) public accounted;
    uint256 public notifyCount;

    error FundsNotReceived();

    receive() external payable {}

    function setHouseToken(address t) external {
        houseToken = t;
    }

    function notifyReward(address asset, uint256 amount) external payable {
        if (asset == address(0)) {
            if (msg.value != amount) revert FundsNotReceived();
        } else {
            if (IERC20(asset).balanceOf(address(this)) < accounted[asset] + amount) revert FundsNotReceived();
        }
        accounted[asset] += amount;
        rewards[asset] += amount;
        ++notifyCount;
    }

    function stakeFor(address, uint256, uint64) external pure returns (uint256) {
        return 0;
    }

    function isTier(uint64) external pure returns (bool) {
        return true;
    }
}

/// @notice Exactly what the buyback module and the auction read from the portal: whether a token
///         is a launch of ours, and where its pieces are. Also answers the splitter's questions.
contract PortalStub {
    address public token;
    address public quote;
    address public hook;
    address public splitter;
    address public locker;
    address public bag;
    address public treasury;
    address public referrals;

    function set(address token_, address hook_, address splitter_, address locker_) external {
        token = token_;
        hook = hook_;
        splitter = splitter_;
        locker = locker_;
    }

    function setQuote(address q) external {
        quote = q;
    }

    function setBag(address b) external {
        bag = b;
    }

    function setTreasury(address t) external {
        treasury = t;
    }

    function getLaunch(address t) external view returns (DirectLaunch memory l) {
        l.token = t;
        l.quote = quote;
        l.hook = hook;
        l.splitter = splitter;
        l.locker = locker;
        l.exists = t == token;
    }
}

/// @notice The locker only has to answer `poolKey()` for the module and take the liquidity share.
contract LockerStub {
    PoolKey internal _key;

    receive() external payable {}

    function setKey(PoolKey calldata key) external {
        _key = key;
    }

    function poolKey() external view returns (PoolKey memory) {
        return _key;
    }
}
