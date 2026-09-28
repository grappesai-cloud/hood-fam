// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Script, console} from "forge-std/Script.sol";

import {HoodFactory} from "../src/HoodFactory.sol";
import {HoodDeployer} from "../src/HoodDeployer.sol";
import {HoodFeeRouter} from "../src/HoodFeeRouter.sol";
import {HoodStaking} from "../src/HoodStaking.sol";
import {HoodTokenLock} from "../src/HoodTokenLock.sol";
import {HoodBlockZero} from "../src/HoodBlockZero.sol";
import {HoodCurveRouter} from "../src/HoodCurveRouter.sol";
import {HoodReferrals} from "../src/HoodReferrals.sol";
import {UniswapV4Graduator} from "../src/graduation/UniswapV4Graduator.sol";
import {HoodBridgeFactory} from "../src/omnichain/HoodBridgeFactory.sol";
import {HoodPortal} from "../src/direct/HoodPortal.sol";
import {HoodDirectDeployer} from "../src/direct/HoodDirectDeployer.sol";
import {HoodLaunchToken} from "../src/direct/HoodLaunchToken.sol";
import {HoodBuybackModule} from "../src/direct/HoodBuybackModule.sol";
import {HoodBag} from "../src/bag/HoodBag.sol";
import {HoodPayday} from "../src/bag/HoodPayday.sol";
import {HoodBurnClock} from "../src/bag/HoodBurnClock.sol";
import {HoodBoosts} from "../src/bag/HoodBoosts.sol";
import {CurveConfig} from "../src/HoodTypes.sol";
import {ISafe, SafeLib} from "./safe/Safe.sol";
import {GraduationHookDeploy} from "./lib/GraduationHookDeploy.sol";

