// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @notice A v4 pool is identified by this struct, sorted by currency address, native = address(0).
struct PoolKey {
    address currency0;
    address currency1;
    uint24 fee;
    int24 tickSpacing;
    address hooks;
}

/// @notice v4's swap arguments. Same layout as v4-core's `SwapParams`, declared here so this file
///         stays the one place the graduator learns about the outside world.
struct SwapParams {
    bool zeroForOne;
    int256 amountSpecified;
    uint160 sqrtPriceLimitX96;
}

interface IPoolManager {
    function initialize(PoolKey memory key, uint160 sqrtPriceX96) external returns (int24 tick);
    function unlock(bytes calldata data) external returns (bytes memory);
    function donate(PoolKey memory key, uint256 amount0, uint256 amount1, bytes calldata hookData)
        external
        returns (int256 delta);
    /// @dev The return is v4's packed BalanceDelta: two int128 halves in one word, zero when the
    ///      swap moved no money at all.
    function swap(PoolKey memory key, SwapParams memory params, bytes calldata hookData)
        external
        returns (int256 swapDelta);
    function sync(address currency) external;
    function settle() external payable returns (uint256);
}

interface IPositionManager {
    function modifyLiquidities(bytes calldata unlockData, uint256 deadline) external payable;
    function nextTokenId() external view returns (uint256);
    function getPositionLiquidity(uint256 tokenId) external view returns (uint128);
}

interface IStateView {
    function getSlot0(bytes32 poolId)
        external
        view
        returns (uint160 sqrtPriceX96, int24 tick, uint24 protocolFee, uint24 lpFee);
    function getLiquidity(bytes32 poolId) external view returns (uint128);
}

interface IUniversalRouter {
    function execute(bytes calldata commands, bytes[] calldata inputs, uint256 deadline) external payable;
}

interface IPermit2 {
    function approve(address token, address spender, uint160 amount, uint48 expiration) external;
}

/// @notice Action ids from uniswap/v4-periphery, and the router command from uniswap/universal-router.
library V4Actions {
    uint8 internal constant INCREASE_LIQUIDITY = 0x00;
    uint8 internal constant DECREASE_LIQUIDITY = 0x01;
    uint8 internal constant MINT_POSITION = 0x02;
    uint8 internal constant SWAP_EXACT_IN_SINGLE = 0x06;
    uint8 internal constant DONATE = 0x0a;
    uint8 internal constant SETTLE = 0x0b;
    uint8 internal constant SETTLE_ALL = 0x0c;
    uint8 internal constant SETTLE_PAIR = 0x0d;
    uint8 internal constant TAKE_ALL = 0x0f;
    uint8 internal constant TAKE_PAIR = 0x11;
    uint8 internal constant SWEEP = 0x14;

    uint8 internal constant CMD_V4_SWAP = 0x10;
}

/// @notice Exact-input single swap params for the UniversalRouter on chain 4663.
/// @dev WARNING: the router at 0x8876...C0904 vendors a MODIFIED v4-periphery. Every swap struct
///      carries one EXTRA field, `minHopPriceX36`, between `amountOutMinimum` and `hookData`.
///      Canonical encoding silently misreads hookData on non-native pools. Verified against the
///      source published on the explorer.
struct ExactInputSingleParams {
    PoolKey poolKey;
    bool zeroForOne;
    uint128 amountIn;
    uint128 amountOutMinimum;
    uint256 minHopPriceX36;
    bytes hookData;
}
