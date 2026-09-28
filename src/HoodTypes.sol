// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;


/// @notice Where the creator leg of the trading fee goes. Chosen at launch, locked forever.
/// @dev An allocation rather than a choice: the four legs are spent pro rata on every flush and
///      must add up to exactly 10_000, so a creator can pay their stakers and keep a slice and
///      still deepen the pool. `creatorBps = 10_000` is "I keep all of it".
///
///      There is no leg for "charge nothing". How BIG the creator leg is belongs to the preset, not
///      here: a launch that wants traders to pay the protocol and nobody else picks a preset whose
///      `creatorFeeBps` is zero, and then nothing is ever booked to split.
struct FeeSplit {
    uint16 stakersBps; // paid to stakers of this token, time-weighted (proof of belief)
    uint16 buybackBps; // buys the token back and burns it
    uint16 liquidityBps; // deepens the liquidity that the token graduates into
    uint16 creatorBps; // paid to the creator fee recipient
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
    // What the caps below are denominated in, and therefore the only pair this preset may be
    // launched against. Without it a preset is a pair of numbers with no unit: "starts at 3.5"
    // reads as ETH, as NVDA and as a thousandth of a dollar, and a creator picking from a list
    // would be picking a valuation a thousand times off without the form ever looking wrong.
    address pairToken;
    uint256 totalSupply; // token wei minted at launch (18 decimals)
    uint16 curveSupplyBps; // share of the supply sold on the curve; the rest seeds the pool
    uint256 startCap; // fully diluted valuation in pair units at the first token sold
    uint256 graduationCap; // fully diluted valuation in pair units at the last curve token sold
    uint16 liquidityBps; // share of the raise that seeds the pool; the rest is the graduation fee
    uint16 protocolFeeBps; // trading fee leg paid to the protocol treasury
    uint16 creatorFeeBps; // trading fee leg routed to the fee split
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
    FeeSplit feeSplit;
    address creatorFeeRecipient; // required when the split pays the creator anything
    uint256 firstBuy; // pair units spent on the creator's own first buy, in the launch transaction
    uint64 firstBuyLock; // seconds the first buy is locked in the staking vault; 0 = not locked
    bytes32 salt; // vanity salt, namespaced by the caller
    bytes32 econ; // economics hash pinned by the caller; see HoodFactory.previewLaunchEconomics
    // Wallets that pay no opening tax (SnipeSchedule), on top of the ones that never do: the
    // wallet that launches and the creator fee recipient. At most SnipeSchedule.MAX_EXEMPT. They
    // are on chain from the launch transaction on, like everything else here.
    address[] exempt;
}

/// @notice The registry row for a launched token.
struct Launch {
    address curve; // curve mode only; zero for a direct launch
    address creator;
    address creatorFeeRecipient;
    address pairToken;
    uint256 configId;
    FeeSplit feeSplit; // curve mode only; a direct launch splits its tax in its own splitter
    bytes32 symbolHash;
    bytes32 imageHash;
    uint64 launchedAt;
    bool exists;
    LaunchMode mode;
    /// @notice Token wei of the creator's first buy locked in the staking vault, and when it opens.
    ///         Both zero when the creator took their first buy in hand.
    uint256 firstBuyLocked;
    uint64 firstBuyUnlockAt;
    address hook; // direct mode only
    address splitter; // direct mode only
    address locker; // direct mode only
    /// @notice The launch's pot (IHoodPot): the per-share accumulator that pays this token's holders
    ///         in its quote. A HoodPot printed at launch for a curve launch; the revenue splitter
    ///         for a direct one. Appended last so older readers of the row keep decoding.
    address pot;
}
