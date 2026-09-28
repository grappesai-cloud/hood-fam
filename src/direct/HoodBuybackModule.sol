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
import {StateLibrary} from "@uniswap/v4-core/src/libraries/StateLibrary.sol";
import {PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";

import {BuybackMath} from "./lib/BuybackMath.sol";

interface ISplitter {
    function releaseBuyback() external returns (uint256);
    function token() external view returns (address);
    function quote() external view returns (address);
}

interface ILockerKey {
    function poolKey() external view returns (PoolKey memory);
}

interface IBurnable {
    function burn(uint256 amount) external;
}

interface IHookTax {
    function buyTaxBps() external view returns (uint16);
}

interface IPortalLaunches {
    function getLaunch(address token) external view returns (
        address token_, address quote, address hook, address splitter, address locker,
        address creator, uint256 positionId, uint64 launchedAt, bool exists
    );
}

/// @title HoodBuybackModule
/// @notice One contract, shared by every direct launch: pulls a launch's buyback pot, buys the
///         token with it and burns what it gets.
/// @dev Permissionless and external on purpose. The splitter's job is to hold the rules; the
///      swapping is a moving part, so it lives outside, where it can be replaced without touching
///      a single launch's money. It swaps straight against the PoolManager rather than through a
///      router, which keeps the hook's view of the caller honest: a buyback is not a trader.
contract HoodBuybackModule is IUnlockCallback, ReentrancyGuard {
    using SafeERC20 for IERC20;
    using StateLibrary for IPoolManager;
    using PoolIdLibrary for PoolKey;

    IPoolManager public immutable poolManager;
    address public immutable portal;

    /// @notice How far one run may move the price, in ticks: about three percent. A run is
    ///         permissionless, so this is what keeps a stranger's run from being a stranger's
    ///         sandwich; what does not fit under the limit waits for the next run.
    int24 public constant MAX_IMPACT_TICKS = BuybackMath.MAX_IMPACT_TICKS;
    /// @notice Quote a run could not spend inside the impact limit, kept here for the next run.
    mapping(address token => uint256) public carried;
    /// @notice The block a token's last run landed in. One run per token per block.
    /// @dev The impact limit bounds ONE swap, and `carried` is what makes a run resumable. Without
    ///      this, the two compose into the very thing the limit exists to stop: a caller chains
    ///      `run` inside a single transaction, each call walking the price another three percent up
    ///      its own fresh reading of the book, and the whole pot is spent between the attacker's
    ///      buy and their sell. A pot now takes as many blocks to spend as it takes, and every
    ///      block in between is one where somebody else can trade.
    mapping(address token => uint64) public lastRunBlock;

    event BoughtBack(address indexed token, uint256 spent, uint256 burned);

    error NotPoolManager();
    error UnknownLaunch();
    error Slippage();
    error Nothing();
    error AlreadyRanThisBlock();

    struct SwapContext {
        PoolKey key;
        address quote;
        address token;
        uint256 amount;
        bool zeroForOne;
        uint256 buyTaxBps;
    }

    constructor(address poolManager_, address portal_) {
        poolManager = IPoolManager(poolManager_);
        portal = portal_;
    }

    receive() external payable {}

    /// @notice Permissionless, once per token per block. The keeper passes a `minTokensOut` from a
    ///         quote; a stranger passing zero is bounded by the impact limit and by the one run a
    ///         block, so the worst they can do is buy a little at a little worse price.
    function run(address token, uint256 minTokensOut) external nonReentrant returns (uint256 burned) {
        (, address quote, address hook, address splitter, address locker,,,, bool exists) =
            IPortalLaunches(portal).getLaunch(token);
        if (!exists) revert UnknownLaunch();
        // One run a block, or the cap bounds one swap and nothing else.
        if (lastRunBlock[token] == uint64(block.number)) revert AlreadyRanThisBlock();
        lastRunBlock[token] = uint64(block.number);

        uint256 released;
        try ISplitter(splitter).releaseBuyback() returns (uint256 a) {
            released = a;
        } catch {}
        uint256 amount = released + carried[token];
        if (amount == 0) revert Nothing();
        carried[token] = 0;

        PoolKey memory key = ILockerKey(locker).poolKey();
        bool zeroForOne = Currency.unwrap(key.currency0) == quote;

        bytes memory ret = poolManager.unlock(
            abi.encode(
                SwapContext({
                    key: key, quote: quote, token: token, amount: amount, zeroForOne: zeroForOne,
                    buyTaxBps: IHookTax(hook).buyTaxBps()
                })
            )
        );
        uint256 spent = abi.decode(ret, (uint256));
        if (spent == 0) revert Nothing();
        if (spent < amount) carried[token] = amount - spent;

        burned = IERC20(token).balanceOf(address(this));
        if (burned < minTokensOut) revert Slippage();
        if (burned != 0) IBurnable(token).burn(burned);
        emit BoughtBack(token, spent, burned);
    }

    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        if (msg.sender != address(poolManager)) revert NotPoolManager();
        SwapContext memory c = abi.decode(data, (SwapContext));

        // The limit is a few percent off the price at this instant. The swap stops there and the
        // rest of the pot is carried, which is what makes a permissionless run safe to expose.
        // The hook taxes an exact input on the amount OFFERED, before the pool says how much it
        // could fill under the limit. So the input is sized to what the limit admits: the quote
        // that moves the in-range liquidity to the limit, grossed up for the pool's fee and the
        // hook's base tax. The limit stays on the swap as the backstop.
        (uint256 amountIn, uint160 sqrtLimit) =
            BuybackMath.sizeToCap(poolManager, c.key, c.zeroForOne, c.buyTaxBps, MAX_IMPACT_TICKS);
        if (amountIn > c.amount) amountIn = c.amount;
        if (amountIn == 0) return abi.encode(uint256(0));

        BalanceDelta delta = poolManager.swap(
            c.key,
            SwapParams({zeroForOne: c.zeroForOne, amountSpecified: -int256(amountIn), sqrtPriceLimitX96: sqrtLimit}),
            bytes("")
        );

        // pay what the swap actually consumed in the quote, tax included
        int128 quoteDelta = c.zeroForOne ? delta.amount0() : delta.amount1();
        uint256 spent = quoteDelta < 0 ? uint256(uint128(-quoteDelta)) : 0;
        if (spent != 0) {
            if (c.quote == address(0)) {
                poolManager.settle{value: spent}();
            } else {
                poolManager.sync(Currency.wrap(c.quote));
                IERC20(c.quote).safeTransfer(address(poolManager), spent);
                poolManager.settle();
            }
        }

        // and collect the token the swap produced
        int128 out = c.zeroForOne ? delta.amount1() : delta.amount0();
        if (out > 0) poolManager.take(Currency.wrap(c.token), address(this), uint256(uint128(out)));
        return abi.encode(spent);
    }
}
