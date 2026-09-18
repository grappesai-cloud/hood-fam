// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {BaseTest} from "./Base.t.sol";
import {HoodBridgeFactory} from "../src/omnichain/HoodBridgeFactory.sol";
import {HoodOFTAdapter} from "../src/omnichain/HoodOFTAdapter.sol";
import {FeeModel} from "../src/HoodTypes.sol";
import {MockLZEndpoint} from "./mocks/Mocks.sol";

/// @notice The lock box rules. Messaging itself is exercised against the real endpoint in ForkLZ.t.sol.
contract BridgeTest is BaseTest {
    HoodBridgeFactory internal bridge;
    address internal endpoint;

    function setUp() public override {
        super.setUp();
        endpoint = address(new MockLZEndpoint());
        bridge = new HoodBridgeFactory(owner, address(factory), endpoint);
    }

    function test_one_token_gets_exactly_one_lock_box() public {
        (address token,) = _launch(FeeModel.StakingRewards);

        address predicted = bridge.predictAdapter(token);
        address adapter = bridge.deployAdapter(token);

        assertEq(adapter, predicted, "the address is known before it exists");
        assertEq(bridge.adapterOf(token), adapter);
        assertEq(bridge.adapterCount(), 1);
        assertEq(HoodOFTAdapter(adapter).token(), token);
        // The adapter is owned by the bridge factory, and the factory is owned by the protocol, so
        // routes are opened through one contract with one owner rather than a loose EOA per token.
        assertEq(HoodOFTAdapter(adapter).owner(), address(bridge), "the factory holds the adapter");
        assertEq(bridge.owner(), owner, "and the protocol holds the factory");

        vm.expectRevert(HoodBridgeFactory.AdapterExists.selector);
        bridge.deployAdapter(token);
    }

    function test_only_the_protocol_can_open_a_route() public {
        (address token,) = _launch(FeeModel.StakingRewards);
        bridge.deployAdapter(token);

        vm.prank(bob);
        vm.expectRevert();
        bridge.setPeer(token, 30184, bytes32(uint256(1)));

        vm.prank(owner);
        bridge.setPeer(token, 30184, bytes32(uint256(1)));
    }

    function test_only_a_token_this_launchpad_printed_can_have_one() public {
        vm.expectRevert(HoodBridgeFactory.UnknownToken.selector);
        bridge.deployAdapter(address(usd));
    }

    function test_the_token_keeps_its_supply_when_it_travels() public {
        (address token, ) = _launch(FeeModel.StakingRewards);
        address adapter = bridge.deployAdapter(token);

        // the lock box holds nothing until something leaves, and it cannot mint: the token has no
        // mint function at all, so the supply on 4663 is fixed no matter what the mesh does
        assertEq(IERC20(token).balanceOf(adapter), 0);
        assertEq(IERC20(token).totalSupply(), 1_000_000_000e18);
        (bool ok,) = token.call(abi.encodeWithSignature("mint(address,uint256)", address(this), 1e18));
        assertFalse(ok, "there is no mint");
    }
}
