// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";

import {IHoodReferrals} from "./interfaces/IHoodReferrals.sol";

/// @title HoodReferrals
/// @notice A curated, per-launch referral leg carved out of the protocol's own share. One registry
///         for both machines: a curve pays it from `HoodCurve.claimProtocol`, a direct launch from
///         `HoodRevenueSplitter.claimProtocol`, and the treasury takes what is left.
/// @dev Set by hand by the owner, which is the Safe. Nothing here reaches a creator's leg or a
///      holder's dividends: a referral can only take from what would otherwise go to the treasury,
///      and never more than half of it. Both machines read this registry through the factory and
///      the portal respectively, and treat a failing read as "no referral", so a broken or missing
///      registry can never hold a protocol claim hostage. A referrer that rejects the transfer
///      does block that one launch's claim; the owner clears the referral to unblock it.
contract HoodReferrals is IHoodReferrals, Ownable2Step {
    uint256 internal constant BPS = 10_000;
    /// @notice The most a referral may take of the protocol's share: half.
    uint16 public constant MAX_BPS = 5_000;

    struct Referral {
        address to;
        uint16 bps;
    }

    mapping(address token => Referral) public referralOf;

    event ReferralSet(address indexed token, address indexed to, uint16 bps);

    error BpsTooHigh();
    error ZeroAddress();

    constructor(address owner_) Ownable(owner_) {}

    /// @notice Names who is paid for `token` and how much of the protocol's share they take.
    ///         `(address(0), 0)` clears it, which is also how a claim blocked by a referrer that
    ///         cannot take the transfer is unblocked.
    function setReferral(address token, address to, uint16 bps) external onlyOwner {
        if (bps > MAX_BPS) revert BpsTooHigh();
        if (bps != 0 && to == address(0)) revert ZeroAddress();
        referralOf[token] = Referral({to: to, bps: bps});
        emit ReferralSet(token, to, bps);
    }

    /// @inheritdoc IHoodReferrals
    function split(address token, uint256 amount) external view returns (address to, uint256 cut) {
        Referral memory r = referralOf[token];
        return (r.to, Math.mulDiv(amount, r.bps, BPS));
    }
}
