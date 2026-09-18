// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Script, console} from "forge-std/Script.sol";

import {HoodSeasonDrop} from "../src/HoodSeasonDrop.sol";

/// @notice Deploys the season drop on Robinhood Chain 4663.
/// @dev Nothing to wire and nothing to seed: OWNER is the owner from the first block, so there is
///      no window where the deploying key can open a season. Each season is funded later, by the
///      owner, in the call that publishes its root.
///
///      forge script script/DeploySeasonDrop.s.sol --rpc-url robinhood --broadcast
contract DeploySeasonDrop is Script {
    function run() external {
        uint256 pk = vm.envUint("PRIVATE_KEY");
        address owner = vm.envAddress("OWNER");
        address treasury = vm.envAddress("TREASURY");

        vm.startBroadcast(pk);
        HoodSeasonDrop seasonDrop = new HoodSeasonDrop(owner, treasury);
        vm.stopBroadcast();

        console.log("seasonDrop", address(seasonDrop));
        console.log("owner     ", owner);
        console.log("treasury  ", treasury);
        console.log("start block", block.number);
    }
}
