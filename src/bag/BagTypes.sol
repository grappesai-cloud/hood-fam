// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @notice Where money came from when it entered the Bag.
enum BagSource {
    Trade, // the platform's 30 bps of every trade, every machine (sniper tax included)
    Graduation, // the 10% of a curve raise
    Boost, // boost slots, for the Payday of the hour they run
    House, // launch fees
    HouseCoin // the house coin's own creator leg
}

/// @notice Where money went when it left the Bag.
enum BagOutlet {
    House, // the treasury Safe
    Vault, // house-coin lockers (HoodStaking)
    Payday, // the hourly distributor
    Burn, // the burn clock
    Dev // a graduating launch's creator fee recipient
}

/// @notice The reason tags a pot emits with every deposit, so the tape can say who paid.
library BagReasons {
    bytes32 internal constant SLASH = keccak256("slash");
    bytes32 internal constant PAYDAY = keccak256("payday");
    bytes32 internal constant DIVIDENDS = keccak256("dividends");
    bytes32 internal constant LP_FEES = keccak256("lp_fees");
}

/// @notice Splits that are the same for every launch and never change after deploy.
library BagSplits {
    uint16 internal constant BPS = 10_000;
    // the 1% platform fee on every trade: 70 to the creator's leg, 30 into the Bag
    uint16 internal constant PLATFORM_FEE_BPS = 100;
    uint16 internal constant PLATFORM_CREATOR_BPS = 70; // of the trade, to the creator's leg
    uint16 internal constant PLATFORM_BAG_BPS = 30; // of the trade, into the Bag
    // the Bag's rules, in bps of what enters through each source
    uint16 internal constant TRADE_VAULT_BPS = 3_333; // 10 of 30
    uint16 internal constant TRADE_PAYDAY_BPS = 3_333; // 10 of 30
    // house takes the rest of a trade: 10 of 30 = 3_334 bps, computed as the remainder.
    // A trade of the house coin itself sends all 30 to the Vault instead (see HoodBag).
    uint16 internal constant GRAD_DEV_BPS = 2_300; // to the graduating launch's creator
    // the burn clock takes the rest of a graduation fee: 7_700
    uint16 internal constant HOUSE_COIN_VAULT_BPS = 5_000; // the house takes the rest
    uint16 internal constant PAYDAY_LAUNCH_SLICE_BPS = 1_000; // of an hour's pot, to the last ten launches
}
