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
        // Tokens that held a ticker the issuer's own share has since claimed. Two assets in the
        // menu under one ticker is how somebody launches against the joke believing it is the
        // company, so the loser is switched off. Nothing it already launched is touched.
        address[] memory withdraw = vm.parseJsonAddressArray(plan, ".withdraw");
        require(
            assets.length == thresholds.length && assets.length == startCaps.length
                && assets.length == graduationCaps.length && assets.length == curvePresets.length,
            "the plan's columns are different lengths"
        );

        // Which of the plan's assets already has its preset, worked out in one pass over what the
        // factory carries. Asking the factory again inside the loop is the same read repeated tens
        // of thousands of times over a remote node; holding the presets in memory and copying a
        // struct per comparison is worse, because a copy is an allocation and two hundred assets
        // against two hundred presets is twenty megabytes of them.
        bool[] memory presetExists = new bool[](assets.length);
        uint256 existingCount = factory.configCount();
        for (uint256 i; i < existingCount; i++) {
            CurveConfig memory c = factory.getConfig(i);
            if (!c.enabled) continue;
            for (uint256 j; j < assets.length; j++) {
                if (c.pairToken == assets[j] && c.startCap == startCaps[j] && c.graduationCap == graduationCaps[j]) {
                    presetExists[j] = true;
                    break;
                }
            }
        }

        vm.startBroadcast(pk);
        uint256 pairs;
        uint256 presets;
        uint256 quotes;
        for (uint256 i; i < assets.length; i++) {
            if (!factory.pairAllowed(assets[i])) {
                factory.setPair(assets[i], true, thresholds[i]);
                pairs++;
            }
            // Each asset appears once in a plan, so a preset added here cannot collide with a
            // later row: the flag above is the whole answer.
            if (curvePresets[i] && !presetExists[i]) {
                CurveConfig memory config = CurveConfig({
                    pairToken: assets[i],
                    totalSupply: 1_000_000_000e18,
                    curveSupplyBps: 8000,
                    startCap: startCaps[i],
                    graduationCap: graduationCaps[i],
                    liquidityBps: 9000,
                    protocolFeeBps: 70,
                    creatorFeeBps: 30,
                    poolFee: 3000,
                    tickSpacing: 60,
                    enabled: true
                });
                factory.addConfig(config);
                presets++;
            }
            if (!portal.quoteAllowed(assets[i])) {
                portal.setQuote(assets[i], true);
                quotes++;
            }
        }
        uint256 withdrawn;
        for (uint256 i; i < withdraw.length; i++) {
            if (factory.pairAllowed(withdraw[i])) {
                factory.setPair(withdraw[i], false, 0);
                withdrawn++;
            }
            if (portal.quoteAllowed(withdraw[i])) portal.setQuote(withdraw[i], false);
        }
        vm.stopBroadcast();

        console.log("pairs withdrawn", withdrawn);
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

}