/// @notice Deploys hood.fam v4 on Robinhood Chain 4663: the curve machine, the Bag with its two
///         clocks, the graduation hook, the direct machine, all wired,
///         the presets seeded, then ownership handed to OWNER.
/// @dev The deployer is the owner while it wires the modules and seeds the presets, then hands
///      ownership to OWNER. Use a wallet generated for this project and nothing else.
///
///      On 4663, OWNER and TREASURY must both be a Safe with at least two signers (create it first
///      with `script/DeploySafe.s.sol`). ALLOW_EOA_OWNER=true lifts that, for a rehearsal on a fork
///      and never for the real thing: one key owning the presets and the fee switch is one phished
///      laptop away from owning every future launch. TREASURY is the Bag's house: fixed at the
///      Bag's deploy, never movable, so it is the Safe from the first block.
///
///      The order, and why it is this one. The Bag needs the vault (staking) and its two clocks
///      first. The graduation hook needs the factory, the Bag and the fee router, and
///      its address is mined (a v4 hook's permissions live in the low bits of its address). The
///      factory is told the Bag right after its modules, because it accepts no launch before; the
///      graduator is told the hook while the deployer still owns the factory, because only the
///      owner may name it and `prepare` refuses to open a pool without it. The portal is told the
///      Bag before the factory accepts it. Payday and the burn clock take a keeper
///      from the factory owner: from the deployer here when KEEPER is set, from the Safe later
///      otherwise, and the calls are printed either way.
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
    /// Creators pay this to be seen, on both machines. Owner-settable later, capped at 0.01 ether.
    uint256 internal constant LAUNCH_FEE = 0.002 ether;

    /// @dev Every address lives in storage rather than on the stack: printing them all from one
    ///      frame is what ran the Yul optimizer out of stack slots at the twelfth contract.
    struct Book {
        address bytecode;
        address factory;
        address referrals;
        address staking;
        address feeRouter;
        address firstBuyLocker;
        address graduator;
        address curveRouter;
        address bridge;
        address payday;
        address burnClock;
        address bag;
        address boosts;
        address graduationHook;
        address blockZero;
        address directDeployer;
        address tokenImplementation;
        address portal;
        address buybackModule;
    }

    Book internal book;

    function run() external {
        uint256 pk = vm.envUint("PRIVATE_KEY");
        address owner = vm.envAddress("OWNER");
        address treasury = vm.envAddress("TREASURY");
        address keeper = vm.envOr("KEEPER", address(0));
        address deployer = vm.addr(pk);

        if (block.chainid == 4663 && !vm.envOr("ALLOW_EOA_OWNER", false)) {
            _requireSafe("OWNER", owner);
            _requireSafe("TREASURY", treasury);
        }

        vm.startBroadcast(pk);
        _curveMachine(deployer, treasury);
        _bagMachine(treasury);
        _wireCurve();
        _presets();
        _directMachine(deployer, treasury);
        _keeper(keeper);
        _handOver(owner, deployer);
        vm.stopBroadcast();

        console.log("start block", block.number);
        _printEnv();
    }

    // ---------------------------------------------------------------- the curve machine

    function _curveMachine(address deployer, address treasury) internal {
        HoodDeployer bytecode = new HoodDeployer();
        book.bytecode = address(bytecode);
        console.log("deployer  ", book.bytecode);
        HoodFactory factory = new HoodFactory(deployer, treasury, book.bytecode);
        book.factory = address(factory);
        console.log("factory   ", book.factory);
        bytecode.initialize(book.factory);
        // The referral registry both machines read. Empty at deploy; the owner fills it by hand.
        book.referrals = address(new HoodReferrals(deployer));
        console.log("referrals ", book.referrals);
        factory.setReferrals(book.referrals);
        book.staking = address(new HoodStaking(book.factory));
        console.log("staking   ", book.staking);
        book.feeRouter = address(new HoodFeeRouter(book.factory, book.staking));
        console.log("feeRouter ", book.feeRouter);
        book.firstBuyLocker = address(new HoodTokenLock());
        console.log("firstBuyLock", book.firstBuyLocker);
        book.graduator = address(
            new UniswapV4Graduator(book.factory, POOL_MANAGER, POSITION_MANAGER, UNIVERSAL_ROUTER, PERMIT2, STATE_VIEW)
        );
        console.log("graduator ", book.graduator);
        book.curveRouter = address(new HoodCurveRouter(book.factory, UNIVERSAL_ROUTER));
        console.log("curveRouter", book.curveRouter);
        book.bridge = address(new HoodBridgeFactory(deployer, book.factory, LZ_ENDPOINT));
        console.log("bridge    ", book.bridge);
    }

    // ---------------------------------------------------------------- the Bag and its clocks

    /// @dev Payday and the burn clock first, the Bag that pays them next, then what hangs off the
    ///      Bag: the boosts board and the graduation hook. The Bag has no owner and no setter, so
    ///      `treasury` (the Safe) is its house from the first block.
    function _bagMachine(address treasury) internal {
        book.payday = address(new HoodPayday(book.factory));
        console.log("payday    ", book.payday);
        book.burnClock = address(new HoodBurnClock(book.factory, POOL_MANAGER));
        console.log("burnClock ", book.burnClock);
        book.bag = address(new HoodBag(treasury, book.staking, book.payday, book.burnClock));
        console.log("bag       ", book.bag);
        book.boosts = address(new HoodBoosts(book.factory, book.bag));
        console.log("boosts    ", book.boosts);
        book.graduationHook =
            GraduationHookDeploy.deploy(POOL_MANAGER, book.factory, book.bag, book.feeRouter);
        console.log("gradHook  ", book.graduationHook);
    }

    // ---------------------------------------------------------------- wiring

    function _wireCurve() internal {
        HoodFactory factory = HoodFactory(payable(book.factory));
        factory.setModules(book.feeRouter, book.staking, book.graduator);
        factory.setBag(book.bag);
        // Factory owner only, and before ownership moves: no curve can open a pool without it.
        UniswapV4Graduator(payable(book.graduator)).setHook(book.graduationHook);
        factory.setFirstBuyLocker(book.firstBuyLocker);
        // Block zero: the team launch periphery. No owner, nothing to wire; it reads the factory.
        book.blockZero = address(new HoodBlockZero(book.factory));
        console.log("blockZero ", book.blockZero);
        factory.setLaunchFee(LAUNCH_FEE);

        // Native pair. A ticker locks after this much volume inside 24 hours.
        factory.setPair(address(0), true, 25 ether);
        factory.setPair(USDG, true, 100_000e6);
    }

    /// @dev The 1% platform fee on every curve trade: 70 bps into the Bag (protocol), 30 bps down
    ///      the creator's split. Presets are append-only, so this is the place to change them.
    function _presets() internal {
        HoodFactory factory = HoodFactory(payable(book.factory));

        // Every preset keeps 90% of the raise for the pool: the graduation fee is a flat tenth,
        // 23% of it to the dev and the rest to the burn clock (HoodBag.takeGraduationFee).
        //
        // 0: the standard launch. A billion tokens, four fifths on the curve, 1.1 to 11.025 ETH of
        //    valuation, which raises 4.85 ETH: the pool gets 4.365 and the fee is 0.485.
        factory.addConfig(_preset(address(0), 1.1 ether, 11.025 ether, 9000));
        // 1: the wide launch, for something that expects real size before it graduates.
        factory.addConfig(_preset(address(0), 2 ether, 40 ether, 9000));
        // 2: priced in dollars, so the chart does not move with ETH. The same shape as 0.
        factory.addConfig(_preset(USDG, 5_500e6, 55_125e6, 9000));
    }

    function _preset(address pairToken, uint256 startCap, uint256 graduationCap, uint16 liquidityBps)
        internal
        pure
        returns (CurveConfig memory)
    {
        return CurveConfig({
            pairToken: pairToken,
            totalSupply: 1_000_000_000e18,
            curveSupplyBps: 8000,
            startCap: startCap,
            graduationCap: graduationCap,
            liquidityBps: liquidityBps,
            protocolFeeBps: 30,
            creatorFeeBps: 70,
            poolFee: 3000,
            tickSpacing: 60,
            enabled: true
        });
    }

    // ---------------------------------------------------------------- the direct machine

    /// @dev No curve, the supply is the liquidity from block one.
    function _directMachine(address deployer, address treasury) internal {
        HoodDirectDeployer directDeployer = new HoodDirectDeployer();
        book.directDeployer = address(directDeployer);
        console.log("directDeployer", book.directDeployer);
        book.tokenImplementation = address(new HoodLaunchToken());
        console.log("tokenImpl ", book.tokenImplementation);
        HoodPortal portal = new HoodPortal(
            deployer, treasury, book.directDeployer, book.tokenImplementation, POOL_MANAGER, POSITION_MANAGER, PERMIT2
        );
        book.portal = address(portal);
        console.log("portal    ", book.portal);
        directDeployer.initialize(book.portal);
        book.buybackModule = address(new HoodBuybackModule(POOL_MANAGER, book.portal));
        console.log("buyback   ", book.buybackModule);

        portal.setBuybackModule(book.buybackModule);
        portal.setRegistry(book.factory);
        portal.setReferrals(book.referrals);
        portal.setQuote(USDG, true);
        portal.setBag(book.bag);
        portal.setLaunchFee(LAUNCH_FEE);
        HoodFactory(payable(book.factory)).setPortal(book.portal);
    }

    // ---------------------------------------------------------------- the keeper

    /// @dev The three contracts that take a keeper all ask the factory owner, which is still the
    ///      deployer here. With KEEPER set they are appointed now; otherwise the Safe does it later
    ///      with `npm run safe -- keeper <address>`, which is these same three calls in one batch.
    function _keeper(address keeper) internal {
        if (keeper == address(0)) {
            console.log("PENDING: no KEEPER given; from the Safe, later: npm run safe -- keeper <address>");
            console.log("         = feeRouter.setKeeper(k), payday.setKeeper(k), burnClock.setKeeper(k)");
            return;
        }
        HoodFeeRouter(payable(book.feeRouter)).setKeeper(keeper);
        HoodPayday(payable(book.payday)).setKeeper(keeper);
        HoodBurnClock(payable(book.burnClock)).setKeeper(keeper);
        console.log("keeper    ", keeper);
    }

    // ---------------------------------------------------------------- ownership

    function _handOver(address owner, address deployer) internal {
        if (owner == deployer) return;
        HoodFactory(payable(book.factory)).transferOwnership(owner);
        HoodBridgeFactory(book.bridge).transferOwnership(owner);
        HoodPortal(payable(book.portal)).transferOwnership(owner);
        HoodReferrals(book.referrals).transferOwnership(owner);
        // All four are Ownable2Step: nothing moves until the owner calls acceptOwnership(). The
        // Bag, its clocks, the boosts board and the hook have no owner of their own:
        // the two clocks and the board ask the factory's owner, so they follow the factory.
        // From a Safe that is one batch: `npm run safe -- accept` builds it.
        console.log("PENDING: owner must call acceptOwnership() on factory, bridge, portal and referrals");
        console.log("PENDING: the house coin is unset; launch it, then owner calls staking.setHouseToken(coin)");
        console.log("         and burnClock.setHouseCoin(coin, poolKey): npm run safe -- housecoin ...");
        if (SafeLib.looksLikeSafe(owner)) console.log("         one Safe batch: npm run safe -- accept");
    }

    // ---------------------------------------------------------------- the env block

    /// @dev The lines to paste into .env, in the names the api, the keeper and the app read.
    function _printEnv() internal view {
        console.log("");
        console.log("HOOD_FACTORY=%s", book.factory);
        console.log("HOOD_FEE_ROUTER=%s", book.feeRouter);
        console.log("HOOD_STAKING=%s", book.staking);
        console.log("HOOD_GRADUATOR=%s", book.graduator);
        console.log("HOOD_CURVE_ROUTER=%s", book.curveRouter);
        console.log("HOOD_BRIDGE_FACTORY=%s", book.bridge);
        console.log("HOOD_REFERRALS=%s", book.referrals);
        console.log("HOOD_PORTAL=%s", book.portal);
        console.log("HOOD_DIRECT_DEPLOYER=%s", book.directDeployer);
        console.log("HOOD_TOKEN_IMPLEMENTATION=%s", book.tokenImplementation);
        console.log("HOOD_BUYBACK_MODULE=%s", book.buybackModule);
        console.log("HOOD_BAG=%s", book.bag);
        console.log("HOOD_PAYDAY=%s", book.payday);
        console.log("HOOD_BURN_CLOCK=%s", book.burnClock);
        console.log("HOOD_BOOSTS=%s", book.boosts);
        console.log("HOOD_GRADUATION_HOOK=%s", book.graduationHook);
        console.log("HOOD_BLOCK_ZERO=%s", book.blockZero);
        console.log("HOOD_START_BLOCK=%s", block.number);
    }

    /// @dev A Safe with at least two signers, or the deploy stops before it sends anything.
    function _requireSafe(string memory what, address who) internal view {
        require(SafeLib.looksLikeSafe(who), string.concat(what, " is not a Safe; run script/DeploySafe.s.sol first"));
        uint256 threshold = ISafe(who).getThreshold();
        require(threshold >= 2, string.concat(what, " is a Safe that one key can drive alone"));
        console.log(what, "is a Safe", threshold);
    }
}
