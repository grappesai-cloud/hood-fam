// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Script, console} from "forge-std/Script.sol";

import {ILayerZeroEndpointV2} from "@layerzerolabs/lz-evm-protocol-v2/contracts/interfaces/ILayerZeroEndpointV2.sol";
import {SetConfigParam} from "@layerzerolabs/lz-evm-protocol-v2/contracts/interfaces/IMessageLibManager.sol";
import {UlnConfig} from "@layerzerolabs/lz-evm-messagelib-v2/contracts/uln/UlnBase.sol";
import {ExecutorConfig} from "@layerzerolabs/lz-evm-messagelib-v2/contracts/SendLibBase.sol";
import {EnforcedOptionParam} from "@layerzerolabs/oapp-evm/contracts/oapp/interfaces/IOAppOptionsType3.sol";
import {OptionsBuilder} from "@layerzerolabs/oapp-evm/contracts/oapp/libs/OptionsBuilder.sol";

import {HoodOFTRemote} from "../src/omnichain/HoodOFTRemote.sol";

/// @notice What a message library says about ONE OApp's own config, as opposed to the merged view
///         the endpoint hands back.
/// @dev We compare against this and not against the endpoint's `getConfig`. The endpoint merges the
///      chain defaults in, so a token that has set nothing reads back as if it were configured, and
///      a script that trusted that would skip the write and leave the route riding on defaults that
///      move without asking us.
interface IUlnConfigView {
    function getAppUlnConfig(address oapp, uint32 remoteEid) external view returns (UlnConfig memory);
}

interface IExecutorConfigView {
    function executorConfigs(address oapp, uint32 eid) external view returns (uint32 maxMessageSize, address executor);
}

