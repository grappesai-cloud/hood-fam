// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Script, console} from "forge-std/Script.sol";

import {ILayerZeroEndpointV2} from "@layerzerolabs/lz-evm-protocol-v2/contracts/interfaces/ILayerZeroEndpointV2.sol";
import {UlnConfig} from "@layerzerolabs/lz-evm-messagelib-v2/contracts/uln/UlnBase.sol";

import {HoodBridgeFactory} from "../src/omnichain/HoodBridgeFactory.sol";
import {HoodOFTAdapter} from "../src/omnichain/HoodOFTAdapter.sol";
import {RemoteWiring, IUlnConfigView, IExecutorConfigView} from "./DeployRemote.s.sol";

/// @notice The 4663 half of opening a route: points a token's lock box at the remote that
///         `script/DeployRemote.s.sol` just printed on the far chain.
/// @dev Run this on 4663, after DeployRemote, with the bridge owner's key. Until both halves are
///      done the token can leave but not arrive, or arrive but not leave.
///
///      Where this differs from `OpenRoute.s.sol`: that one is the first-time opening and writes
///      unconditionally. This one reads first and writes only what is missing, so it can be run
///      again after a half-finished attempt, and again after that, without changing anything.
///
///      TOKEN=0x.. DST_EID=30184 REMOTE=0x.. HOOD_BRIDGE_FACTORY=0x.. \
///        forge script script/WireRemote.s.sol --rpc-url robinhood --broadcast
contract WireRemote is Script {
    /// LayerZero V2 on 4663, the addresses `packages/sdk/src/chains.ts` carries.
    address internal constant DVN_LAYERZERO = 0xd01ae6905d48315f7bE10C7330aeCF8360Ef5b12;
    address internal constant LZ_EXECUTOR = 0x4208D6E27538189bB48E603D6123A94b8Abe0A0b;

    function run() external {
        uint256 pk = vm.envUint("PRIVATE_KEY");
        address wirer = vm.addr(pk);

        HoodBridgeFactory bridge = HoodBridgeFactory(vm.envAddress("HOOD_BRIDGE_FACTORY"));
        address token = vm.envAddress("TOKEN");
        uint32 dstEid = uint32(vm.envUint("DST_EID"));
        address remote = vm.envAddress("REMOTE");
        bytes32 peer = bytes32(uint256(uint160(remote)));

        address[] memory dvns = _dvns();
        /// Has to be the number the far side used. `configureRoute` writes one config for both
        /// directions, so an asymmetric route is not expressible here anyway, and a mismatch is the
        /// failure that looks like nothing: the packet is sent, paid for, and never verified.
        uint64 confirmations = uint64(vm.envOr("CONFIRMATIONS", uint256(15)));
        uint32 maxMessageSize = uint32(vm.envOr("MAX_MESSAGE_SIZE", uint256(10_000)));
        address executor = vm.envOr("EXECUTOR", LZ_EXECUTOR);

        require(bridge.owner() == wirer, "not the bridge owner: setPeer and configureRoute are onlyOwner");
        require(
            ILayerZeroEndpointV2(bridge.lzEndpoint()).isSupportedEid(dstEid),
            "the 4663 endpoint does not know this eid"
        );

        vm.startBroadcast(pk);

        address adapter = bridge.adapterOf(token);
        if (adapter == address(0)) {
            adapter = bridge.deployAdapter(token);
            console.log("deployed adapter", adapter);
        } else {
            console.log("adapter already deployed", adapter);
        }

        if (HoodOFTAdapter(adapter).peers(dstEid) == peer) {
            console.log("peer already set, skipped");
        } else {
            bridge.setPeer(token, dstEid, peer);
            console.log("peer set to", remote);
        }

        if (routeIsConfigured(bridge, adapter, dstEid, dvns, confirmations, maxMessageSize, executor)) {
            console.log("route already configured, skipped");
        } else {
            bridge.configureRoute(token, dstEid, RemoteWiring.sorted(dvns), confirmations, maxMessageSize, executor);
            console.log("route configured");
        }

        vm.stopBroadcast();

        console.log("token  ", token);
        console.log("adapter", adapter);
        console.log("dstEid ", dstEid);
        console.log("remote ", remote);
    }

    /// @dev Reads the adapter's OWN config off both message libraries, not the endpoint's merged
    ///      view: the merge folds the chain defaults in, and on 4663 the default for every
    ///      destination names a DVN stub whose `getFee` reverts with
    ///      "Please set your OApp's DVNs and/or Executor". A merged read would look configured and
    ///      still not be able to send.
    function routeIsConfigured(
        HoodBridgeFactory bridge,
        address adapter,
        uint32 dstEid,
        address[] memory dvns,
        uint64 confirmations,
        uint32 maxMessageSize,
        address executor
    ) public view returns (bool) {
        ILayerZeroEndpointV2 endpoint = ILayerZeroEndpointV2(bridge.lzEndpoint());
        address sendLib = endpoint.defaultSendLibrary(dstEid);
        address receiveLib = endpoint.defaultReceiveLibrary(dstEid);

        bytes32 want = keccak256(
            abi.encode(
                UlnConfig({
                    confirmations: confirmations,
                    requiredDVNCount: uint8(dvns.length),
                    optionalDVNCount: 0,
                    optionalDVNThreshold: 0,
                    requiredDVNs: RemoteWiring.sorted(dvns),
                    optionalDVNs: new address[](0)
                })
            )
        );

        if (keccak256(abi.encode(IUlnConfigView(sendLib).getAppUlnConfig(adapter, dstEid))) != want) return false;
        if (keccak256(abi.encode(IUlnConfigView(receiveLib).getAppUlnConfig(adapter, dstEid))) != want) return false;

        (uint32 haveSize, address haveExecutor) = IExecutorConfigView(sendLib).executorConfigs(adapter, dstEid);
        return haveSize == maxMessageSize && haveExecutor == executor;
    }

    /// @dev DVNS overrides; otherwise the LayerZero Labs DVN on 4663, the one measured to price
    ///      every destination we advertise.
    function _dvns() internal view returns (address[] memory) {
        address[] memory fallbackDVNs = new address[](1);
        fallbackDVNs[0] = DVN_LAYERZERO;
        return vm.envOr("DVNS", ",", fallbackDVNs);
    }
}
