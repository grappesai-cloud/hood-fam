// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {Test} from "forge-std/Test.sol";
import {BagRig} from "./helpers/BagRig.sol";
import {HoodBag} from "../src/bag/HoodBag.sol";
import {HoodGraduationHook} from "../src/graduation/HoodGraduationHook.sol";
import {StdInvariant} from "forge-std/StdInvariant.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {HoodFactory} from "../src/HoodFactory.sol";
import {HoodDeployer} from "../src/HoodDeployer.sol";
import {HoodCurve} from "../src/HoodCurve.sol";
import {HoodFeeRouter} from "../src/HoodFeeRouter.sol";
import {HoodStaking} from "../src/HoodStaking.sol";
import {UniswapV4Graduator} from "../src/graduation/UniswapV4Graduator.sol";
import {CurveConfig, FeeSplit, LaunchParams, Phase} from "../src/HoodTypes.sol";
import {IPoolManager, PoolKey, SwapParams} from "../src/interfaces/IExternal.sol";

interface IStateView {
    function getSlot0(bytes32 poolId) external view returns (uint160, int24, uint24, uint24);
    function getLiquidity(bytes32 poolId) external view returns (uint128);
}

/// @notice Moves the price of an EMPTY v4 pool with a one-wei swap. This is the C1 attack in one
///         contract: in a pool with no liquidity a swap fills nothing and lands on its limit, so
///         anyone can walk the pre-opened graduation pool to any price for the cost of gas. The
///         handler uses it to try to make graduation mint the raise at a price of the attacker's
///         choosing; the invariant proves it cannot.
contract EmptyPoolNudger {
    IPoolManager public immutable pm;

    constructor(address pm_) {
        pm = IPoolManager(pm_);
    }

    function nudge(PoolKey memory key, bool zeroForOne, uint160 limit) external {
        try pm.unlock(abi.encode(key, zeroForOne, limit)) {} catch {}
    }

    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        require(msg.sender == address(pm), "only pm");
        (PoolKey memory key, bool zeroForOne, uint160 limit) = abi.decode(data, (PoolKey, bool, uint160));
        pm.swap(key, SwapParams({zeroForOne: zeroForOne, amountSpecified: -1, sqrtPriceLimitX96: limit}), bytes(""));
        return bytes("");
    }
}

contract CurveGradHandler is Test {
    HoodCurve public curve;
    IERC20 public token;
    EmptyPoolNudger public nudger;
    PoolKey public poolKey;

    uint160 internal constant MIN_SQRT = 4295128739;
    uint160 internal constant MAX_SQRT = 1461446703485210103287273052203988822378723970342;

    address[] public actors;
    bool public graduatedSeen;

    constructor(HoodCurve c, address t, EmptyPoolNudger n, PoolKey memory key) {
        curve = c; token = IERC20(t); nudger = n; poolKey = key;
        for (uint256 i; i < 3; ++i) {
            address a = address(uint160(0xBEEF + i));
            actors.push(a);
            vm.deal(a, 500 ether);
        }
    }

    function _actor(uint256 s) internal view returns (address) {
        return actors[s % actors.length];
    }

    function buy(uint256 actorSeed, uint256 pairIn) public {
        if (curve.phase() != Phase.Curve) return;
        address a = _actor(actorSeed);
        pairIn = bound(pairIn, 0.01 ether, a.balance > 100 ether ? 100 ether : a.balance);
        vm.prank(a);
        try curve.buy{value: pairIn}(pairIn, 0, a) {} catch {}
    }

    function sell(uint256 actorSeed, uint256 tokensIn) public {
        if (curve.phase() != Phase.Curve) return;
        address a = _actor(actorSeed);
        uint256 held = token.balanceOf(a);
        if (held == 0) return;
        tokensIn = bound(tokensIn, 1, held);
        vm.startPrank(a);
        token.approve(address(curve), tokensIn);
        try curve.sell(tokensIn, 0, a) {} catch {}
        vm.stopPrank();
    }

    /// The attack: shove the pre-opened, still-empty pool to an extreme price before graduation.
    function nudgePool(bool up) public {
        nudger.nudge(poolKey, !up, up ? MAX_SQRT - 1 : MIN_SQRT + 1);
    }

    /// Anyone may graduate a sold-out curve. The fuzzer will do it after having tried to nudge.
    function finalize() public {
        if (curve.phase() != Phase.Sold) return;
        try curve.finalize() { graduatedSeen = true; } catch {}
    }

    receive() external payable {}
}

