// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Script, console} from "forge-std/Script.sol";

import {HoodPortal} from "../src/direct/HoodPortal.sol";

/// @notice Lets the direct machine be quoted in the same assets the curve machine takes.
/// @dev The portal always could: it pulls an ERC-20 quote, sorts the pool by address and taxes
///      whichever side the quote landed on, and `test_fork_a_dollar_quoted_launch_runs_the_erc20_branch_end_to_end`
///      has proved the whole branch on a fork of 4663 since the machine was written. What was
///      missing was permission, which is this, and an app that could work out which side of the
///      pool the token would sort into, which is `predictDirectToken` in the SDK.
///
///      forge script script/AllowDirectQuotes.s.sol --rpc-url robinhood --broadcast
contract AllowDirectQuotes is Script {
    function run() external {
        uint256 pk = vm.envUint("PRIVATE_KEY");
        HoodPortal portal = HoodPortal(payable(vm.envAddress("HOOD_PORTAL")));

        address[8] memory quotes = [
            0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168, // USDG
            0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC, // NVDA
            0x1b0E319c6A659F002271B69dB8A7df2F911c153E, // GME
            0x117cc2133c37B721F49dE2A7a74833232B3B4C0C, // SPY
            0x4a0E65A3EcceC6dBe60AE065F2e7bb85Fae35eEa, // SPCX
            0xaF3D76f1834A1d425780943C99Ea8A608f8a93f9, // AAPL
            0xc0D6457C16Cc70d6790Dd43521C899C87ce02f35, // META
            0x2e0847E8910a9732eB3fb1bb4b70a580ADAD4FE3 // GOOGL
        ];

        vm.startBroadcast(pk);
        for (uint256 i; i < quotes.length; i++) {
            if (portal.quoteAllowed(quotes[i])) {
                console.log("already a quote:", quotes[i]);
                continue;
            }
            portal.setQuote(quotes[i], true);
            console.log("quote allowed:", quotes[i]);
        }
        // INTC has its own line because its address checksums oddly in a fixed size array above.
        address intc = 0xc72b96e0E48ecd4DC75E1e45396e26300BC39681;
        if (!portal.quoteAllowed(intc)) portal.setQuote(intc, true);
        vm.stopBroadcast();
    }
}
