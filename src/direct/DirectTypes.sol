// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;


/// @notice The five places a token's socials live, in the order the explorers expect them.
struct Socials {
    string twitter;
    string telegram;
    string discord;
    string website;
    string farcaster;
}

/// @notice How the creator's share of the tax is split. The four must add up to 10,000.
/// @dev Fixed at launch, like everything else here. A buyer reads these before they buy and they
///      are the same ones an hour later.
struct Allocations {
    uint16 creatorBps; // claimable by the creator whenever they want
    uint16 buybackBps; // buys the token back and burns it
    uint16 dividendsBps; // paid to holders, pull based
    uint16 liquidityBps; // added to the locked position
}

/// @notice Everything a direct launch fixes at launch time.
/// @dev New fields go at the end and existing ones never move: the web encodes `createLaunch`
///      from this order.
struct DirectConfig {
    uint16 buyTaxBps; // 100 to 1000, one hundredth to a tenth of the trade
    uint16 sellTaxBps; // 100 to 1000
    int24 tickStart; // the opening price
    int24 tickBond; // the price where the launch counts as bonded
    Allocations allocations;
    // Wallets (by tx.origin) that pay no opening tax (SnipeSchedule), on top of the launcher and
    // the creator fee recipient. At most SnipeSchedule.MAX_EXEMPT.
    address[] exempt;
}

/// @notice The registry row for a direct launch.
struct DirectLaunch {
    address token;
    address quote;
    address hook;
    address splitter;
    address locker;
    address creator;
    uint256 positionId;
    uint64 launchedAt;
    bool exists;
}
