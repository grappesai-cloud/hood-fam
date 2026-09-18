// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Script, console} from "forge-std/Script.sol";

import {HoodFactory} from "../src/HoodFactory.sol";
import {HoodDeployer} from "../src/HoodDeployer.sol";
import {HoodFeeRouter} from "../src/HoodFeeRouter.sol";
import {HoodStaking} from "../src/HoodStaking.sol";
import {HoodBridgeFactory} from "../src/omnichain/HoodBridgeFactory.sol";
import {CurveConfig} from "../src/HoodTypes.sol";
import {MockGraduator, MockLZEndpoint} from "../test/mocks/Mocks.sol";

/// @notice The same wiring as production, on a chain that has no Uniswap and no LayerZero: for
///         running the indexer, the API, the keeper and the app against something real end to end.
///         Production uses script/Deploy.s.sol, which points at the real ones.
contract DeployLocal is Script {
    function run() external {
        uint256 pk = vm.envUint("PRIVATE_KEY");
        address deployer = vm.addr(pk);

        vm.startBroadcast(pk);

        HoodDeployer bytecodeHolder = new HoodDeployer();
        HoodFactory factory = new HoodFactory(deployer, deployer, address(bytecodeHolder));
        bytecodeHolder.initialize(address(factory));

        HoodStaking staking = new HoodStaking(address(factory));
        HoodFeeRouter feeRouter = new HoodFeeRouter(address(factory), address(staking));
        MockGraduator graduator = new MockGraduator(address(factory));
        MockLZEndpoint endpoint = new MockLZEndpoint();
        HoodBridgeFactory bridge = new HoodBridgeFactory(deployer, address(factory), address(endpoint));

        factory.setModules(address(feeRouter), address(staking), address(graduator));
        factory.setLaunchFee(0.0005 ether);
        factory.setPair(address(0), true, 25 ether);
        factory.addConfig(
            CurveConfig({
                totalSupply: 1_000_000_000e18,
                curveSupplyBps: 8000,
                startCap: 1 ether,
                graduationCap: 10 ether,
                liquidityBps: 9000,
                protocolFeeBps: 30,
                creatorFeeBps: 70,
                poolFee: 3000,
                tickSpacing: 60,
                enabled: true
            })
        );

        vm.stopBroadcast();

        console.log("HOOD_FACTORY=%s", address(factory));
        console.log("HOOD_FEE_ROUTER=%s", address(feeRouter));
        console.log("HOOD_STAKING=%s", address(staking));
        console.log("HOOD_GRADUATOR=%s", address(graduator));
        console.log("HOOD_BRIDGE_FACTORY=%s", address(bridge));
        console.log("HOOD_START_BLOCK=%s", block.number);
    }
}
