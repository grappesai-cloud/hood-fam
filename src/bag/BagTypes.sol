// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @notice Where money came from when it entered the Bag.
enum BagSource {
    Trade, // the platform's 70 bps of every trade, every machine
    Graduation, // the 10% of a curve raise
    Penalty, // the 20% of every snipe, jeet or whale tax
    House, // launch fees and boost slots
    HouseCoin // the house coin's own creator leg
}

/// @notice Where money went when it left the Bag.
enum BagOutlet {
    House, // the treasury Safe
    Vault, // house-coin lockers (HoodStaking)
    Payday, // the hourly distributor
    Burn, // the burn clock
    Confetti // a token's pot, at bonding
}

/// @notice The sell-side penalties a launch can turn on. Snipe tax lives with the opening
///         window in the machine's own config (DirectConfig for direct launches).
/// @dev Fixed at launch. Every penalty is split 80% to that token's pot (or the Vault when
///      penaltiesToVault is on) and 20% into the Bag.
struct PenaltyConfig {
    uint16 jeetTaxBps; // 0 = off. Charged on a sell within jeetWindowSeconds of that wallet's last buy.
    uint32 jeetWindowSeconds; // how long after a buy a sell still counts as a flip
    uint16 whaleTaxBps; // 0 = off. Charged on a sell that moves the pool more than whaleTickLimit ticks.
    uint24 whaleTickLimit; // ticks of price move that make a sell a whale dump
    uint16 kingBps; // 0 = off. Slice of every penalty's holder share that fills the king-of-the-hill pot.
    bool penaltiesToVault; // "lockers eat the jeets": jeet and whale holder shares go to the Vault instead
}

/// @notice The reason tags a pot emits with every deposit, so the tape can say who paid.
library BagReasons {
    bytes32 internal constant SNIPE = keccak256("snipe");
    bytes32 internal constant JEET = keccak256("jeet");
    bytes32 internal constant WHALE = keccak256("whale");
    bytes32 internal constant CONFETTI = keccak256("confetti");
    bytes32 internal constant SLASH = keccak256("slash");
    bytes32 internal constant AUCTION = keccak256("auction");
    bytes32 internal constant PAYDAY = keccak256("payday");
    bytes32 internal constant DIVIDENDS = keccak256("dividends");
    bytes32 internal constant LP_FEES = keccak256("lp_fees");
    bytes32 internal constant KING = keccak256("king");
}

/// @notice Splits that are the same for every launch and never change after deploy.
library BagSplits {
    uint16 internal constant BPS = 10_000;
    // the 1% platform fee on every trade
    uint16 internal constant PLATFORM_FEE_BPS = 100;
    uint16 internal constant PLATFORM_CREATOR_BPS = 30; // of the trade, to the creator's leg
    uint16 internal constant PLATFORM_BAG_BPS = 70; // of the trade, into the Bag
    // the Bag's rules, in bps of what enters through each source
    uint16 internal constant TRADE_VAULT_BPS = 4_286; // 30 of 70
    uint16 internal constant TRADE_PAYDAY_BPS = 1_429; // 10 of 70
    uint16 internal constant TRADE_BURN_BPS = 1_429; // 10 of 70
    // house takes the rest of a trade: 20 of 70 = 2_856 bps, computed as the remainder
    uint16 internal constant GRAD_HOUSE_BPS = 5_000;
    uint16 internal constant GRAD_CONFETTI_BPS = 2_500;
    // vault takes the rest of a graduation fee: 2_500
    uint16 internal constant PENALTY_HOLDERS_BPS = 8_000; // to the token's pot, before the Bag
    uint16 internal constant PENALTY_BAG_BPS = 2_000; // into the Bag
    uint16 internal constant PENALTY_CUT_HOUSE_BPS = 5_000; // 10 of 20
    uint16 internal constant PENALTY_CUT_PAYDAY_BPS = 2_500; // 5 of 20
    // burn takes the rest of a penalty cut: 2_500
    uint16 internal constant HOUSE_COIN_VAULT_BPS = 5_000; // burn takes the rest
    uint16 internal constant PAYDAY_LAUNCH_SLICE_BPS = 1_000; // of an hour's pot, to the last ten launches
}
