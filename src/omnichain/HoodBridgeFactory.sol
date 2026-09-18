// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {SetConfigParam} from "@layerzerolabs/lz-evm-protocol-v2/contracts/interfaces/IMessageLibManager.sol";
import {UlnConfig} from "@layerzerolabs/lz-evm-messagelib-v2/contracts/uln/UlnBase.sol";
import {ExecutorConfig} from "@layerzerolabs/lz-evm-messagelib-v2/contracts/SendLibBase.sol";

import {HoodOFTAdapter} from "./HoodOFTAdapter.sol";
import {IHoodFactory} from "../interfaces/IHoodFactory.sol";

interface ILZEndpoint {
    function setConfig(address oapp, address lib, SetConfigParam[] calldata params) external;
    function defaultSendLibrary(uint32 eid) external view returns (address);
    function defaultReceiveLibrary(uint32 eid) external view returns (address);
}

/// @title HoodBridgeFactory
/// @notice Deploys the one and only lock box for a hood.fam token, for anybody who asks.
/// @dev Two adapters for one token would each believe they hold the canonical supply, and the mesh
///      could print. So the registry here is the rule: one token, one adapter, deployed at an
///      address derived from the token, and only for a token this launchpad actually printed.
///      Deployment is permissionless; the delegate that wires LayerZero peers is the protocol,
///      because peer wiring is what decides where the token is allowed to travel.
contract HoodBridgeFactory is Ownable2Step {
    IHoodFactory public immutable factory;
    /// @notice LayerZero V2 endpoint on this chain. On 4663 it is NOT the canonical address.
    address public immutable lzEndpoint;

    mapping(address token => address adapter) public adapterOf;
    address[] public adapters;

    event AdapterDeployed(address indexed token, address indexed adapter);
    event RouteOpened(address indexed token, uint32 indexed eid, bytes32 peer);
    event RouteConfigured(address indexed token, uint32 indexed eid, address[] dvns, uint64 confirmations);

    error UnknownToken();
    error AdapterExists();
    error NoAdapter();
    error NoDVNs();

    constructor(address owner_, address factory_, address lzEndpoint_) Ownable(owner_) {
        factory = IHoodFactory(factory_);
        lzEndpoint = lzEndpoint_;
    }

    function adapterCount() external view returns (uint256) {
        return adapters.length;
    }

    /// @notice Deploys the lock box for `token`. Anyone may call it, once per token.
    function deployAdapter(address token) external returns (address adapter) {
        if (!factory.getLaunch(token).exists) revert UnknownToken();
        if (adapterOf[token] != address(0)) revert AdapterExists();

        adapter = address(
            new HoodOFTAdapter{salt: bytes32(uint256(uint160(token)))}(token, lzEndpoint, address(this))
        );
        adapterOf[token] = adapter;
        adapters.push(adapter);
        emit AdapterDeployed(token, adapter);
    }

    /// @notice The address the adapter for `token` will have, before it exists.
    function predictAdapter(address token) external view returns (address) {
        bytes32 initHash = keccak256(
            abi.encodePacked(type(HoodOFTAdapter).creationCode, abi.encode(token, lzEndpoint, address(this)))
        );
        return address(
            uint160(
                uint256(
                    keccak256(
                        abi.encodePacked(bytes1(0xff), address(this), bytes32(uint256(uint160(token))), initHash)
                    )
                )
            )
        );
    }

    // ---------------------------------------------------------------- routes

    /// @notice Opens a route: this is the contract on `eid` that our adapter will talk to.
    /// @dev Peers decide where a token is allowed to travel, which is why they are the protocol's
    ///      call and not the creator's. A wrong peer is a token that arrives somewhere it cannot
    ///      come back from.
    function setPeer(address token, uint32 eid, bytes32 peer) external onlyOwner {
        address adapter = adapterOf[token];
        if (adapter == address(0)) revert NoAdapter();
        HoodOFTAdapter(adapter).setPeer(eid, peer);
        emit RouteOpened(token, eid, peer);
    }

    /// @notice Sets who has to verify a message on this route, and who delivers it.
    /// @dev On 4663 the endpoint's default config carries NO DVNs, so an OApp that only sets peers
    ///      cannot send: the quote reverts with "Please set your OApp's DVNs and/or Executor".
    ///      Measured on a fork, not read in a doc. Every adapter therefore gets its config here.
    /// @param requiredDVNs must be sorted ascending and free of duplicates, the message lib checks it.
    function configureRoute(
        address token,
        uint32 eid,
        address[] calldata requiredDVNs,
        uint64 confirmations,
        uint32 maxMessageSize,
        address executor
    ) external onlyOwner {
        address adapter = adapterOf[token];
        if (adapter == address(0)) revert NoAdapter();
        if (requiredDVNs.length == 0) revert NoDVNs();

        UlnConfig memory uln = UlnConfig({
            confirmations: confirmations,
            requiredDVNCount: uint8(requiredDVNs.length),
            optionalDVNCount: 0,
            optionalDVNThreshold: 0,
            requiredDVNs: requiredDVNs,
            optionalDVNs: new address[](0)
        });

        SetConfigParam[] memory sendParams = new SetConfigParam[](2);
        sendParams[0] = SetConfigParam({eid: eid, configType: 1, config: abi.encode(ExecutorConfig({maxMessageSize: maxMessageSize, executor: executor}))});
        sendParams[1] = SetConfigParam({eid: eid, configType: 2, config: abi.encode(uln)});

        SetConfigParam[] memory receiveParams = new SetConfigParam[](1);
        receiveParams[0] = sendParams[1];

        ILZEndpoint ep = ILZEndpoint(lzEndpoint);
        ep.setConfig(adapter, ep.defaultSendLibrary(eid), sendParams);
        ep.setConfig(adapter, ep.defaultReceiveLibrary(eid), receiveParams);

        emit RouteConfigured(token, eid, requiredDVNs, confirmations);
    }

    /// @notice Hands the endpoint delegate role for one adapter to somebody else.
    /// @dev Kept for the day LayerZero needs a migration done from an address that is not this one.
    function setAdapterDelegate(address token, address delegate) external onlyOwner {
        address adapter = adapterOf[token];
        if (adapter == address(0)) revert NoAdapter();
        HoodOFTAdapter(adapter).setDelegate(delegate);
    }
}