/// @title RemoteWiring
/// @notice Everything a `HoodOFTRemote` needs on a destination chain, in one place, so the deploy
///         script and the fork test run the same code instead of two copies that drift apart.
/// @dev Every step reads before it writes. Opening a route is done by hand, under pressure, often
///      twice because the first run ran out of gas halfway, and a step that cannot be repeated is a
///      step that will be wrong.
library RemoteWiring {
    using OptionsBuilder for bytes;

    /// Robinhood Chain, home of every hood.fam token. The adapter and the canonical supply live here.
    uint32 internal constant HOME_EID = 30416;
    /// LayerZero V2. This IS the canonical address on every chain the token travels to; 4663 is the
    /// one place it is not, which is why the endpoint is a parameter and not a constant here.
    address internal constant CANONICAL_ENDPOINT = 0x1a44076050125825900e736c501f859c50fE728c;
    /// OFTCore's message type for a plain send, the one a token transfer uses.
    uint16 internal constant MSG_TYPE_SEND = 1;

    /// @notice The LayerZero Labs DVN on each chain hood.fam travels to.
    /// @dev Not a preference, a requirement. The DVN the endpoint carries as its DEFAULT for eid
    ///      30416 is a stub on every one of these chains: `getFee(30416, ...)` on it reverts with
    ///      "Please set your OApp's DVNs and/or Executor". The addresses below answer with a price.
    ///      Measured on forks of each chain, not read off a page. Override with DVNS when LayerZero
    ///      finishes wiring 4663 and the defaults become real.
    function layerZeroDVN(uint256 chainId) internal pure returns (address) {
        if (chainId == 1) return 0x589dEDbD617e0CBcB916A9223F4d1300c294236b; // Ethereum
        if (chainId == 10) return 0x6A02D83e8d433304bba74EF1c427913958187142; // Optimism
        if (chainId == 56) return 0xfD6865c841c2d64565562fCc7e05e619A30615f0; // BNB Chain
        if (chainId == 137) return 0x23DE2FE932d9043291f870324B74F820e11dc81A; // Polygon
        if (chainId == 8453) return 0x9e059a54699a285714207b43B055483E78FAac25; // Base
        if (chainId == 42161) return 0x2f55C492897526677C5B68fb199ea31E2c126416; // Arbitrum
        if (chainId == 534352) return 0xbe0d08a85EeBFCC6eDA0A843521f7CBB1180D2e2; // Scroll
        return address(0);
    }

    // ------------------------------------------------------------------ reads

    /// @notice Whether this endpoint has a route to `eid` at all.
    /// @dev False means LayerZero has not registered the chain here yet. Nothing we can do about it
    ///      from our side, and no amount of config will fix it.
    function routeIsKnown(ILayerZeroEndpointV2 endpoint, uint32 eid) internal view returns (bool) {
        return endpoint.isSupportedEid(eid);
    }

    /// @notice The executor and message size this chain uses for `eid` by default.
    /// @dev Unlike the default DVN, the default executor is real and prices the route, so it is a
    ///      sane fallback. Read from the chain rather than kept in a table that goes stale.
    function defaultExecutor(ILayerZeroEndpointV2 endpoint, uint32 eid)
        internal
        view
        returns (uint32 maxMessageSize, address executor)
    {
        address sendLib = endpoint.defaultSendLibrary(eid);
        (maxMessageSize, executor) = IExecutorConfigView(sendLib).executorConfigs(address(0), eid);
    }

    // ----------------------------------------------------------------- writes

    function deploy(string memory name_, string memory symbol_, address endpoint, address wirer)
        internal
        returns (HoodOFTRemote)
    {
        /// `wirer` is owner AND endpoint delegate: whoever runs the script has to be able to set the
        /// peer and the config before handing the token over to its real owner.
        return new HoodOFTRemote(name_, symbol_, endpoint, wirer);
    }

    /// @return changed false when the peer was already the one we want.
    function setPeerOnce(HoodOFTRemote remote, uint32 eid, bytes32 peer) internal returns (bool changed) {
        if (remote.peers(eid) == peer) return false;
        remote.setPeer(eid, peer);
        return true;
    }

    /// @notice Says who verifies a message on this route and who delivers it.
    /// @dev The DVN list has to name the SAME verifier operator on both ends of the route, at that
    ///      operator's address on each chain. Confirmations have to match too, in both directions:
    ///      a receiving side that asks for more confirmations than the sending side attested with
    ///      never verifies the message, and it fails silently, as a packet that simply never lands.
    /// @param dvns any order; sorted here, because the message library insists on ascending and no
    ///        duplicates and reverts if you get it wrong.
    function configureRouteOnce(
        HoodOFTRemote remote,
        uint32 eid,
        address[] memory dvns,
        uint64 confirmations,
        uint32 maxMessageSize,
        address executor
    ) internal returns (bool changed) {
        ILayerZeroEndpointV2 endpoint = remote.endpoint();
        address sendLib = endpoint.defaultSendLibrary(eid);
        address receiveLib = endpoint.defaultReceiveLibrary(eid);

        UlnConfig memory uln = UlnConfig({
            confirmations: confirmations,
            requiredDVNCount: uint8(dvns.length),
            optionalDVNCount: 0,
            optionalDVNThreshold: 0,
            requiredDVNs: sorted(dvns),
            optionalDVNs: new address[](0)
        });
        bytes32 want = keccak256(abi.encode(uln));

        bool needSendUln =
            keccak256(abi.encode(IUlnConfigView(sendLib).getAppUlnConfig(address(remote), eid))) != want;
        bool needReceiveUln =
            keccak256(abi.encode(IUlnConfigView(receiveLib).getAppUlnConfig(address(remote), eid))) != want;
        (uint32 haveSize, address haveExecutor) =
            IExecutorConfigView(sendLib).executorConfigs(address(remote), eid);
        bool needExecutor = haveSize != maxMessageSize || haveExecutor != executor;

        if (needExecutor || needSendUln) {
            uint256 n = (needExecutor ? 1 : 0) + (needSendUln ? 1 : 0);
            SetConfigParam[] memory params = new SetConfigParam[](n);
            uint256 i;
            if (needExecutor) {
                params[i++] = SetConfigParam({
                    eid: eid,
                    configType: 1,
                    config: abi.encode(ExecutorConfig({maxMessageSize: maxMessageSize, executor: executor}))
                });
            }
            if (needSendUln) params[i] = SetConfigParam({eid: eid, configType: 2, config: abi.encode(uln)});
            endpoint.setConfig(address(remote), sendLib, params);
            changed = true;
        }

        if (needReceiveUln) {
            SetConfigParam[] memory params = new SetConfigParam[](1);
            params[0] = SetConfigParam({eid: eid, configType: 2, config: abi.encode(uln)});
            endpoint.setConfig(address(remote), receiveLib, params);
            changed = true;
        }
    }

    /// @notice Bakes the gas the far side needs into the token itself.
    /// @dev Without this a caller who passes no options pays for zero gas on arrival and the packet
    ///      lands unexecuted. The adapter on 4663 has no equivalent, `HoodBridgeFactory` exposes no
    ///      setter for enforced options, so on the way out of 4663 the caller must pass its own.
    function enforceReceiveGasOnce(HoodOFTRemote remote, uint32 eid, uint128 lzReceiveGas)
        internal
        returns (bool changed)
    {
        bytes memory options = OptionsBuilder.newOptions().addExecutorLzReceiveOption(lzReceiveGas, 0);
        if (keccak256(remote.enforcedOptions(eid, MSG_TYPE_SEND)) == keccak256(options)) return false;

        EnforcedOptionParam[] memory params = new EnforcedOptionParam[](1);
        params[0] = EnforcedOptionParam({eid: eid, msgType: MSG_TYPE_SEND, options: options});
        remote.setEnforcedOptions(params);
        return true;
    }

    /// @notice Hands the token over, delegate first.
    /// @dev The delegate is what may change the endpoint config, and it is NOT carried by
    ///      `transferOwnership`. Move it first: after ownership goes, this address cannot set it any
    ///      more and the new owner is left owning a token whose route it cannot touch.
    /// @return twoStep true when the contract is Ownable2Step and the new owner still has to accept.
    function handOver(HoodOFTRemote remote, address newOwner) internal returns (bool twoStep) {
        if (newOwner == address(0) || remote.owner() == newOwner) return false;
        remote.setDelegate(newOwner);
        remote.transferOwnership(newOwner);
        (bool ok, bytes memory ret) = address(remote).staticcall(abi.encodeWithSignature("pendingOwner()"));
        twoStep = ok && ret.length == 32 && abi.decode(ret, (address)) == newOwner;
    }

    /// @notice Deploy (or adopt) the remote and open its route home, in one idempotent pass.
    /// @param remote address(0) to deploy a fresh one, or an existing one to finish wiring.
    /// @return routeKnown false when this endpoint has never heard of 4663; the peer is still set,
    ///         the DVN and executor config is not, because the message library would revert on it.
    function deployAndWire(
        HoodOFTRemote remote,
        string memory name_,
        string memory symbol_,
        address endpoint,
        address wirer,
        bytes32 homePeer,
        address[] memory dvns,
        uint64 confirmations,
        uint32 maxMessageSize,
        address executor,
        uint128 lzReceiveGas
    ) internal returns (HoodOFTRemote, bool routeKnown) {
        if (address(remote) == address(0)) remote = deploy(name_, symbol_, endpoint, wirer);

        setPeerOnce(remote, HOME_EID, homePeer);

        routeKnown = routeIsKnown(ILayerZeroEndpointV2(endpoint), HOME_EID);
        if (routeKnown) {
            configureRouteOnce(remote, HOME_EID, dvns, confirmations, maxMessageSize, executor);
            enforceReceiveGasOnce(remote, HOME_EID, lzReceiveGas);
        }
        return (remote, routeKnown);
    }

    /// @dev Ascending, no duplicates: the message library checks both and reverts on either.
    function sorted(address[] memory input) internal pure returns (address[] memory out) {
        out = new address[](input.length);
        for (uint256 i; i < input.length; ++i) out[i] = input[i];
        for (uint256 i = 1; i < out.length; ++i) {
            address key = out[i];
            uint256 j = i;
            while (j > 0 && out[j - 1] > key) {
                out[j] = out[j - 1];
                --j;
            }
            out[j] = key;
        }
    }
}

