// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import {BagSource, BagOutlet, BagReasons, BagSplits} from "./BagTypes.sol";
import {PairTransfer} from "../libraries/PairTransfer.sol";
import {IHoodBag} from "../interfaces/IHoodBag.sol";
import {IHoodPot} from "../interfaces/IHoodPot.sol";
import {IHoodPayday} from "../interfaces/IHoodPayday.sol";
import {IHoodBurnClock} from "../interfaces/IHoodBurnClock.sol";
import {IHoodStaking} from "../interfaces/IHoodStaking.sol";

/// @title HoodBag
/// @notice The one router every platform fee passes through. Five doors in, four outlets out,
///         and the splits are constants: nobody owns this contract and nothing can be withdrawn
///         from it except along the rules below.
/// @dev The house is paid first on every intake. A house that cannot take a native transfer (a
///      Safe module that reverts, a treasury mid-rotation) is booked in `houseClaimable` and paid
///      later by anyone, so a trade is never blocked by the treasury. The Vault leg waits for the
///      house coin: while `vault.houseToken()` is zero the share is held here and released by
///      anyone once the coin exists. The burn leg goes to the burn clock, which only accumulates;
///      if that call ever fails the share is held the same way. Payday and Confetti are paid
///      straight through.
///
///      Every `take*` uses the payment convention of IHoodBag: native with `msg.value == amount`,
///      or an approved ERC-20 the Bag pulls from the caller.
contract HoodBag is IHoodBag, ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint256 internal constant BPS = BagSplits.BPS;
    /// @dev Gas forwarded to the house on a native push. A Safe's receive needs a few thousand;
    ///      the cap keeps a trade's gas bounded whatever the treasury does with the call.
    uint256 internal constant HOUSE_GAS = 50_000;

    address public immutable house;
    address public immutable vault;
    address public immutable payday;
    address public immutable burnClock;

    /// @notice Everything that entered, per asset and source.
    mapping(address asset => mapping(BagSource source => uint256)) public totalIn;
    /// @notice Everything that left, per asset and outlet. Held and deferred money is not out yet.
    mapping(address asset => mapping(BagOutlet outlet => uint256)) public totalOut;
    /// @notice Vault shares waiting for the house coin, or for a vault that stopped taking them.
    mapping(address asset => uint256) public heldForVault;
    /// @notice Burn shares the clock could not take when they arrived.
    mapping(address asset => uint256) public heldForBurn;
    /// @notice House shares the treasury refused. Anyone can push them to the house later.
    mapping(address asset => uint256) public houseClaimable;

    event HouseDeferred(address indexed asset, uint256 amount);
    event HouseClaimed(address indexed asset, uint256 amount);

    error ZeroAddress();
    error WrongValue();
    error NotSelf();
    error UnexpectedPayout();
    error NothingToClaim();
    error NothingReleased();
    error PotAssetMismatch();

    constructor(address house_, address vault_, address payday_, address burnClock_) {
        if (house_ == address(0) || vault_ == address(0) || payday_ == address(0) || burnClock_ == address(0)) {
            revert ZeroAddress();
        }
        house = house_;
        vault = vault_;
        payday = payday_;
        burnClock = burnClock_;
    }

    // ---------------------------------------------------------------- the five doors

    /// @inheritdoc IHoodBag
    function takeTradeFee(address asset, uint256 amount, address token) external payable nonReentrant {
        if (!_intake(BagSource.Trade, asset, amount, token)) return;
        uint256 toVault = (amount * BagSplits.TRADE_VAULT_BPS) / BPS;
        uint256 toPayday = (amount * BagSplits.TRADE_PAYDAY_BPS) / BPS;
        uint256 toBurn = (amount * BagSplits.TRADE_BURN_BPS) / BPS;
        _house(asset, amount - toVault - toPayday - toBurn);
        _vault(asset, toVault);
        _payday(asset, toPayday);
        _burn(asset, toBurn);
    }

    /// @inheritdoc IHoodBag
    /// @dev A launch without a pot (address(0)) folds its Confetti into the Vault leg, so a
    ///      graduation never fails on the Bag and the money stays inside the system.
    function takeGraduationFee(address asset, uint256 amount, address token, address pot)
        external
        payable
        nonReentrant
    {
        if (!_intake(BagSource.Graduation, asset, amount, token)) return;
        uint256 toHouse = (amount * BagSplits.GRAD_HOUSE_BPS) / BPS;
        uint256 toConfetti = (amount * BagSplits.GRAD_CONFETTI_BPS) / BPS;
        uint256 toVault = amount - toHouse - toConfetti;
        _house(asset, toHouse);
        if (pot == address(0)) {
            toVault += toConfetti;
        } else {
            _confetti(asset, toConfetti, pot);
        }
        _vault(asset, toVault);
    }

    /// @inheritdoc IHoodBag
    function takePenaltyCut(address asset, uint256 amount, address token) external payable nonReentrant {
        if (!_intake(BagSource.Penalty, asset, amount, token)) return;
        uint256 toHouse = (amount * BagSplits.PENALTY_CUT_HOUSE_BPS) / BPS;
        uint256 toPayday = (amount * BagSplits.PENALTY_CUT_PAYDAY_BPS) / BPS;
        _house(asset, toHouse);
        _payday(asset, toPayday);
        _burn(asset, amount - toHouse - toPayday);
    }

    /// @inheritdoc IHoodBag
    function takeHouseFee(address asset, uint256 amount, address token) external payable nonReentrant {
        if (!_intake(BagSource.House, asset, amount, token)) return;
        _house(asset, amount);
    }

    /// @inheritdoc IHoodBag
    function takeHouseCoinLeg(address asset, uint256 amount) external payable nonReentrant {
        if (!_intake(BagSource.HouseCoin, asset, amount, _houseToken())) return;
        uint256 toVault = (amount * BagSplits.HOUSE_COIN_VAULT_BPS) / BPS;
        _vault(asset, toVault);
        _burn(asset, amount - toVault);
    }

    // ---------------------------------------------------------------- held money

    /// @inheritdoc IHoodBag
    /// @dev Reverts only when nothing could be released: the Vault share needs the house coin,
    ///      the burn share needs the clock to take it. Whatever cannot go yet stays held.
    function releaseHeld(address asset) external nonReentrant {
        bool released;
        uint256 forVault = heldForVault[asset];
        if (forVault != 0 && _vaultReady()) {
            heldForVault[asset] = 0;
            try this.pushVault(asset, forVault) {
                released = true;
                totalOut[asset][BagOutlet.Vault] += forVault;
                emit BagOut(BagOutlet.Vault, asset, forVault, vault);
            } catch {
                heldForVault[asset] = forVault;
            }
        }
        uint256 forBurn = heldForBurn[asset];
        if (forBurn != 0) {
            heldForBurn[asset] = 0;
            try this.pushBurn(asset, forBurn) {
                released = true;
                totalOut[asset][BagOutlet.Burn] += forBurn;
                emit BagOut(BagOutlet.Burn, asset, forBurn, burnClock);
            } catch {
                heldForBurn[asset] = forBurn;
            }
        }
        if (!released) revert NothingReleased();
    }

    /// @notice Permissionless. Pushes what the house refused earlier to the house.
    function claimHouse(address asset) external nonReentrant {
        uint256 amount = houseClaimable[asset];
        if (amount == 0) revert NothingToClaim();
        houseClaimable[asset] = 0;
        totalOut[asset][BagOutlet.House] += amount;
        PairTransfer.push(asset, house, amount);
        emit HouseClaimed(asset, amount);
        emit BagOut(BagOutlet.House, asset, amount, house);
    }

    // ---------------------------------------------------------------- self-calls

    /// @notice Pushes `amount` to the vault and notifies it, as one atomic step.
    /// @dev Only the Bag itself may call this. It exists so the ERC-20 transfer and the notify
    ///      succeed or fail together inside a try/catch: a notify that reverts after a transfer
    ///      would otherwise leave money at the vault that nobody booked.
    function pushVault(address asset, uint256 amount) external {
        if (msg.sender != address(this)) revert NotSelf();
        if (asset == address(0)) {
            IHoodStaking(vault).notifyReward{value: amount}(asset, amount);
        } else {
            IERC20(asset).safeTransfer(vault, amount);
            IHoodStaking(vault).notifyReward(asset, amount);
        }
    }

    /// @notice Funds the burn clock with `amount`. Only the Bag itself may call this.
    function pushBurn(address asset, uint256 amount) external {
        if (msg.sender != address(this)) revert NotSelf();
        if (asset == address(0)) {
            IHoodBurnClock(burnClock).fund{value: amount}(asset, amount);
        } else {
            IERC20(asset).forceApprove(burnClock, amount);
            IHoodBurnClock(burnClock).fund(asset, amount);
        }
    }

    // ---------------------------------------------------------------- the legs

    /// @dev Pulls the money in and books it. Returns false for a zero amount, which is a no-op.
    function _intake(BagSource source, address asset, uint256 amount, address token) internal returns (bool) {
        if (amount == 0) {
            if (msg.value != 0) revert WrongValue();
            return false;
        }
        PairTransfer.pull(asset, msg.sender, amount, msg.value);
        totalIn[asset][source] += amount;
        emit BagIn(source, asset, amount, token);
        return true;
    }

    /// @dev The house is paid first and never blocks: a refused push is booked for `claimHouse`.
    function _house(address asset, uint256 amount) internal {
        if (amount == 0) return;
        bool paid;
        if (asset == address(0)) {
            (paid,) = house.call{value: amount, gas: HOUSE_GAS}("");
        } else {
            uint256 before = IERC20(asset).balanceOf(address(this));
            IERC20(asset).trySafeTransfer(house, amount);
            uint256 spent = before - IERC20(asset).balanceOf(address(this));
            // A nonstandard token may move funds and still return false. Never book those funds a
            // second time, and never continue after an inexact outgoing transfer.
            if (spent != 0 && spent != amount) revert UnexpectedPayout();
            paid = spent == amount;
        }
        if (paid) {
            totalOut[asset][BagOutlet.House] += amount;
            emit BagOut(BagOutlet.House, asset, amount, house);
        } else {
            houseClaimable[asset] += amount;
            emit HouseDeferred(asset, amount);
        }
    }

    function _vault(address asset, uint256 amount) internal {
        if (amount == 0) return;
        if (_vaultReady()) {
            try this.pushVault(asset, amount) {
                totalOut[asset][BagOutlet.Vault] += amount;
                emit BagOut(BagOutlet.Vault, asset, amount, vault);
                return;
            } catch {}
        }
        heldForVault[asset] += amount;
        emit Held(BagOutlet.Vault, asset, amount);
    }

    function _burn(address asset, uint256 amount) internal {
        if (amount == 0) return;
        try this.pushBurn(asset, amount) {
            totalOut[asset][BagOutlet.Burn] += amount;
            emit BagOut(BagOutlet.Burn, asset, amount, burnClock);
            return;
        } catch {
            // do not leave an allowance behind on the failure path
            if (asset != address(0)) IERC20(asset).forceApprove(burnClock, 0);
        }
        heldForBurn[asset] += amount;
        emit Held(BagOutlet.Burn, asset, amount);
    }

    function _payday(address asset, uint256 amount) internal {
        if (amount == 0) return;
        if (asset == address(0)) {
            IHoodPayday(payday).fund{value: amount}(asset, amount);
        } else {
            IERC20(asset).forceApprove(payday, amount);
            IHoodPayday(payday).fund(asset, amount);
        }
        totalOut[asset][BagOutlet.Payday] += amount;
        emit BagOut(BagOutlet.Payday, asset, amount, payday);
    }

    function _confetti(address asset, uint256 amount, address pot) internal {
        if (amount == 0) return;
        if (IHoodPot(pot).asset() != asset) revert PotAssetMismatch();
        if (asset == address(0)) {
            IHoodPot(pot).depositForHolders{value: amount}(amount, BagReasons.CONFETTI, address(this));
        } else {
            IERC20(asset).forceApprove(pot, amount);
            IHoodPot(pot).depositForHolders(amount, BagReasons.CONFETTI, address(this));
        }
        totalOut[asset][BagOutlet.Confetti] += amount;
        emit BagOut(BagOutlet.Confetti, asset, amount, pot);
    }

    function _vaultReady() internal view returns (bool) {
        return _houseToken() != address(0);
    }

    function _houseToken() internal view returns (address) {
        return IHoodStaking(vault).houseToken();
    }
}
