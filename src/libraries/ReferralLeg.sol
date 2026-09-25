// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IHoodReferrals} from "../interfaces/IHoodReferrals.sol";

/// @dev The one view a pointer (the factory for curves, the portal for direct launches) answers.
interface IReferralsPointer {
    function referrals() external view returns (address);
}

/// @title ReferralLeg
/// @notice The referral cut of a platform fee, read the way both machines read it: a pointer names
///         the registry, the registry names who is paid for a token and how much of `amount` they
///         take. Used by the direct hook as the Bag's share is routed and by the splitter on a
///         legacy protocol claim.
/// @dev Every failure on the way means "no referral": a pointer that cannot answer, no registry,
///      nothing deployed there, a registry that reverts, answers short, names nobody or asks for
///      more than the amount. Both reads are raw static calls with their return data measured, so
///      nothing an owner points a pointer at can revert the caller from inside a swap.
library ReferralLeg {
    function cut(address pointer, address token, uint256 amount) internal view returns (address referrer, uint256 amountCut) {
        (bool ok, bytes memory ret) = pointer.staticcall(abi.encodeCall(IReferralsPointer.referrals, ()));
        if (!ok || ret.length < 32) return (address(0), 0);
        address registry = abi.decode(ret, (address));
        if (registry == address(0)) return (address(0), 0);
        (ok, ret) = registry.staticcall(abi.encodeCall(IHoodReferrals.split, (token, amount)));
        if (!ok || ret.length < 64) return (address(0), 0);
        (referrer, amountCut) = abi.decode(ret, (address, uint256));
        if (referrer == address(0) || amountCut > amount) return (address(0), 0);
    }
}
