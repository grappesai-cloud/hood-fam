// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Script, console} from "forge-std/Script.sol";
import {HoodBridgeFactory} from "../src/omnichain/HoodBridgeFactory.sol";

/// @notice Opens one omnichain route for one token: names the peer on the far side, then says who
///         verifies the message and who delivers it.
/// @dev The second half is not optional on 4663. The endpoint's default config there carries no
///      DVNs, so an OApp that only sets a peer cannot send: the quote reverts with
///      "Please set your OApp's DVNs and/or Executor". Measured on a fork.
///
///      TOKEN=0x.. EID=30184 PEER=0x.. forge script script/OpenRoute.s.sol --rpc-url robinhood --broadcast
contract OpenRoute is Script {
    address internal constant DVN_LAYERZERO = 0xd01ae6905d48315f7bE10C7330aeCF8360Ef5b12;
    address internal constant DVN_NETHERMIND = 0x0Ffe02DF012299A370D5dd69298A5826EAcaFdF8;
    address internal constant LZ_EXECUTOR = 0x4208D6E27538189bB48E603D6123A94b8Abe0A0b;

    function run() external {
        uint256 pk = vm.envUint("PRIVATE_KEY");
        HoodBridgeFactory bridge = HoodBridgeFactory(vm.envAddress("HOOD_BRIDGE_FACTORY"));
        address token = vm.envAddress("TOKEN");
        uint32 eid = uint32(vm.envUint("EID"));
        bytes32 peer = bytes32(uint256(uint160(vm.envAddress("PEER"))));
        bool twoDvns = vm.envOr("TWO_DVNS", false);

        address[] memory dvns;
        if (twoDvns) {
            // Sorted ascending, no duplicates: the message library checks both.
            dvns = new address[](2);
            (dvns[0], dvns[1]) = DVN_NETHERMIND < DVN_LAYERZERO
                ? (DVN_NETHERMIND, DVN_LAYERZERO)
                : (DVN_LAYERZERO, DVN_NETHERMIND);
        } else {
            dvns = new address[](1);
            dvns[0] = DVN_LAYERZERO;
        }

        vm.startBroadcast(pk);
        if (bridge.adapterOf(token) == address(0)) bridge.deployAdapter(token);
        bridge.setPeer(token, eid, peer);
        bridge.configureRoute(token, eid, dvns, uint64(vm.envOr("CONFIRMATIONS", uint256(15))), 10_000, LZ_EXECUTOR);
        vm.stopBroadcast();

        console.log("route open for", token);
        console.log("adapter", bridge.adapterOf(token));
    }
}
