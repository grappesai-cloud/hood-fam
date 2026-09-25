// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {Launch} from "../../src/HoodTypes.sol";
import {PairTransfer} from "../../src/libraries/PairTransfer.sol";
import {IHoodBag} from "../../src/interfaces/IHoodBag.sol";

/// @notice A six-decimal stand-in for a stablecoin quote.
contract BagUSD is ERC20 {
    constructor() ERC20("Bag Dollar", "bUSD") {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

/// @notice A house coin that can burn itself, the shape of HoodToken.
contract MockBurnCoin is ERC20 {
    constructor() ERC20("House Coin", "HOUSE") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function burn(uint256 amount) external {
        _burn(msg.sender, amount);
    }
}

/// @notice A coin with no burn function, to prove the dead-address fallback.
contract PlainCoin is ERC20 {
    constructor() ERC20("Plain Coin", "PLAIN") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

/// @notice The surface of HoodStaking the Bag reads and pays: `houseToken` and `notifyReward`,
///         with the same funds check the real vault makes, plus a switch to refuse rewards.
contract MockVault {
    address public houseToken;
    bool public rejectNotify;
    mapping(address asset => uint256) public accounted;
    mapping(address asset => uint256) public notified;

    error ZeroAmount();
    error FundsNotReceived();
    error Rejected();

    function setHouseToken(address token) external {
        houseToken = token;
    }

    function setRejectNotify(bool reject) external {
        rejectNotify = reject;
    }

    function notifyReward(address asset, uint256 amount) external payable {
        if (rejectNotify) revert Rejected();
        if (amount == 0) revert ZeroAmount();
        if (asset == address(0)) {
            if (msg.value != amount) revert FundsNotReceived();
        } else {
            if (msg.value != 0) revert FundsNotReceived();
            if (IERC20(asset).balanceOf(address(this)) < accounted[asset] + amount) revert FundsNotReceived();
        }
        accounted[asset] += amount;
        notified[asset] += amount;
    }

    function totalWeight() external pure returns (uint256) {
        return 0;
    }
}

/// @notice A pot that only records what it was paid and by whom.
contract MockPot {
    address public token;
    address public asset;
    uint256 public totalDeposited;
    uint256 public lastAmount;
    bytes32 public lastReason;
    address public lastPayer;

    constructor(address token_, address asset_) {
        token = token_;
        asset = asset_;
    }

    function depositForHolders(uint256 amount, bytes32 reason, address payer) external payable {
        PairTransfer.pull(asset, msg.sender, amount, msg.value);
        totalDeposited += amount;
        lastAmount = amount;
        lastReason = reason;
        lastPayer = payer;
    }
}

/// @notice What the Bag machine reads from the factory: who owns it, who graduates, which
///         tokens are launches of ours.
contract MockBagFactory {
    address public owner;
    address public treasury;
    address public graduationHandler;
    address public bag;
    mapping(address token => Launch) internal launches;

    constructor(address owner_) {
        owner = owner_;
        treasury = owner_;
    }

    function setOwner(address next) external {
        owner = next;
    }

    function setGraduationHandler(address handler) external {
        graduationHandler = handler;
    }

    function setBag(address bag_) external {
        bag = bag_;
    }

    function register(address token, address curve, address hook, address pairToken) external {
        Launch storage l = launches[token];
        l.curve = curve;
        l.hook = hook;
        l.pairToken = pairToken;
        l.launchedAt = uint64(block.timestamp);
        l.exists = true;
    }

    function getLaunch(address token) external view returns (Launch memory) {
        return launches[token];
    }
}

/// @notice A receiver that can be told to refuse native transfers.
contract ToggleReceiver {
    bool public accept = true;

    function setAccept(bool accept_) external {
        accept = accept_;
    }

    receive() external payable {
        if (!accept) revert("no");
    }
}

/// @notice A house that tries to re-enter the Bag from its receive.
contract ReentrantHouse {
    IHoodBag public bag;
    bool public reentered;

    function setBag(address bag_) external {
        bag = IHoodBag(bag_);
    }

    receive() external payable {
        bag.takeHouseFee{value: msg.value}(address(0), msg.value, address(0));
        reentered = true;
    }
}

/// @notice A `fund(asset, amount)` receiver, the shape of the burn clock and payday, with a
///         switch to refuse funding.
contract MockSink {
    bool public rejecting;
    mapping(address asset => uint256) public balanceOf;

    function setRejecting(bool rejecting_) external {
        rejecting = rejecting_;
    }

    function fund(address asset, uint256 amount) external payable {
        if (rejecting) revert("sink closed");
        PairTransfer.pull(asset, msg.sender, amount, msg.value);
        balanceOf[asset] += amount;
    }
}