/// @dev Fuzzes the exact C1 surface against real Uniswap v4: buy a curve out, try to poison the
///      pre-opened pool's price, then graduate, and prove the raise still lands in the pool at the
///      price the raise implies.
contract ForkCurveGradInvariant is StdInvariant, BagRig {
    address internal constant POOL_MANAGER = 0x8366a39CC670B4001A1121B8F6A443A643e40951;
    address internal constant POSITION_MANAGER = 0x58daec3116aae6D93017bAAea7749052E8a04fA7;
    address internal constant UNIVERSAL_ROUTER = 0x8876789976dEcBfCbBbe364623C63652db8C0904;
    address internal constant PERMIT2 = 0x000000000022D473030F116dDEE9F6B43aC78BA3;
    address internal constant STATE_VIEW = 0xF3334192D15450CdD385c8B70e03f9A6bD9E673b;

    HoodFactory internal factory;
    HoodStaking internal staking;
    HoodFeeRouter internal router;
    UniswapV4Graduator internal graduator;
    HoodBag internal bag;
    HoodGraduationHook internal hook;
    HoodCurve internal curve;
    address internal token;
    CurveGradHandler internal handler;

    uint256 internal raiseTarget;
    uint256 internal lpSupply;
    bytes32 internal poolId;

    address internal owner = makeAddr("owner");
    address internal treasury = makeAddr("treasury");
    address internal creator = makeAddr("creator");

    function setUp() public {
        vm.createSelectFork(vm.rpcUrl("robinhood"));

        HoodDeployer bytecode = new HoodDeployer();
        factory = new HoodFactory(owner, treasury, address(bytecode));
        bytecode.initialize(address(factory));
        staking = new HoodStaking(address(factory));
        router = new HoodFeeRouter(address(factory), address(staking));
        graduator = new UniswapV4Graduator(address(factory), POOL_MANAGER, POSITION_MANAGER, UNIVERSAL_ROUTER, PERMIT2, STATE_VIEW);
        (bag,,) = _bagStack(address(factory), treasury, address(staking), POOL_MANAGER);
        hook = _graduationHook(POOL_MANAGER, address(factory), address(bag), address(router));

        vm.startPrank(owner);
        factory.setModules(address(router), address(staking), address(graduator));
        factory.setBag(address(bag));
        graduator.setHook(address(hook));
        factory.setLaunchFee(0);
        uint256 configId = factory.addConfig(CurveConfig({
            pairToken: address(0),
            totalSupply: 1_000_000_000e18, curveSupplyBps: 8000, startCap: 1 ether,
            graduationCap: 10 ether, liquidityBps: 9000, protocolFeeBps: 30, creatorFeeBps: 70,
            poolFee: 3000, tickSpacing: 60, enabled: true
        }));
        vm.stopPrank();

        LaunchParams memory p;
        // A whole creator leg is what C1 could rug through: on C1 the raise leaks to the fee router and
        // out to the creator. Using it makes the invariant fail loudly if the fix ever regresses.
        p.name = "Grad"; p.symbol = "GRAD"; p.pairToken = address(0); p.configId = configId;
        p.feeSplit = FeeSplit({stakersBps: 0, buybackBps: 0, liquidityBps: 0, creatorBps: 10_000}); p.creatorFeeRecipient = creator; p.salt = bytes32(uint256(1));
        vm.prank(creator);
        (token,,) = factory.launch(p);
        vm.warp(block.timestamp + 3); // past the opening tax (SnipeSchedule)
        curve = HoodCurve(payable(factory.getLaunch(token).curve));
        raiseTarget = curve.raiseTarget();
        lpSupply = curve.lpSupply();

        // Every graduated pool carries the graduation hook now, so the key the nudger and the
        // invariant look at names it. Before graduation the hook refuses swaps on the unregistered
        // pool, which is one more wall in front of the C1 attack; the nudger swallows the revert.
        PoolKey memory key = PoolKey({
            currency0: address(0), currency1: token, fee: 3000, tickSpacing: 60, hooks: address(hook)
        });
        poolId = keccak256(abi.encode(key));

        EmptyPoolNudger nudger = new EmptyPoolNudger(POOL_MANAGER);
        handler = new CurveGradHandler(curve, token, nudger, key);

        targetContract(address(handler));
        bytes4[] memory sel = new bytes4[](4);
        sel[0] = CurveGradHandler.buy.selector;
        sel[1] = CurveGradHandler.sell.selector;
        sel[2] = CurveGradHandler.nudgePool.selector;
        sel[3] = CurveGradHandler.finalize.selector;
        targetSelector(FuzzSelector({addr: address(handler), selectors: sel}));
    }

    /// @notice The C1 attack, reproduced deterministically and shown defeated: buy the curve out,
    ///         shove the pre-opened empty pool to the price floor, then graduate. On the bug the
    ///         raise would leak to the fee router (and CreatorKeep would pay it to the creator); the
    ///         fix reprices the empty pool back, so the raise lands in the pool. Also proves the
    ///         fuzz invariants above are not vacuous: graduation really happens here.
    function test_fork_a_poisoned_empty_pool_cannot_steal_the_raise() public {
        EmptyPoolNudger nudger = new EmptyPoolNudger(POOL_MANAGER);
        PoolKey memory key = PoolKey({currency0: address(0), currency1: token, fee: 3000, tickSpacing: 60, hooks: address(0)});

        // buy the whole curve out
        uint256 left = curve.remaining();
        (uint256 needed,) = curve.quoteBuyExactOut(left);
        vm.deal(address(this), needed + 1 ether);
        curve.buyExactOut{value: needed}(left, needed, address(this));
        assertEq(uint8(curve.phase()), uint8(Phase.Sold), "sold out");

        // poison the empty pre-opened pool: walk its price to the floor for the cost of gas
        nudger.nudge(key, true, 4295128739 + 1);

        uint256 creatorBefore = creator.balance;
        uint256 devBonus = ((curve.reserve() - Math.mulDiv(curve.reserve(), 9000, 10_000)) * 2_300) / 10_000;
        curve.finalize();

        // the raise is in the pool, the creator got nothing extra, the fee router did not get the raise
        assertGt(IStateView(STATE_VIEW).getLiquidity(poolId), 0, "pool funded");
        assertApproxEqRel(IERC20(token).balanceOf(POOL_MANAGER), lpSupply, 0.02e18, "supply in the pool");
        assertLt(router.accrued(token), raiseTarget / 10, "raise did not leak");
        assertEq(creator.balance - creatorBefore, devBonus, "the creator got the dev bonus and nothing else");
    }

    /// @notice Once the curve has graduated, the raise is in the POOL and not in the fee router.
    ///         This is C1, inverted into a property: on the bug, a nudged empty pool made graduation
    ///         mint almost nothing on the pair side and sweep the raise out to the fee router (and,
    ///         on CreatorKeep, on to the creator). If it holds through every fuzzed nudge, C1 stays
    ///         fixed. The pool must be initialised, hold real liquidity, and the fee router must
    ///         hold nowhere near the raise.
    /// forge-config: default.invariant.runs = 16
    /// forge-config: default.invariant.depth = 16
    function invariant_graduationPutsTheRaiseInThePool() public view {
        if (!handler.graduatedSeen() || curve.phase() != Phase.Graduated) return;
        assertGt(IStateView(STATE_VIEW).getLiquidity(poolId), 0, "graduated pool has no liquidity");
        assertApproxEqRel(IERC20(token).balanceOf(POOL_MANAGER), lpSupply, 0.02e18, "the supply did not reach the pool");
        // On C1 the raise leaks here. A healthy graduation only leaves a rounding sliver.
        assertLt(router.accrued(token), raiseTarget / 10, "the raise leaked to the fee router");
    }

    /// @notice The graduator never keeps leftovers: no token and no pair sit on it. Any that would
    ///         is burned or booked, so it is never a balance somebody can take.
    /// forge-config: default.invariant.runs = 16
    /// forge-config: default.invariant.depth = 16
    function invariant_graduatorHoldsNothing() public view {
        if (!handler.graduatedSeen()) return;
        assertEq(IERC20(token).balanceOf(address(graduator)), 0, "token stuck on the graduator");
        assertEq(address(graduator).balance, 0, "pair stuck on the graduator");
    }
}
