// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test, console} from "forge-std/Test.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {CurveMath} from "../src/libraries/CurveMath.sol";

/// The numbers the browser's simulator claims, asked of the library that will actually run.
///
/// `packages/sdk/src/sim.ts` ports `CurveMath` so the launch wizard can show a buyer what a buy
/// returns before anything is deployed. A port drifts silently: the rounding is where it drifts
/// first, and a wizard that is one wei off is a wizard that will one day be wrong about which side
/// of a slippage check a trade lands on. `scripts/checks/curve-port.mjs` runs this and compares.
contract CurvePortTest is Test {
    function test_emitPortVectors() public pure {
        // Shapes a creator would actually pick: a three ETH open bonding at thirty, a stablecoin
        // pair in six decimals, a late buy into a nearly sold curve, and a buy of one wei.
        uint256[4] memory p0s = [uint256(3e9), 2_500_000, 1e9, 3e9];
        uint256[4] memory p1s = [uint256(3e10), 90_000_000, 3e10, 3e10];
        uint256[4] memory supplies = [uint256(800_000_000e18), 1_000_000e18, 600_000_000e18, 800_000_000e18];
        uint256[4] memory solds = [uint256(0), 250_000e18, 599_000_000e18, 123_456_789e18];
        uint256[4] memory budgets = [uint256(0.1e18), 7_500_000, 0.004e18, 1];

        // The fee the curve charges, in the same four shapes: none, the usual one, and a fat one.
        uint256[4] memory feeBps = [uint256(0), 100, 250, 100];

        for (uint256 i = 0; i < 4; i++) {
            uint256 supply = supplies[i];
            uint256 sold = solds[i];
            // HoodCurve.quoteBuy, step for step, so the port is checked as the wizard calls it.
            uint256 bps = feeBps[i];
            uint256 gross = bps == 0 ? 0 : Math.mulDiv(budgets[i], bps, 10_000, Math.Rounding.Ceil);
            uint256 budget = budgets[i] - gross;
            uint256 out = CurveMath.tokensForPair(p0s[i], p1s[i], supply, sold, budget, supply - sold);
            uint256 net = CurveMath.cost(p0s[i], p1s[i], supply, sold, out, true);
            uint256 fee = bps == 0 ? 0 : Math.mulDiv(net, bps, 10_000 - bps, Math.Rounding.Ceil);
            console.log("vector", i);
            console.log("  price", CurveMath.priceAt(p0s[i], p1s[i], supply, sold));
            console.log("  out", out);
            console.log("  net", net);
            console.log("  fee", fee);
            console.log("  after", CurveMath.priceAt(p0s[i], p1s[i], supply, sold + out));
            console.log("  raise", CurveMath.cost(p0s[i], p1s[i], supply, 0, supply, false));
        }
    }
}