/// @notice Puts the far end of a hood.fam token on a destination chain and points it home at 4663.
/// @dev Run this on the DESTINATION chain, with the destination's own gas token in the deployer.
///      The matching half, which points the 4663 adapter at what this prints, is
///      `script/WireRemote.s.sol` and it runs on 4663.
///
///      HOME_ADAPTER=0x.. TOKEN_NAME="Hood Fam" TOKEN_SYMBOL=FAM OWNER=0x.. \
///        forge script script/DeployRemote.s.sol --rpc-url https://mainnet.base.org --broadcast
contract DeployRemote is Script {
    function run() external returns (HoodOFTRemote remote) {
        uint256 pk = vm.envUint("PRIVATE_KEY");
        address wirer = vm.addr(pk);

        address endpoint = vm.envOr("LZ_ENDPOINT", RemoteWiring.CANONICAL_ENDPOINT);
        address homeAdapter = vm.envAddress("HOME_ADAPTER");
        string memory name_ = vm.envString("TOKEN_NAME");
        string memory symbol_ = vm.envString("TOKEN_SYMBOL");
        address owner = vm.envOr("OWNER", wirer);
        /// Set this to finish a run that died halfway instead of deploying a second token.
        remote = HoodOFTRemote(vm.envOr("REMOTE", address(0)));

        (uint32 defaultSize, address defaultExecutor) =
            RemoteWiring.defaultExecutor(ILayerZeroEndpointV2(endpoint), RemoteWiring.HOME_EID);

        address[] memory dvns = _dvns();
        /// The SAME number the 4663 side uses. `HoodBridgeFactory.configureRoute` writes one config
        /// for both directions, so the two ends cannot disagree about this without the route going
        /// quiet: a receiver asking for more confirmations than the sender attested with never
        /// verifies. 15 is `OpenRoute.s.sol`'s default and this matches it on purpose.
        uint64 confirmations = uint64(vm.envOr("CONFIRMATIONS", uint256(15)));
        uint32 maxMessageSize = uint32(vm.envOr("MAX_MESSAGE_SIZE", uint256(defaultSize)));
        address executor = vm.envOr("EXECUTOR", defaultExecutor);
        uint128 lzReceiveGas = uint128(vm.envOr("LZ_RECEIVE_GAS", uint256(200_000)));

        require(dvns.length > 0, "no DVN for this chain: pass DVNS=0x..,0x..");
        require(executor != address(0), "no executor for eid 30416 on this chain");

        vm.startBroadcast(pk);
        bool routeKnown;
        (remote, routeKnown) = RemoteWiring.deployAndWire(
            remote,
            name_,
            symbol_,
            endpoint,
            wirer,
            bytes32(uint256(uint160(homeAdapter))),
            dvns,
            confirmations,
            maxMessageSize,
            executor,
            lzReceiveGas
        );
        bool twoStep = RemoteWiring.handOver(remote, owner);
        vm.stopBroadcast();

        console.log("remote      ", address(remote));
        console.log("endpoint    ", endpoint);
        console.log("home adapter", homeAdapter);
        console.log("executor    ", executor);
        for (uint256 i; i < dvns.length; ++i) console.log("dvn         ", dvns[i]);
        if (!routeKnown) {
            console.log("SKIPPED config: this endpoint does not know eid 30416 yet.");
            console.log("The peer is set. Re-run this script once LayerZero registers 4663 here.");
        }
        if (twoStep) console.log("PENDING: OWNER must call acceptOwnership() on the remote");
        console.log("next: run script/WireRemote.s.sol on 4663 with REMOTE=", address(remote));
    }

    /// @dev DVNS overrides; otherwise the LayerZero Labs DVN for whatever chain we are pointed at.
    function _dvns() internal view returns (address[] memory) {
        address[] memory fallbackDVNs;
        address lz = RemoteWiring.layerZeroDVN(block.chainid);
        if (lz != address(0)) {
            fallbackDVNs = new address[](1);
            fallbackDVNs[0] = lz;
        }
        return vm.envOr("DVNS", ",", fallbackDVNs);
    }
}
