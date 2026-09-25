// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "@uniswap/v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {BalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {SwapParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {SqrtPriceMath} from "@uniswap/v4-core/src/libraries/SqrtPriceMath.sol";
import {StateLibrary} from "@uniswap/v4-core/src/libraries/StateLibrary.sol";
import {PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";

import {PairTransfer} from "../libraries/PairTransfer.sol";
import {IHoodBurnClock} from "../interfaces/IHoodBurnClock.sol";
import {IHoodFactory} from "../interfaces/IHoodFactory.sol";

interface IBurnable {
    function burn(uint256 amount) external;
}

/// @title HoodBurnClock
/// @notice Holds the burn share of every asset and, once an hour, buys the house coin with it
///         and burns what it bought.
/// @dev The house coin and its pool are set once by the factory owner (the Safe). The pool's
///      other currency becomes `spendAsset`, the only asset the clock can spend. Every other
///      asset that is funded here accumulates and stays: there is no owner and no withdrawal.
///      The swap is impact-capped the way the buyback module's is: the input is sized to what
///      moves the price by at most MAX_IMPACT_TICKS, the limit stays on the swap as the backstop,
///      and whatever does not fit waits for the next hour.
contract HoodBurnClock is IHoodBurnClock, IUnlockCallback, ReentrancyGuard {
    using SafeERC20 for IERC20;
    using StateLibrary for IPoolManager;
    using PoolIdLibrary for PoolKey;

    /// @notice How far one burn may move the price, in ticks: about three percent.
    int24 public constant MAX_IMPACT_TICKS = 296;
    address public constant DEAD = 0x000000000000000000000000000000000000dEaD;
    uint256 internal constant PIPS = 1_000_000;

    IPoolManager public immutable poolManager;
    address public immutable factory;
    address public houseCoin;
    /// @notice The pool currency that is not the coin: the only asset a burn can spend.
    address public spendAsset;
    /// @notice Whether the coin is the pool's currency0.
    bool public coinIsZero;
    PoolKey internal _poolKey;
    address public keeper;

    mapping(address asset => uint256) public balanceOf;
    mapping(address asset => uint256) public totalSpent;
    uint256 public totalBurned;
    /// @notice The hour an asset was last spent in. One burn per asset per hour.
    mapping(address asset => uint64) public lastBurnEpoch;

    error NotOwner();
    error NotKeeper();
    error NotPoolManager();
    error WrongValue();
    error ZeroAddress();
    error AlreadySet();
    error CoinNotInPool();
    error PoolNotInitialized();
    error NoHouseCoin();
    error NotTheSpendAsset();
    error AlreadyBurnedThisHour();
    error Nothing();
    error Slippage();

    constructor(address factory_, address poolManager_) {
        factory = factory_;
        poolManager = IPoolManager(poolManager_);
    }

    receive() external payable {}

    function epoch() public view returns (uint64) {
        return uint64(block.timestamp / 1 hours);
    }

    function poolKey() external view returns (PoolKey memory) {
        return _poolKey;
    }

    // ---------------------------------------------------------------- owner

    /// @notice Names the house coin and the pool it is bought from. Once, factory owner only.
    ///         The pool's other currency becomes the spend asset.
    function setHouseCoin(address coin, PoolKey calldata key) external {
        if (msg.sender != IHoodFactory(factory).owner()) revert NotOwner();
        if (houseCoin != address(0)) revert AlreadySet();
        if (coin == address(0)) revert ZeroAddress();
        address c0 = Currency.unwrap(key.currency0);
        address c1 = Currency.unwrap(key.currency1);
        if (c0 == coin) {
            coinIsZero = true;
            spendAsset = c1;
        } else if (c1 == coin) {
            spendAsset = c0;
        } else {
            revert CoinNotInPool();
        }
        (uint160 sqrtP,,,) = poolManager.getSlot0(key.toId());
        if (sqrtP == 0) revert PoolNotInitialized();
        houseCoin = coin;
        _poolKey = key;
        emit HouseCoinSet(coin);
    }

    function setKeeper(address next) external {
        if (msg.sender != IHoodFactory(factory).owner()) revert NotOwner();
        keeper = next;
        emit KeeperSet(next);
    }

    // ---------------------------------------------------------------- money in

    /// @inheritdoc IHoodBurnClock
    /// @dev Any asset is accepted and booked. Only `spendAsset` can ever leave, through `burn`.
    function fund(address asset, uint256 amount) external payable {
        if (amount == 0) {
            if (msg.value != 0) revert WrongValue();
            return;
        }
        PairTransfer.pull(asset, msg.sender, amount, msg.value);
        balanceOf[asset] += amount;
        emit Funded(asset, amount);
    }

    // ---------------------------------------------------------------- the burn

    /// @inheritdoc IHoodBurnClock
    /// @dev Keeper or factory owner. Spends min(maxSpend, balance), bounded by the impact cap;
    ///      what the cap does not admit stays for the next hour. Burns through the coin's own
    ///      `burn` when it has one, otherwise sends the coin to the dead address.
    function burn(address asset, uint256 maxSpend, uint256 minOut)
        external
        nonReentrant
        returns (uint256 spent, uint256 burned)
    {
        if (msg.sender != keeper && msg.sender != IHoodFactory(factory).owner()) revert NotKeeper();
        address coin = houseCoin;
        if (coin == address(0)) revert NoHouseCoin();
        if (asset != spendAsset) revert NotTheSpendAsset();
        uint64 e = epoch();
        if (lastBurnEpoch[asset] == e) revert AlreadyBurnedThisHour();
        lastBurnEpoch[asset] = e;

        uint256 amount = balanceOf[asset];
        if (maxSpend < amount) amount = maxSpend;
        if (amount == 0) revert Nothing();

        spent = abi.decode(poolManager.unlock(abi.encode(amount)), (uint256));
        if (spent == 0) revert Nothing();
        balanceOf[asset] -= spent;
        totalSpent[asset] += spent;

        burned = IERC20(coin).balanceOf(address(this));
        if (burned < minOut) revert Slippage();
        if (burned != 0) _burnCoin(coin, burned);
        totalBurned += burned;
        emit Burned(asset, spent, burned, e);
    }

    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        if (msg.sender != address(poolManager)) revert NotPoolManager();
        uint256 amount = abi.decode(data, (uint256));
        PoolKey memory key = _poolKey;
        bool zeroForOne = !coinIsZero;

        // The limit is a few percent off the price at this instant. The swap stops there and the
        // rest of the balance waits for the next hour.
        (uint160 sqrtP, int24 tick,,) = poolManager.getSlot0(key.toId());
        int24 limitTick = zeroForOne ? tick - MAX_IMPACT_TICKS : tick + MAX_IMPACT_TICKS;
        if (limitTick < TickMath.MIN_TICK + 1) limitTick = TickMath.MIN_TICK + 1;
        if (limitTick > TickMath.MAX_TICK - 1) limitTick = TickMath.MAX_TICK - 1;
        uint160 sqrtLimit = TickMath.getSqrtPriceAtTick(limitTick);

        // Size the input to what the limit admits, grossed up for the pool's fee, so a hook that
        // taxes the amount offered never taxes more than the pool can fill. The limit stays on
        // the swap as the backstop.
        uint128 liquidity = poolManager.getLiquidity(key.toId());
        uint256 needed = liquidity == 0
            ? 0
            : zeroForOne
                ? SqrtPriceMath.getAmount0Delta(sqrtLimit, sqrtP, liquidity, true)
                : SqrtPriceMath.getAmount1Delta(sqrtP, sqrtLimit, liquidity, true);
        uint256 amountIn;
        if (needed != 0) {
            uint256 gross = (needed * PIPS) / (PIPS - key.fee) + 1;
            amountIn = gross < amount ? gross : amount;
        }
        if (amountIn == 0) return abi.encode(uint256(0));

        BalanceDelta delta = poolManager.swap(
            key,
            SwapParams({zeroForOne: zeroForOne, amountSpecified: -int256(amountIn), sqrtPriceLimitX96: sqrtLimit}),
            bytes("")
        );

        int128 spendDelta = zeroForOne ? delta.amount0() : delta.amount1();
        uint256 spent = spendDelta < 0 ? uint256(uint128(-spendDelta)) : 0;
        if (spent != 0) {
            if (spendAsset == address(0)) {
                poolManager.settle{value: spent}();
            } else {
                poolManager.sync(Currency.wrap(spendAsset));
                IERC20(spendAsset).safeTransfer(address(poolManager), spent);
                poolManager.settle();
            }
        }

        int128 out = zeroForOne ? delta.amount1() : delta.amount0();
        if (out > 0) poolManager.take(Currency.wrap(houseCoin), address(this), uint256(uint128(out)));
        return abi.encode(spent);
    }

    function _burnCoin(address coin, uint256 amount) internal {
        try IBurnable(coin).burn(amount) {}
        catch {
            IERC20(coin).safeTransfer(DEAD, amount);
        }
    }
}
