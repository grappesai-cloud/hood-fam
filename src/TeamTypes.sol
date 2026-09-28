// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @notice One team wallet's buy inside a launch transaction, on either machine.
struct TeamBuy {
    address wallet; // who receives the tokens, or who the lock is written to
    uint256 pairIn; // pair units spent on this leg, fees included
    uint256 minTokensOut; // per-leg floor; the price inside the launch transaction is known in advance
    uint64 lock; // seconds in the token lock (one of its tiers); 0 = straight to the wallet
    uint256 gas; // native currency sent to the wallet with its tokens, for the transactions it makes later
}

/// @notice The two events both machines emit for a team launch, so one indexer handler reads both.
interface ITeamEvents {
    event TeamLaunched(
        address indexed token, address indexed market, address indexed launcher, uint256 legs, uint256 pairSpent, uint256 tokens
    );
    event TeamLeg(
        address indexed token,
        address indexed wallet,
        uint256 index,
        uint256 pairSpent,
        uint256 tokens,
        uint256 lockId,
        uint64 unlockAt
    );
    event TeamGas(address indexed token, address indexed wallet, uint256 amount);
}
