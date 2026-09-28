// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Script, console} from "forge-std/Script.sol";

import {HoodFactory} from "../src/HoodFactory.sol";
import {HoodDeployer} from "../src/HoodDeployer.sol";
import {HoodFeeRouter} from "../src/HoodFeeRouter.sol";
import {HoodStaking} from "../src/HoodStaking.sol";
import {HoodTokenLock} from "../src/HoodTokenLock.sol";
import {HoodBlockZero} from "../src/HoodBlockZero.sol";
import {HoodReferrals} from "../src/HoodReferrals.sol";
import {HoodBridgeFactory} from "../src/omnichain/HoodBridgeFactory.sol";
import {HoodBag} from "../src/bag/HoodBag.sol";
import {HoodPayday} from "../src/bag/HoodPayday.sol";
import {HoodBurnClock} from "../src/bag/HoodBurnClock.sol";
import {HoodBoosts} from "../src/bag/HoodBoosts.sol";
import {CurveConfig} from "../src/HoodTypes.sol";
import {MockGraduator, MockLZEndpoint} from "../test/mocks/Mocks.sol";
import {GraduationHookDeploy} from "./lib/GraduationHookDeploy.sol";

/// @notice The same wiring as production, on a chain that has no Uniswap and no LayerZero: for
///         running the indexer, the API, the keeper and the app against something real end to end.
///         Production uses script/Deploy.s.sol, which points at the real ones.
/// @dev What is here: the curve machine on a mock graduator, the Bag with its two clocks, the
///      boosts board and the graduation hook (mined, so the address rule is exercised even though
///      nothing swaps through it without a pool manager). What is not: the direct machine, which
///      cannot stand without Uniswap v4; their env keys stay empty and the
///      pages that need them say so.
///
///      forge script script/DeployLocal.s.sol --rpc-url http://127.0.0.1:8545 --broadcast --private-key <key>
contract DeployLocal is Script {
    uint256 internal constant LAUNCH_FEE = 0.002 ether;

    struct Book {
        address factory;
        address referrals;
        address staking;
        address feeRouter;
        address firstBuyLocker;
        address graduator;
        address bridge;
        address payday;
        address burnClock;
        address bag;
        address boosts;
        address graduationHook;
        address blockZero;
    }

    Book internal book;

    function run() external {
        uint256 pk = vm.envUint("PRIVATE_KEY");
        address deployer = vm.addr(pk);
        address keeper = vm.envOr("KEEPER", address(0));

        vm.startBroadcast(pk);

        HoodDeployer bytecodeHolder = new HoodDeployer();
        HoodFactory factory = new HoodFactory(deployer, deployer, address(bytecodeHolder));
        book.factory = address(factory);
        bytecodeHolder.initialize(book.factory);
        book.referrals = address(new HoodReferrals(deployer));
        factory.setReferrals(book.referrals);
        book.staking = address(new HoodStaking(book.factory));
        book.feeRouter = address(new HoodFeeRouter(book.factory, book.staking));
        book.firstBuyLocker = address(new HoodTokenLock());
        book.graduator = address(new MockGraduator(book.factory));
        MockLZEndpoint endpoint = new MockLZEndpoint();
        book.bridge = address(new HoodBridgeFactory(deployer, book.factory, address(endpoint)));

        // The Bag: the deployer plays the house here. No pool manager on this chain, so the burn
        // clock and the hook get none; neither touches it before the house coin is named.
        book.payday = address(new HoodPayday(book.factory));
        book.burnClock = address(new HoodBurnClock(book.factory, address(0)));
        book.bag = address(new HoodBag(deployer, book.staking, book.payday, book.burnClock));
        book.boosts = address(new HoodBoosts(book.factory, book.bag));
        book.graduationHook = GraduationHookDeploy.deploy(address(0), book.factory, book.bag, book.feeRouter);

        factory.setModules(book.feeRouter, book.staking, book.graduator);
        factory.setBag(book.bag);
        factory.setFirstBuyLocker(book.firstBuyLocker);
        book.blockZero = address(new HoodBlockZero(book.factory));
        factory.setLaunchFee(LAUNCH_FEE);
        factory.setPair(address(0), true, 25 ether);
        factory.addConfig(
            CurveConfig({
                pairToken: address(0),
                totalSupply: 1_000_000_000e18,
                curveSupplyBps: 8000,
                startCap: 1.1 ether,
                graduationCap: 11.025 ether,
                liquidityBps: 9000,
                protocolFeeBps: 30,
                creatorFeeBps: 70,
                poolFee: 3000,
                tickSpacing: 60,
                enabled: true
            })
        );

        if (keeper != address(0)) {
            HoodFeeRouter(payable(book.feeRouter)).setKeeper(keeper);
            HoodPayday(payable(book.payday)).setKeeper(keeper);
            HoodBurnClock(payable(book.burnClock)).setKeeper(keeper);
        }

        vm.stopBroadcast();

        console.log("HOOD_FACTORY=%s", book.factory);
        console.log("HOOD_FEE_ROUTER=%s", book.feeRouter);
        console.log("HOOD_STAKING=%s", book.staking);
        console.log("HOOD_GRADUATOR=%s", book.graduator);
        console.log("HOOD_BRIDGE_FACTORY=%s", book.bridge);
        console.log("HOOD_REFERRALS=%s", book.referrals);
        console.log("HOOD_BAG=%s", book.bag);
        console.log("HOOD_PAYDAY=%s", book.payday);
        console.log("HOOD_BURN_CLOCK=%s", book.burnClock);
        console.log("HOOD_BOOSTS=%s", book.boosts);
        console.log("HOOD_GRADUATION_HOOK=%s", book.graduationHook);
        console.log("HOOD_BLOCK_ZERO=%s", book.blockZero);
        console.log("HOOD_START_BLOCK=%s", block.number);
        console.log("# no Uniswap v4 here: HOOD_PORTAL, HOOD_DIRECT_DEPLOYER, HOOD_BUYBACK_MODULE, HOOD_OPENING_AUCTION stay empty");
        if (keeper == address(0)) console.log("# no KEEPER given: feeRouter, payday and burnClock have no keeper yet");
    }
}
