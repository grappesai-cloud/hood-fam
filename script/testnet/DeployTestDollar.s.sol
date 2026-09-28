// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Script, console} from "forge-std/Script.sol";

import {MockQuote} from "../../test/mocks/Mocks.sol";

/// @notice The testnet's dollar: six decimals like USDG, and anyone can mint it. Deploy.s.sol
///         takes its address as TESTNET_USDG on 46630, where there is no USDG we can mint.
///
///         MINT_TO=0xA,0xB MINT_EACH=100000000000 forge script script/testnet/DeployTestDollar.s.sol \
///           --rpc-url robinhood_testnet --broadcast
contract DeployTestDollar is Script {
    function run() external returns (address dollar) {
        require(block.chainid == 46630, "the test dollar is for the testnet only");
        uint256 pk = vm.envUint("PRIVATE_KEY");
        address[] memory to = vm.envOr("MINT_TO", ",", new address[](0));
        uint256 each = vm.envOr("MINT_EACH", uint256(0));

        vm.startBroadcast(pk);
        MockQuote token = new MockQuote("tUSDG", 6);
        for (uint256 i; i < to.length; ++i) {
            token.mint(to[i], each);
        }
        vm.stopBroadcast();

        dollar = address(token);
        console.log("TESTNET_USDG=%s", dollar);
    }
}
