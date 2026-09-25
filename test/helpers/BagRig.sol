// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";

import {HoodBag} from "../../src/bag/HoodBag.sol";
import {HoodPayday} from "../../src/bag/HoodPayday.sol";
import {HoodBurnClock} from "../../src/bag/HoodBurnClock.sol";
import {HoodGraduationHook} from "../../src/graduation/HoodGraduationHook.sol";

/// @notice The v3 money router the way a deployment stands it up, for the fork suites: the real
///         Bag with its two clocks, and the graduation hook at an address whose low fourteen bits
///         say beforeSwap, afterSwap and both return deltas (0xCC). The deploy script mines a salt
///         for that; a test etches the code there instead.
abstract contract BagRig is Test {
    /// @dev A vanity address nobody uses, ending in the hook's permission bits.
    address internal constant GRADUATION_HOOK = address(uint160(0x9AD000CC));

    /// @dev Payday and the burn clock first, then the Bag that pays them. `house` is the treasury,
    ///      `vault` the staking contract, `poolManager` what the burn clock will buy the coin from.
    function _bagStack(address factory, address house, address vault, address poolManager)
        internal
        returns (HoodBag bag, HoodPayday payday, HoodBurnClock burnClock)
    {
        payday = new HoodPayday(factory);
        burnClock = new HoodBurnClock(factory, poolManager);
        bag = new HoodBag(house, vault, address(payday), address(burnClock));
    }

    /// @dev The one hook every graduated pool runs. The caller still has to name it on the
    ///      graduator (`setHook`, factory owner only) before any curve launches: `prepare` refuses
    ///      to open a pool without it.
    function _graduationHook(address poolManager, address factory, address bag, address feeRouter, address vault)
        internal
        returns (HoodGraduationHook hook)
    {
        deployCodeTo(
            "HoodGraduationHook.sol:HoodGraduationHook",
            abi.encode(poolManager, factory, bag, feeRouter, vault),
            GRADUATION_HOOK
        );
        hook = HoodGraduationHook(payable(GRADUATION_HOOK));
    }
}
