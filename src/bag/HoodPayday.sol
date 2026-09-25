// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import {BagReasons, BagSplits} from "./BagTypes.sol";
import {PairTransfer} from "../libraries/PairTransfer.sol";
import {IHoodPayday} from "../interfaces/IHoodPayday.sol";
import {IHoodPot} from "../interfaces/IHoodPot.sol";
import {IHoodFactory} from "../interfaces/IHoodFactory.sol";

/// @title HoodPayday
/// @notice The hourly distributor. The Bag funds the current hour; once the hour has closed the
///         keeper pays it to the hour's wallets by points and sends a slice into the last ten
///         launches' pots. What is not paid carries into the next payout.
/// @dev The keeper chooses who gets paid, never how much in total: an epoch pays at most what it
///      was funded plus the carry, the launch slice is capped at PAYDAY_LAUNCH_SLICE_BPS of that,
///      and each epoch is paid once per asset. A wallet that refuses a native push is booked in
///      `owed` and can be paid by anyone through `claimOwed`, so one wallet never blocks a batch.
contract HoodPayday is IHoodPayday, ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint256 internal constant BPS = BagSplits.BPS;
    uint256 public constant MAX_WALLETS = 500;
    uint256 public constant MAX_POTS = 10;
    /// @dev Gas forwarded to a wallet on a native push.
    uint256 internal constant PAY_GAS = 50_000;

    address public immutable factory;
    address public keeper;

    mapping(uint64 epoch_ => mapping(address asset => uint256)) public funded;
    mapping(uint64 epoch_ => mapping(address asset => uint256)) public paid;
    /// @notice When an epoch was paid for an asset; zero while it is still open or unpaid.
    mapping(uint64 epoch_ => mapping(address asset => uint64)) public paidAt;
    mapping(address asset => uint256) public carried;
    /// @notice Payouts a wallet refused, waiting for `claimOwed`.
    mapping(address wallet => mapping(address asset => uint256)) public owed;

    event Owed(address indexed wallet, address indexed asset, uint256 amount);
    event OwedClaimed(address indexed wallet, address indexed asset, uint256 amount);

    error NotOwner();
    error NotKeeper();
    error WrongValue();
    error EpochOpen();
    error AlreadyPaid();
    error LengthMismatch();
    error TooManyWallets();
    error TooManyPots();
    error Overspent();
    error LaunchSliceTooBig();
    error PotAssetMismatch();
    error Nothing();
    error UnexpectedPayout();

    constructor(address factory_) {
        factory = factory_;
    }

    /// @inheritdoc IHoodPayday
    function epoch() public view returns (uint64) {
        return uint64(block.timestamp / 1 hours);
    }

    function setKeeper(address next) external {
        if (msg.sender != IHoodFactory(factory).owner()) revert NotOwner();
        keeper = next;
        emit KeeperSet(next);
    }

    // ---------------------------------------------------------------- money in

    /// @inheritdoc IHoodPayday
    function fund(address asset, uint256 amount) external payable {
        if (amount == 0) {
            if (msg.value != 0) revert WrongValue();
            return;
        }
        PairTransfer.pull(asset, msg.sender, amount, msg.value);
        uint64 e = epoch();
        funded[e][asset] += amount;
        emit Funded(e, asset, amount);
    }

    // ---------------------------------------------------------------- money out

    /// @inheritdoc IHoodPayday
    /// @dev Keeper or factory owner. `epoch_` must be closed and unpaid for `asset`.
    function pay(
        uint64 epoch_,
        address asset,
        address[] calldata wallets,
        uint256[] calldata amounts,
        address[] calldata pots,
        uint256[] calldata potAmounts
    ) external nonReentrant {
        if (msg.sender != keeper && msg.sender != IHoodFactory(factory).owner()) revert NotKeeper();
        if (epoch_ >= epoch()) revert EpochOpen();
        if (paidAt[epoch_][asset] != 0) revert AlreadyPaid();
        if (wallets.length != amounts.length || pots.length != potAmounts.length) revert LengthMismatch();
        if (wallets.length > MAX_WALLETS) revert TooManyWallets();
        if (pots.length > MAX_POTS) revert TooManyPots();

        uint256 available = funded[epoch_][asset] + carried[asset];
        uint256 toWallets;
        for (uint256 i; i < amounts.length; ++i) {
            toWallets += amounts[i];
        }
        uint256 toLaunches;
        for (uint256 i; i < potAmounts.length; ++i) {
            toLaunches += potAmounts[i];
        }
        if (toWallets + toLaunches > available) revert Overspent();
        if (toLaunches > (available * BagSplits.PAYDAY_LAUNCH_SLICE_BPS) / BPS) revert LaunchSliceTooBig();

        paidAt[epoch_][asset] = uint64(block.timestamp);
        paid[epoch_][asset] = toWallets + toLaunches;
        uint256 left = available - toWallets - toLaunches;
        carried[asset] = left;

        for (uint256 i; i < wallets.length; ++i) {
            _payWallet(epoch_, asset, wallets[i], amounts[i]);
        }
        for (uint256 i; i < pots.length; ++i) {
            _payPot(epoch_, asset, pots[i], potAmounts[i]);
        }
        emit EpochPaid(epoch_, asset, toWallets, toLaunches, left);
    }

    /// @notice Permissionless. Pays a wallet what it refused earlier, to the wallet itself.
    function claimOwed(address wallet, address asset) external nonReentrant {
        uint256 amount = owed[wallet][asset];
        if (amount == 0) revert Nothing();
        owed[wallet][asset] = 0;
        PairTransfer.push(asset, wallet, amount);
        emit OwedClaimed(wallet, asset, amount);
    }

    function _payWallet(uint64 epoch_, address asset, address wallet, uint256 amount) internal {
        if (amount == 0) return;
        bool ok;
        if (asset == address(0)) {
            (ok,) = wallet.call{value: amount, gas: PAY_GAS}("");
        } else {
            uint256 before = IERC20(asset).balanceOf(address(this));
            IERC20(asset).trySafeTransfer(wallet, amount);
            uint256 spent = before - IERC20(asset).balanceOf(address(this));
            if (spent != 0 && spent != amount) revert UnexpectedPayout();
            ok = spent == amount;
        }
        if (ok) {
            emit Paid(epoch_, asset, wallet, amount);
        } else {
            owed[wallet][asset] += amount;
            emit Owed(wallet, asset, amount);
        }
    }

    function _payPot(uint64 epoch_, address asset, address pot, uint256 amount) internal {
        if (amount == 0) return;
        if (IHoodPot(pot).asset() != asset) revert PotAssetMismatch();
        if (asset == address(0)) {
            IHoodPot(pot).depositForHolders{value: amount}(amount, BagReasons.PAYDAY, address(this));
        } else {
            IERC20(asset).forceApprove(pot, amount);
            IHoodPot(pot).depositForHolders(amount, BagReasons.PAYDAY, address(this));
        }
        emit LaunchSlice(epoch_, asset, pot, amount);
    }
}
