// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Script, console} from "forge-std/Script.sol";

import {HoodFactory} from "../src/HoodFactory.sol";
import {HoodDeployer} from "../src/HoodDeployer.sol";
import {HoodFeeRouter} from "../src/HoodFeeRouter.sol";
import {HoodStaking} from "../src/HoodStaking.sol";
import {HoodTokenLock} from "../src/HoodTokenLock.sol";
import {HoodCurveRouter} from "../src/HoodCurveRouter.sol";
import {UniswapV4Graduator} from "../src/graduation/UniswapV4Graduator.sol";
import {HoodBridgeFactory} from "../src/omnichain/HoodBridgeFactory.sol";
import {HoodPortal} from "../src/direct/HoodPortal.sol";
import {HoodDirectDeployer} from "../src/direct/HoodDirectDeployer.sol";
import {HoodLaunchToken} from "../src/direct/HoodLaunchToken.sol";
import {HoodBuybackModule} from "../src/direct/HoodBuybackModule.sol";
import {CurveConfig} from "../src/HoodTypes.sol";
import {ISafe, SafeLib} from "./safe/Safe.sol";

/// @notice Deploys hood.fam on Robinhood Chain 4663.
/// @dev The deployer is the owner while it wires the modules and seeds the presets, then hands
///      ownership to OWNER. Use a wallet generated for this project and nothing else.
///
///      On 4663, OWNER and TREASURY must both be a Safe with at least two signers (create it first
///      with `script/DeploySafe.s.sol`). ALLOW_EOA_OWNER=true lifts that, for a rehearsal on a fork
///      and never for the real thing: one key owning the presets and the fee switch is one phished
///      laptop away from owning every future launch.
///
///      forge script script/Deploy.s.sol --rpc-url robinhood --broadcast
contract Deploy is Script {
    address internal constant POOL_MANAGER = 0x8366a39CC670B4001A1121B8F6A443A643e40951;
    address internal constant POSITION_MANAGER = 0x58daec3116aae6D93017bAAea7749052E8a04fA7;
    address internal constant UNIVERSAL_ROUTER = 0x8876789976dEcBfCbBbe364623C63652db8C0904;
    address internal constant PERMIT2 = 0x000000000022D473030F116dDEE9F6B43aC78BA3;
    address internal constant STATE_VIEW = 0xF3334192D15450CdD385c8B70e03f9A6bD9E673b;
    /// LayerZero V2 on 4663. NOT the canonical 0x1a44... address; this one is verified on chain.
    address internal constant LZ_ENDPOINT = 0x6F475642a6e85809B1c36Fa62763669b1b48DD5B;
    address internal constant USDG = 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168; // six decimals

    function run() external {
        uint256 pk = vm.envUint("PRIVATE_KEY");
        address owner = vm.envAddress("OWNER");
        address treasury = vm.envAddress("TREASURY");
        address deployer = vm.addr(pk);

        if (block.chainid == 4663 && !vm.envOr("ALLOW_EOA_OWNER", false)) {
            _requireSafe("OWNER", owner);
            _requireSafe("TREASURY", treasury);
        }

        vm.startBroadcast(pk);

        HoodDeployer bytecode = new HoodDeployer();
        console.log("deployer  ", address(bytecode));
        HoodFactory factory = new HoodFactory(deployer, treasury, address(bytecode));
        console.log("factory   ", address(factory));
        bytecode.initialize(address(factory));
        HoodStaking staking = new HoodStaking(address(factory));
        console.log("staking   ", address(staking));
        HoodFeeRouter feeRouter = new HoodFeeRouter(address(factory), address(staking));
        console.log("feeRouter ", address(feeRouter));
        HoodTokenLock firstBuyLocker = new HoodTokenLock();
        console.log("firstBuyLock", address(firstBuyLocker));
        UniswapV4Graduator graduator = new UniswapV4Graduator(
            address(factory), POOL_MANAGER, POSITION_MANAGER, UNIVERSAL_ROUTER, PERMIT2, STATE_VIEW
        );
        console.log("graduator ", address(graduator));
        HoodCurveRouter curveRouter = new HoodCurveRouter(address(factory), UNIVERSAL_ROUTER);
        console.log("curveRouter", address(curveRouter));

        HoodBridgeFactory bridge = new HoodBridgeFactory(deployer, address(factory), LZ_ENDPOINT);
        console.log("bridge    ", address(bridge));

        factory.setModules(address(feeRouter), address(staking), address(graduator));
        factory.setFirstBuyLocker(address(firstBuyLocker));
        factory.setLaunchFee(0.0005 ether);

        // Native pair. A ticker locks after this much volume inside 24 hours.
        factory.setPair(address(0), true, 25 ether);
        factory.setPair(USDG, true, 100_000e6);

        // 0: the standard launch. A billion tokens, four fifths on the curve, graduates at a ten
        //    ETH valuation, which is a raise of about 4.4 ETH.
        factory.addConfig(
            CurveConfig({
                pairToken: address(0),
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

        // 1: the wide launch, for something that expects real size before it graduates.
        factory.addConfig(
            CurveConfig({
                pairToken: address(0),
                totalSupply: 1_000_000_000e18,
                curveSupplyBps: 8000,
                startCap: 2 ether,
                graduationCap: 40 ether,
                liquidityBps: 9500,
                protocolFeeBps: 30,
                creatorFeeBps: 70,
                poolFee: 3000,
                tickSpacing: 60,
                enabled: true
            })
        );

        // 2: priced in dollars, so the chart does not move with ETH.
        factory.addConfig(
            CurveConfig({
                pairToken: USDG,
                totalSupply: 1_000_000_000e18,
                curveSupplyBps: 8000,
                startCap: 5_000e6,
                graduationCap: 50_000e6,
                liquidityBps: 9000,
                protocolFeeBps: 30,
                creatorFeeBps: 70,
                poolFee: 3000,
                tickSpacing: 60,
                enabled: true
            })
        );

        // ---- the direct machine: no curve, the supply is the liquidity from block one ----
        HoodDirectDeployer directDeployer = new HoodDirectDeployer();
        console.log("directDeployer", address(directDeployer));
        HoodLaunchToken tokenImplementation = new HoodLaunchToken();
        console.log("tokenImpl ", address(tokenImplementation));
        HoodPortal portal = new HoodPortal(
            deployer, treasury, address(directDeployer), address(tokenImplementation),
            POOL_MANAGER, POSITION_MANAGER, PERMIT2
        );
        console.log("portal    ", address(portal));
        directDeployer.initialize(address(portal));
        HoodBuybackModule buybackModule = new HoodBuybackModule(POOL_MANAGER, address(portal));
        console.log("buyback   ", address(buybackModule));

        portal.setBuybackModule(address(buybackModule));
        portal.setRegistry(address(factory));
        portal.setQuote(USDG, true);
        factory.setPortal(address(portal));

        if (owner != deployer) {
            factory.transferOwnership(owner);
            bridge.transferOwnership(owner);
            portal.transferOwnership(owner);
            // All three are Ownable2Step: nothing moves until the owner calls acceptOwnership().
            // From a Safe that is one batch: `npm run safe -- accept` builds it.
            console.log("PENDING: owner must call acceptOwnership() on factory, bridge and portal");
            console.log("PENDING: the house coin is unset; launch it, then owner calls staking.setHouseToken(coin)");
            if (SafeLib.looksLikeSafe(owner)) console.log("         one Safe batch: npm run safe -- accept");
        }

        vm.stopBroadcast();

        // Each address is printed where it is made, above. Printing them all down here kept every
        // one of them alive across the whole of `run()`, and the twelfth contract was the one that
        // ran the Yul optimizer out of stack slots.
        console.log("start block", block.number);
    }

    /// @dev A Safe with at least two signers, or the deploy stops before it sends anything.
    function _requireSafe(string memory what, address who) internal view {
        require(SafeLib.looksLikeSafe(who), string.concat(what, " is not a Safe; run script/DeploySafe.s.sol first"));
        uint256 threshold = ISafe(who).getThreshold();
        require(threshold >= 2, string.concat(what, " is a Safe that one key can drive alone"));
        console.log(what, "is a Safe", threshold);
    }
}
