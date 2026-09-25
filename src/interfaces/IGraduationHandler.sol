// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

interface IGraduationHandler {
    /// @notice Called by the factory inside the launch transaction, before the token can trade.
    /// @dev Anybody may open a Uniswap v4 pool for any pair of currencies, at any price. If the
    ///      pool were only opened at graduation, a stranger could open it first, at a price of
    ///      their choosing, for the cost of one transaction, and every launch on the platform
    ///      could be griefed that way. Opening it here removes the window: the token address does
    ///      not exist until this transaction, and the pool is priced before anyone has seen it.
    function prepare(
        address token,
        address pairToken,
        uint256 tokenAmount,
        uint256 pairAmount,
        uint24 poolFee,
        int24 tickSpacing
    ) external;

    /// @notice Called once by a curve that sold out. Receives the pool side of the supply and the
    ///         pair funds, and must open a pool with liquidity that nobody can pull back out.
    /// @dev Native pair arrives as value; an ERC-20 pair is transferred before the call. The pool
    ///      trades through the graduation hook, which the handler registers it with here (token,
    ///      pot, the launch's penalties) before any liquidity goes in.
    function graduate(
        address token,
        address pairToken,
        uint256 tokenAmount,
        uint256 pairAmount,
        uint24 poolFee,
        int24 tickSpacing
    ) external payable;

    /// @notice Permissionless. Pulls the fees the locked position earned and hands them to the fee router.
    function collect(address token) external;

    /// @notice Adds pair funds to the locked position (the liquidity leg of a fee split, after graduation).
    function compound(address token, uint256 amount) external payable;

    /// @notice Buys `token` out of its pool with `amount` of pair funds and burns what it gets.
    /// @param minTokensOut floor set by the caller; a permissionless swap with no floor is a gift to sandwichers.
    function buyback(address token, uint256 amount, uint256 minTokensOut) external payable returns (uint256 burned);

    function isGraduated(address token) external view returns (bool);
}
