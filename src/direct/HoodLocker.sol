// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {StateLibrary} from "@uniswap/v4-core/src/libraries/StateLibrary.sol";
import {IUnlockCallback} from "@uniswap/v4-core/src/interfaces/callback/IUnlockCallback.sol";

import {PairTransfer} from "../libraries/PairTransfer.sol";

interface IPositionManagerLite {
    function modifyLiquidities(bytes calldata unlockData, uint256 deadline) external payable;
    function getPositionLiquidity(uint256 tokenId) external view returns (uint128);
}

interface IBurnableToken {
    function burn(uint256 amount) external;
}

interface ISplitterSweep {
    function sweep() external;
}

/// @title HoodLocker
/// @notice Holds a launch's liquidity position and cannot let go of it.
/// @dev There is no withdrawal function, no rescue function, no owner and no upgrade path. The two
///      things it can do are collect the fees the position earned and deepen the position with
///      what the splitter sends it, and anybody may call either. A launch's liquidity is locked
///      because there is no code that could move it, which is the only kind of lock worth having.
contract HoodLocker is IUnlockCallback {
    using SafeERC20 for IERC20;
    using StateLibrary for IPoolManager;
    using PoolIdLibrary for PoolKey;

    uint8 internal constant DECREASE_LIQUIDITY = 0x01;
    uint8 internal constant TAKE_PAIR = 0x11;
    /// @notice How much of the in-range liquidity a donation lands on may belong to somebody other
    ///         than this launch: one part in a thousand.
    uint256 internal constant STRANGER_TOLERANCE_BPS = 10;

    address public immutable portal;
    IPoolManager public immutable poolManager;
    IPositionManagerLite public immutable positionManager;
    address public immutable token;
    address public immutable quote;
    address public immutable splitter;
    uint256 public positionId;
    PoolKey internal _key;

    event FeesHarvested(uint256 quoteAmount, uint256 tokenBurned);
    event LiquidityDeepened(uint256 quoteAmount);

    error NotPortal();
    error NotPoolManager();
    error AlreadySet();
    error Nothing();
    error NotAloneInRange();

    constructor(
        address portal_,
        address poolManager_,
        address positionManager_,
        address token_,
        address quote_,
        address splitter_
    ) {
        portal = portal_;
        poolManager = IPoolManager(poolManager_);
        positionManager = IPositionManagerLite(positionManager_);
        token = token_;
        quote = quote_;
        splitter = splitter_;
    }

    receive() external payable {}

    function setPosition(uint256 positionId_, PoolKey calldata key) external {
        if (msg.sender != portal) revert NotPortal();
        if (positionId != 0) revert AlreadySet();
        positionId = positionId_;
        _key = key;
    }

    function poolKey() external view returns (PoolKey memory) {
        return _key;
    }

    /// @notice Permissionless. Pulls what the position earned and sends it where the launch says.
    /// @dev The quote side goes to the splitter, which runs it through the same four roads as a
    ///      swap tax. The token side is burned: it came out of the pool and it does not go back to
    ///      any person.
    function harvestFees() external {
        bytes memory actions = abi.encodePacked(DECREASE_LIQUIDITY, TAKE_PAIR);
        bytes[] memory params = new bytes[](2);
        params[0] = abi.encode(positionId, uint256(0), uint256(0), uint256(0), bytes(""));
        params[1] = abi.encode(_key.currency0, _key.currency1, address(this));
        positionManager.modifyLiquidities(abi.encode(actions, params), block.timestamp);

        uint256 tokenAmount = IERC20(token).balanceOf(address(this));
        if (tokenAmount != 0) IBurnableToken(token).burn(tokenAmount);

        uint256 quoteAmount = PairTransfer.balance(quote, address(this));
        if (quoteAmount != 0) {
            PairTransfer.push(quote, splitter, quoteAmount);
            ISplitterSweep(splitter).sweep();
        }
        emit FeesHarvested(quoteAmount, tokenAmount);
    }

    /// @notice Permissionless. Turns quote sitting here into depth for the launch's own position.
    /// @dev Single-sided funds cannot mint liquidity, so they are donated to the pool. A donation
    ///      credits whoever is in range at that instant, which Uniswap's own `IPoolManager.donate`
    ///      warns about: a bot mints a one-spacing position on the current tick, calls this, takes
    ///      its share of the pot and burns the position again, all in one transaction and with a
    ///      flash loan for the capital. So this refuses to donate unless the in-range liquidity is
    ///      this launch's position and nothing else, give or take a thousandth. Whatever is here
    ///      stays here until that is true again; nothing is lost by waiting.
    function deepen() external {
        uint256 amount = PairTransfer.balance(quote, address(this));
        if (amount == 0) revert Nothing();
        _requireRangeIsOurs();
        poolManager.unlock(abi.encode(amount));
        emit LiquidityDeepened(amount);
    }

    /// @notice Whether a donation right now would land on this launch's position alone, which is
    ///         what `deepen` requires. False also while the price sits outside the position's range.
    function canDeepen() public view returns (bool) {
        uint128 mine = positionManager.getPositionLiquidity(positionId);
        if (mine == 0) return false;
        uint128 active = poolManager.getLiquidity(_key.toId());
        return active >= mine && uint256(active) <= uint256(mine) + (uint256(mine) * STRANGER_TOLERANCE_BPS) / 10_000;
    }

    function _requireRangeIsOurs() internal view {
        if (!canDeepen()) revert NotAloneInRange();
    }

    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        if (msg.sender != address(poolManager)) revert NotPoolManager();
        uint256 amount = abi.decode(data, (uint256));
        bool quoteIsZero = Currency.unwrap(_key.currency0) == quote;

        poolManager.donate(_key, quoteIsZero ? amount : 0, quoteIsZero ? 0 : amount, bytes(""));
        if (quote == address(0)) {
            poolManager.settle{value: amount}();
        } else {
            poolManager.sync(Currency.wrap(quote));
            IERC20(quote).safeTransfer(address(poolManager), amount);
            poolManager.settle();
        }
        return bytes("");
    }
}
