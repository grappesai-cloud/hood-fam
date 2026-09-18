// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @notice What happens to the creator leg of the trading fee. Chosen at launch, locked forever.
enum FeeModel {
    StakingRewards, // paid to stakers of this token, time-weighted (proof of belief)
    BuybackBurn, // buys the token back and burns it
    LiquidityCompound, // deepens the liquidity that the token graduates into
    CreatorKeep, // paid to the creator fee recipient
    ZeroFee // no creator leg at all; traders only pay the protocol fee
}

/// @notice Which machine a launch runs on.
/// @dev Curve: a bonding curve that sells into a reserve and graduates into a pool.
///      Direct: the whole supply sits in one pool position from block one, with a tax hook on it.
enum LaunchMode {
    Curve,
    Direct
}

/// @notice Lifecycle of a launch.
enum Phase {
    Curve, // trading on the bonding curve
    Sold, // curve supply exhausted, waiting for anyone to call finalize()
    Graduated // liquidity is in the pool, the curve is closed forever
}

/// @notice A launch preset. Presets are append-only: an existing config can be disabled for new
///         launches but never edited, so the economics of a live token cannot be changed under it.
struct CurveConfig {
    uint256 totalSupply; // token wei minted at launch (18 decimals)
    uint16 curveSupplyBps; // share of the supply sold on the curve; the rest seeds the pool
    uint256 startCap; // fully diluted valuation in pair units at the first token sold
    uint256 graduationCap; // fully diluted valuation in pair units at the last curve token sold
    uint16 liquidityBps; // share of the raise that seeds the pool; the rest is the graduation fee
    uint16 protocolFeeBps; // trading fee leg paid to the protocol treasury
    uint16 creatorFeeBps; // trading fee leg routed to the fee model
    uint24 poolFee; // pool fee for the graduated pool
    int24 tickSpacing; // tick spacing for the graduated pool
    bool enabled; // whether new launches may still pick this preset
}

/// @notice Everything a creator picks for one launch.
struct LaunchParams {
    string name;
    string symbol;
    string image; // uri; only its hash is stored, for the copycat lock
    string description;
    string website;
    string twitter;
    string telegram;
    address pairToken; // address(0) = native
    uint256 configId;
    FeeModel feeModel;
    address creatorFeeRecipient; // ignored for ZeroFee, required for CreatorKeep
    uint256 firstBuy; // pair units spent on the creator's own first buy, in the launch transaction
    bytes32 salt; // vanity salt, namespaced by the caller
    bytes32 econ; // economics hash pinned by the caller; see HoodFactory.previewLaunchEconomics
}

/// @notice The registry row for a launched token.
struct Launch {
    address curve; // curve mode only; zero for a direct launch
    address creator;
    address creatorFeeRecipient;
    address pairToken;
    uint256 configId;
    FeeModel feeModel; // curve mode only
    bytes32 symbolHash;
    bytes32 imageHash;
    uint64 launchedAt;
    bool exists;
    LaunchMode mode;
    address hook; // direct mode only
    address splitter; // direct mode only
    address locker; // direct mode only
}
