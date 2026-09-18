// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Vm} from "forge-std/Vm.sol";
import {SendParam, MessagingFee} from "@layerzerolabs/oft-evm/contracts/interfaces/IOFT.sol";
import {OptionsBuilder} from "@layerzerolabs/oapp-evm/contracts/oapp/libs/OptionsBuilder.sol";
import {ILayerZeroEndpointV2} from "@layerzerolabs/lz-evm-protocol-v2/contracts/interfaces/ILayerZeroEndpointV2.sol";
import {UlnConfig} from "@layerzerolabs/lz-evm-messagelib-v2/contracts/uln/UlnBase.sol";

import {ForkLZTest} from "./ForkLZ.t.sol";
import {RemoteWiring, IUlnConfigView} from "../script/DeployRemote.s.sol";
import {HoodOFTRemote} from "../src/omnichain/HoodOFTRemote.sol";
import {WireRemote} from "../script/WireRemote.s.sol";

/// The endpoint's delegate book. Not on ILayerZeroEndpointV2, but it is the thing that decides who
/// may change a token's route, so the hand-over has to be checked against it.
interface IEndpointDelegates {
    function delegates(address oapp) external view returns (address);
}

/// @notice The far end of the omnichain leg: a `HoodOFTRemote` on Base, against the real canonical
///         LayerZero endpoint, wired through the same library `script/DeployRemote.s.sol` runs.
/// @dev Two chains at once. The 4663 fixture, the launchpad and the adapter for a fresh token, is
///      inherited from `ForkLZTest` rather than copied, so there is one definition of what a
///      launched token looks like. The cost of that is that this contract also re-runs ForkLZ's own
///      tests; the alternative was a second copy of the fixture, which is worse.
///
///      Run with no flags: `forge test --match-path 'test/Fork*.t.sol'`. BASE_RPC and ROBINHOOD_RPC
///      override the public endpoints. The 4663 fork the inherited setUp creates comes from
///      foundry.toml's `robinhood` entry, which is the same public URL.
///
///      What this CANNOT prove: that a packet sent here actually arrives. That needs a live DVN and
///      executor on a real transaction, on two chains, and no fork can stand in for it.
contract ForkRemoteTest is ForkLZTest {
    using OptionsBuilder for bytes;

    /// LayerZero V2. The canonical address, which 4663 is the exception to.
    address internal constant CANONICAL_ENDPOINT = 0x1a44076050125825900e736c501f859c50fE728c;
    uint32 internal constant EID_HOME = 30416;
    /// The LayerZero Labs DVN on Base. Not the one the endpoint defaults to for 30416; see below.
    address internal constant DVN_LZ_ON_BASE = 0x9e059a54699a285714207b43B055483E78FAac25;
    /// `PacketSent(bytes encodedPayload, bytes options, address sendLibrary)`, the endpoint's own.
    bytes32 internal constant PACKET_SENT = keccak256("PacketSent(bytes,bytes,address)");

    uint64 internal constant CONFIRMATIONS = 15;
    uint128 internal constant LZ_RECEIVE_GAS = 200_000;

    receive() external payable {}

    function _baseFork() internal returns (uint256) {
        return vm.createFork(vm.envOr("BASE_RPC", string("https://mainnet.base.org")));
    }

    function _homeRpc() internal view returns (string memory) {
        return vm.envOr("ROBINHOOD_RPC", vm.rpcUrl("robinhood"));
    }

    function _lzDVNsOnBase() internal pure returns (address[] memory dvns) {
        dvns = new address[](1);
        dvns[0] = DVN_LZ_ON_BASE;
    }

    /// @dev `ForkLZTest._openRoute` points the adapter at a made-up peer, which is all a quote
    ///      needs. This one points it at a contract that actually exists on the other fork.
    function _openRouteTo(uint32 eid, address peer) internal {
        address[] memory dvns = new address[](1);
        dvns[0] = DVN_LAYERZERO;
        vm.startPrank(owner);
        bridge.setPeer(token, eid, bytes32(uint256(uint160(peer))));
        bridge.configureRoute(token, eid, dvns, CONFIRMATIONS, 10_000, LZ_EXECUTOR);
        vm.stopPrank();
    }

    /// @dev The whole script path, minus the env reading and the broadcast.
    function _deployRemoteOnBase(address homeAdapter) internal returns (HoodOFTRemote remote, bool routeKnown) {
        (uint32 maxMessageSize, address executor) =
            RemoteWiring.defaultExecutor(ILayerZeroEndpointV2(CANONICAL_ENDPOINT), EID_HOME);
        (remote, routeKnown) = RemoteWiring.deployAndWire(
            HoodOFTRemote(address(0)),
            "Hood Fam",
            "FAM",
            CANONICAL_ENDPOINT,
            address(this),
            bytes32(uint256(uint160(homeAdapter))),
            _lzDVNsOnBase(),
            CONFIRMATIONS,
            maxMessageSize,
            executor,
            LZ_RECEIVE_GAS
        );
    }

    // ------------------------------------------------------------ the reality check

    /// @notice Does the canonical endpoint on Base know 4663 exists at all?
    /// @dev This is the question everything else depends on. If it ever answers no, no amount of
    ///      configuration on our side makes a remote work: LayerZero has to register the chain.
    function test_fork_base_has_a_route_registered_for_4663() public {
        vm.selectFork(_baseFork());

        ILayerZeroEndpointV2 endpoint = ILayerZeroEndpointV2(CANONICAL_ENDPOINT);
        assertEq(endpoint.eid(), EID_BASE, "we are on Base");
        assertTrue(endpoint.isSupportedEid(EID_HOME), "Base knows eid 30416");

        address sendLib = endpoint.defaultSendLibrary(EID_HOME);
        address receiveLib = endpoint.defaultReceiveLibrary(EID_HOME);
        assertTrue(sendLib != address(0) && receiveLib != address(0));
        emit log_named_address("Base SendUln302 -> 30416", sendLib);
        emit log_named_address("Base ReceiveUln302 <- 30416", receiveLib);

        // The default config is NOT empty, it names one DVN. That DVN is a stub.
        UlnConfig memory dflt = IUlnConfigView(sendLib).getAppUlnConfig(address(0), EID_HOME);
        assertEq(dflt.requiredDVNCount, 1, "one required DVN by default");
        (bool ok,) = dflt.requiredDVNs[0].staticcall(
            abi.encodeWithSignature("getFee(uint32,uint64,address,bytes)", EID_HOME, dflt.confirmations, address(1), "")
        );
        assertFalse(ok, "the DEFAULT DVN for 30416 cannot price the route");
        emit log_named_address("Base default DVN for 30416 (a stub)", dflt.requiredDVNs[0]);

        // The one we name in the config can.
        (bool priced, bytes memory ret) = DVN_LZ_ON_BASE.staticcall(
            abi.encodeWithSignature("getFee(uint32,uint64,address,bytes)", EID_HOME, CONFIRMATIONS, address(1), "")
        );
        assertTrue(priced, "the LayerZero Labs DVN on Base prices 30416");
        emit log_named_uint("LZ Labs DVN fee, Base -> 4663, wei", abi.decode(ret, (uint256)));
    }

    /// @notice The same question in reverse, and the measurement `HoodBridgeFactory.configureRoute`
    ///         exists for.
    /// @dev The 4663 default for every destination names exactly one DVN, and that DVN reverts with
    ///      "Please set your OApp's DVNs and/or Executor" when asked for a price. An adapter that
    ///      only sets a peer inherits that stub and cannot send. The DVN the protocol names in its
    ///      own config does answer.
    function test_fork_the_default_dvn_on_4663_is_a_stub_that_cannot_price() public {
        vm.selectFork(vm.createFork(_homeRpc()));

        ILayerZeroEndpointV2 endpoint = ILayerZeroEndpointV2(LZ_ENDPOINT);
        assertEq(endpoint.eid(), EID_HOME);
        address sendLib = endpoint.defaultSendLibrary(EID_BASE);

        UlnConfig memory dflt = IUlnConfigView(sendLib).getAppUlnConfig(address(0), EID_BASE);
        assertEq(dflt.requiredDVNCount, 1);
        emit log_named_address("4663 default DVN for 30184 (a stub)", dflt.requiredDVNs[0]);

        (bool ok, bytes memory err) = dflt.requiredDVNs[0].staticcall(
            abi.encodeWithSignature("getFee(uint32,uint64,address,bytes)", EID_BASE, dflt.confirmations, address(1), "")
        );
        assertFalse(ok, "the default DVN on 4663 cannot price");
        assertEq(
            abi.decode(_slice(err, 4), (string)),
            "Please set your OApp's DVNs and/or Executor",
            "and it says so in as many words"
        );

        (bool priced, bytes memory ret) = DVN_LAYERZERO.staticcall(
            abi.encodeWithSignature("getFee(uint32,uint64,address,bytes)", EID_BASE, CONFIRMATIONS, address(1), "")
        );
        assertTrue(priced, "the DVN the protocol names does price");
        emit log_named_uint("LZ Labs DVN fee, 4663 -> Base, wei", abi.decode(ret, (uint256)));
    }

    // -------------------------------------------------------------- the remote on Base

    /// @notice A remote deployed and wired exactly the way the script does it, then asked to quote.
    function test_fork_a_remote_on_base_prices_and_sends_home() public {
        vm.selectFork(_baseFork());
        (HoodOFTRemote remote, bool routeKnown) = _deployRemoteOnBase(address(adapter));

        assertEq(remote.peers(EID_HOME), bytes32(uint256(uint160(address(adapter)))), "pointed home");
        assertEq(address(remote.endpoint()), CANONICAL_ENDPOINT);
        assertEq(remote.totalSupply(), 0, "a remote is born empty; supply only arrives from 4663");

        if (!routeKnown) {
            // Base does not know 4663. Only LayerZero can change that, and until it does a quote
            // fails inside the endpoint before any of our config is even consulted.
            vm.expectRevert();
            remote.quoteSend(_sendHome(1e18), false);
            return;
        }

        // The config the script wrote is the token's own, not the chain default it was riding on.
        ILayerZeroEndpointV2 endpoint = ILayerZeroEndpointV2(CANONICAL_ENDPOINT);
        UlnConfig memory own =
            IUlnConfigView(endpoint.defaultSendLibrary(EID_HOME)).getAppUlnConfig(address(remote), EID_HOME);
        assertEq(own.requiredDVNCount, 1);
        assertEq(own.requiredDVNs[0], DVN_LZ_ON_BASE);
        assertEq(own.confirmations, CONFIRMATIONS);
        own = IUlnConfigView(endpoint.defaultReceiveLibrary(EID_HOME)).getAppUlnConfig(address(remote), EID_HOME);
        assertEq(own.requiredDVNs[0], DVN_LZ_ON_BASE, "the way back is configured too");

        // Enforced options mean a caller who passes nothing still pays for gas on arrival.
        assertGt(remote.enforcedOptions(EID_HOME, 1).length, 0);
        MessagingFee memory fee = remote.quoteSend(_sendHome(1_000e18), false);
        assertGt(fee.nativeFee, 0, "Base prices a send to 4663");
        assertEq(fee.lzTokenFee, 0);
        emit log_named_uint("fee Base -> 4663, wei", fee.nativeFee);

        deal(address(remote), address(this), 1_000e18, true);
        vm.deal(address(this), fee.nativeFee);

        vm.recordLogs();
        remote.send{value: fee.nativeFee}(_sendHome(1_000e18), fee, address(this));
        Vm.Log[] memory logs = vm.getRecordedLogs();

        bool sent;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter == CANONICAL_ENDPOINT && logs[i].topics[0] == PACKET_SENT) sent = true;
        }
        assertTrue(sent, "the endpoint accepted the packet");
        assertEq(remote.totalSupply(), 0, "a remote BURNS on the way out, the supply goes back to 4663");
    }

    /// @notice Running the wiring twice has to be free.
    /// @dev Route opening is done by hand, and the second half of a run that died is the normal
    ///      case, not the exception.
    function test_fork_wiring_the_remote_again_writes_nothing() public {
        vm.selectFork(_baseFork());
        (HoodOFTRemote remote, bool routeKnown) = _deployRemoteOnBase(address(adapter));
        if (!routeKnown) return;

        (uint32 maxMessageSize, address executor) =
            RemoteWiring.defaultExecutor(ILayerZeroEndpointV2(CANONICAL_ENDPOINT), EID_HOME);
        assertFalse(
            RemoteWiring.setPeerOnce(remote, EID_HOME, bytes32(uint256(uint160(address(adapter))))), "peer untouched"
        );
        assertFalse(
            RemoteWiring.configureRouteOnce(
                remote, EID_HOME, _lzDVNsOnBase(), CONFIRMATIONS, maxMessageSize, executor
            ),
            "config untouched"
        );
        assertFalse(RemoteWiring.enforceReceiveGasOnce(remote, EID_HOME, LZ_RECEIVE_GAS), "options untouched");

        // And the hand-over moves the delegate, not just the owner.
        address newOwner = makeAddr("multisig");
        assertFalse(RemoteWiring.handOver(remote, newOwner), "HoodOFTRemote is plain Ownable, one step");
        assertEq(remote.owner(), newOwner);
        assertEq(
            IEndpointDelegates(CANONICAL_ENDPOINT).delegates(address(remote)),
            newOwner,
            "the new owner can still change the route"
        );
    }

    // ------------------------------------------------------------------ both ends

    /// @notice The pair, wired to each other's real addresses, quoting in both directions.
    /// @dev This is as far as a fork goes. Both endpoints accept the packet and price it; whether
    ///      the DVN signs it and the executor delivers it is off-chain and only a live send tells.
    function test_fork_both_ends_of_the_pair_price_a_send() public {
        uint256 homeFork = vm.activeFork();

        vm.selectFork(_baseFork());
        (HoodOFTRemote remote, bool routeKnown) = _deployRemoteOnBase(address(adapter));
        if (!routeKnown) return;
        MessagingFee memory outbound = remote.quoteSend(_sendHome(1_000e18), false);

        vm.selectFork(homeFork);

        // The 4663 half is idempotent on the same reads WireRemote uses: not configured, then
        // configured, off the adapter's OWN config rather than the endpoint's merged view.
        WireRemote wire = new WireRemote();
        address[] memory homeDVNs = new address[](1);
        homeDVNs[0] = DVN_LAYERZERO;
        assertFalse(
            wire.routeIsConfigured(bridge, address(adapter), EID_BASE, homeDVNs, CONFIRMATIONS, 10_000, LZ_EXECUTOR),
            "nothing written yet"
        );

        _openRouteTo(EID_BASE, address(remote));
        assertEq(adapter.peers(EID_BASE), bytes32(uint256(uint160(address(remote)))), "4663 points at the remote");
        assertTrue(
            wire.routeIsConfigured(bridge, address(adapter), EID_BASE, homeDVNs, CONFIRMATIONS, 10_000, LZ_EXECUTOR),
            "and a second run would skip the write"
        );

        bytes memory options = OptionsBuilder.newOptions().addExecutorLzReceiveOption(LZ_RECEIVE_GAS, 0);
        MessagingFee memory inbound = adapter.quoteSend(
            SendParam({
                dstEid: EID_BASE,
                to: bytes32(uint256(uint160(creator))),
                amountLD: 1_000e18,
                minAmountLD: 1_000e18,
                extraOptions: options,
                composeMsg: "",
                oftCmd: ""
            }),
            false
        );
        assertGt(inbound.nativeFee, 0, "4663 prices a send to Base");
        emit log_named_uint("fee 4663 -> Base, wei", inbound.nativeFee);
        emit log_named_uint("fee Base -> 4663, wei", outbound.nativeFee);
    }

    /// @notice `script/WireRemote.s.sol` itself, run against the real 4663 endpoint, twice.
    /// @dev The Base half is proven above through the library both it and the script call. This is
    ///      the other half, and the run that matters is the second one: it has to write nothing.
    function test_fork_the_wire_script_opens_the_route_and_the_second_run_is_a_no_op() public {
        uint256 pk = 0xA11CE;
        address wirer = vm.addr(pk);
        vm.prank(owner);
        bridge.transferOwnership(wirer);
        vm.prank(wirer);
        bridge.acceptOwnership();

        address remote = makeAddr("remoteOnBase");
        vm.setEnv("PRIVATE_KEY", vm.toString(pk));
        vm.setEnv("HOOD_BRIDGE_FACTORY", vm.toString(address(bridge)));
        vm.setEnv("TOKEN", vm.toString(token));
        vm.setEnv("DST_EID", "30184");
        vm.setEnv("REMOTE", vm.toString(remote));
        vm.setEnv("CONFIRMATIONS", vm.toString(uint256(CONFIRMATIONS)));

        WireRemote wire = new WireRemote();
        wire.run();

        address[] memory homeDVNs = new address[](1);
        homeDVNs[0] = DVN_LAYERZERO;
        assertEq(adapter.peers(EID_BASE), bytes32(uint256(uint160(remote))), "peer set by the script");
        assertTrue(
            wire.routeIsConfigured(bridge, address(adapter), EID_BASE, homeDVNs, CONFIRMATIONS, 10_000, LZ_EXECUTOR)
        );

        bytes memory options = OptionsBuilder.newOptions().addExecutorLzReceiveOption(LZ_RECEIVE_GAS, 0);
        MessagingFee memory fee = adapter.quoteSend(
            SendParam({
                dstEid: EID_BASE,
                to: bytes32(uint256(uint160(creator))),
                amountLD: 1_000e18,
                minAmountLD: 1_000e18,
                extraOptions: options,
                composeMsg: "",
                oftCmd: ""
            }),
            false
        );
        assertGt(fee.nativeFee, 0, "the route the script opened is priced");

        // Again. Same state in, same state out, and nothing reverts on the way.
        vm.recordLogs();
        wire.run();
        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i; i < logs.length; ++i) {
            assertTrue(logs[i].emitter != address(bridge), "the second run touched the bridge");
        }
    }

    // ------------------------------------------------------------------ helpers

    function _sendHome(uint256 amount) internal pure returns (SendParam memory) {
        return SendParam({
            dstEid: EID_HOME,
            to: bytes32(uint256(uint160(address(0xBEEF)))),
            amountLD: amount,
            minAmountLD: amount,
            // Empty on purpose: the enforced options the script wrote have to carry it alone.
            extraOptions: "",
            composeMsg: "",
            oftCmd: ""
        });
    }

    function _slice(bytes memory data, uint256 from) internal pure returns (bytes memory out) {
        out = new bytes(data.length - from);
        for (uint256 i; i < out.length; ++i) out[i] = data[from + i];
    }
}
