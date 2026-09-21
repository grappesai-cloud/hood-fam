// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Script, console} from "forge-std/Script.sol";

import {HoodFactory} from "../src/HoodFactory.sol";
import {CurveConfig} from "../src/HoodTypes.sol";

/// @notice Lets a launch trade against a tokenised share, and pay its creator in one.
/// @dev This chain's reason to exist is that a share of NVIDIA is an ERC-20. Our curve never cared
///      what it takes payment in, so the only thing standing between a creator and being paid in
///      NVDA was the allow list and a preset denominated in it.
///
///      Every address below was read off the chain, not off a list: the symbol and decimals come
///      from the token, the price from the Uniswap v3 pool it trades against the dollar in, and a
///      transfer to a contract was simulated first, because a share that refuses to move to a
///      contract could never sit in a curve. `scripts/checks/pair-prices.mjs` re-reads all of it.
///
///      The presets are the standard shape (a billion tokens, four fifths on the curve) priced to
///      the same dollars as the ETH one: about 2,700 dollars at the open, about 27,000 at
///      graduation, at the prices on the day this was written. A preset is never edited, so a
///      share that doubles simply makes its preset twice as big; that is what adding another one
///      is for.
///
///      forge script script/AddStockPairs.s.sol --rpc-url robinhood --broadcast
contract AddStockPairs is Script {
    address internal constant NVDA = 0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC;
    address internal constant GME = 0x1b0E319c6A659F002271B69dB8A7df2F911c153E;
    address internal constant SPY = 0x117cc2133c37B721F49dE2A7a74833232B3B4C0C;

    function run() external {
        uint256 pk = vm.envUint("PRIVATE_KEY");
        HoodFactory factory = HoodFactory(payable(vm.envAddress("HOOD_FACTORY")));

        vm.startBroadcast(pk);

        // A ticker locks after roughly seventy thousand dollars of volume in a day, the same bar
        // the other pairs carry, expressed in each share.
        _pair(factory, NVDA, 300e18, "NVDA");
        _pair(factory, GME, 3_000e18, "GME");
        _pair(factory, SPY, 90e18, "SPY");

        _preset(factory, "NVDA", 12e18, 120e18);
        _preset(factory, "GME", 120e18, 1_200e18);
        _preset(factory, "SPY", 3.5e18, 35e18);

        vm.stopBroadcast();

        console.log("pairs and presets added; configCount is now", factory.configCount());
    }

    function _pair(HoodFactory factory, address token, uint256 threshold, string memory name) internal {
        if (factory.pairAllowed(token)) {
            console.log("already allowed:", name);
            return;
        }
        factory.setPair(token, true, threshold);
        console.log("allowed:", name);
    }

    function _preset(HoodFactory factory, string memory name, uint256 startCap, uint256 graduationCap) internal {
        uint256 id = factory.addConfig(
            CurveConfig({
                totalSupply: 1_000_000_000e18,
                curveSupplyBps: 8000,
                startCap: startCap,
                graduationCap: graduationCap,
                liquidityBps: 9000,
                protocolFeeBps: 30,
                creatorFeeBps: 70,
                poolFee: 3000,
                tickSpacing: 60,
                enabled: true
            })
        );
        console.log("preset", id, "for", name);
    }
}
