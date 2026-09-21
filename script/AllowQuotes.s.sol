// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Script, console} from "forge-std/Script.sol";

import {HoodFactory} from "../src/HoodFactory.sol";
import {HoodPortal} from "../src/direct/HoodPortal.sol";
import {CurveConfig} from "../src/HoodTypes.sol";

/// @notice Opens both machines to every asset a plan lists.
/// @dev The plan is `deploy/quotes.plan.json`, written by `scripts/quotes/plan.mjs` from what
///      `scripts/quotes/discover.mjs` read off the chain: assets that trade against the dollar,
///      with a price, their own preset sized to the same dollars as every other preset, and a
///      ticker lock threshold in their own units.
///
///      Nothing here decides anything. It applies a file a person can read line by line, and it is
///      idempotent: an asset already allowed is skipped, a preset already there is skipped, so the
///      same plan can be re-run after a partial failure or a deployment.
///
///      forge script script/AllowQuotes.s.sol --rpc-url robinhood --broadcast
contract AllowQuotes is Script {
    function run() external {
        uint256 pk = vm.envUint("PRIVATE_KEY");
        HoodFactory factory = HoodFactory(payable(vm.envAddress("HOOD_FACTORY")));
        HoodPortal portal = HoodPortal(payable(vm.envAddress("HOOD_PORTAL")));

        string memory plan = vm.readFile("deploy/quotes.plan.json");
        address[] memory assets = vm.parseJsonAddressArray(plan, ".assets");
        uint256[] memory thresholds = _uints(plan, ".lockThresholds");
        uint256[] memory startCaps = _uints(plan, ".startCaps");
        uint256[] memory graduationCaps = _uints(plan, ".graduationCaps");
        // Not every quote the pad takes can carry a curve: see the note in scripts/quotes/plan.mjs.
        bool[] memory curvePresets = vm.parseJsonBoolArray(plan, ".curvePresets");
        require(
            assets.length == thresholds.length && assets.length == startCaps.length
                && assets.length == graduationCaps.length && assets.length == curvePresets.length,
            "the plan's columns are different lengths"
        );

        vm.startBroadcast(pk);
        uint256 pairs;
        uint256 presets;
        uint256 quotes;
        for (uint256 i; i < assets.length; i++) {
            if (!factory.pairAllowed(assets[i])) {
                factory.setPair(assets[i], true, thresholds[i]);
                pairs++;
            }
            if (curvePresets[i] && !_hasPreset(factory, assets[i], startCaps[i], graduationCaps[i])) {
                factory.addConfig(
                    CurveConfig({
                        pairToken: assets[i],
                        totalSupply: 1_000_000_000e18,
                        curveSupplyBps: 8000,
                        startCap: startCaps[i],
                        graduationCap: graduationCaps[i],
                        liquidityBps: 9000,
                        protocolFeeBps: 30,
                        creatorFeeBps: 70,
                        poolFee: 3000,
                        tickSpacing: 60,
                        enabled: true
                    })
                );
                presets++;
            }
            if (!portal.quoteAllowed(assets[i])) {
                portal.setQuote(assets[i], true);
                quotes++;
            }
        }
        vm.stopBroadcast();

        console.log("assets in the plan", assets.length);
        console.log("pairs allowed", pairs);
        console.log("presets added", presets);
        console.log("direct quotes allowed", quotes);
    }

    /// @dev The strings in the plan are decimal, because a uint256 does not survive JSON as a
    ///      number. `vm.parseJsonUintArray` reads hex or decimal strings, which is why they are
    ///      written as strings rather than as numbers.
    function _uints(string memory plan, string memory key) internal pure returns (uint256[] memory) {
        return vm.parseJsonUintArray(plan, key);
    }

    function _hasPreset(HoodFactory factory, address pairToken, uint256 startCap, uint256 graduationCap)
        internal
        view
        returns (bool)
    {
        uint256 count = factory.configCount();
        for (uint256 i; i < count; i++) {
            CurveConfig memory c = factory.getConfig(i);
            if (c.enabled && c.pairToken == pairToken && c.startCap == startCap && c.graduationCap == graduationCap) {
                return true;
            }
        }
        return false;
    }
}
