// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Script, console} from "forge-std/Script.sol";

import {HoodBlockZero} from "../src/HoodBlockZero.sol";

/// @notice Deploys the team launch periphery next to the live factory on Robinhood Chain 4663.
/// @dev No owner and nothing to wire: the periphery calls the factory like any creator would, so
///      the factory needs no change and no owner transaction. The deploying key is spent on the
///      one deployment and holds no power afterwards.
///
///      forge script script/DeployBlockZero.s.sol --rpc-url robinhood --broadcast
contract DeployBlockZero is Script {
    function run() external {
        uint256 pk = vm.envUint("PRIVATE_KEY");
        address factory = vm.envAddress("HOOD_FACTORY");

        vm.startBroadcast(pk);
        HoodBlockZero zero = new HoodBlockZero(factory);
        vm.stopBroadcast();

        console.log("blockZero  ", address(zero));
        console.log("factory    ", factory);
        console.log("start block", block.number);
    }
}
