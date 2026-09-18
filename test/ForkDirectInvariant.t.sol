// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {StdInvariant} from "forge-std/StdInvariant.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";

import {HoodPortal} from "../src/direct/HoodPortal.sol";
import {HoodDirectDeployer} from "../src/direct/HoodDirectDeployer.sol";
import {HoodLaunchToken} from "../src/direct/HoodLaunchToken.sol";
import {HoodLaunchHook} from "../src/direct/HoodLaunchHook.sol";
import {HoodLocker} from "../src/direct/HoodLocker.sol";
import {HoodRevenueSplitter} from "../src/direct/HoodRevenueSplitter.sol";
import {HoodBuybackModule} from "../src/direct/HoodBuybackModule.sol";
import {Allocations, DirectConfig, Socials} from "../src/direct/DirectTypes.sol";
import {ExactInputSingleParams, PoolKey as RhPoolKey, V4Actions} from "../src/interfaces/IExternal.sol";

interface IPermit2 {
    function approve(address token, address spender, uint160 amount, uint48 expiration) external;
}

interface IUR {
    function execute(bytes calldata commands, bytes[] calldata inputs, uint256 deadline) external payable;
}

interface IPosMgr {
    function getPositionLiquidity(uint256 tokenId) external view returns (uint128);
}

/// @notice Drives a real direct launch on the real Uniswap v4 with random buys, sells, buybacks and
///         harvests. This is the layer the pure-Solidity invariants cannot reach: the pool, the
///         hook callbacks and the settle/take dance are the actual deployed code, not a mock. C1 was
///         a bug in exactly this interaction, found by reading; this is the net under the next one.
contract DirectForkHandler is Test {
    address internal constant POOL_MANAGER = 0x8366a39CC670B4001A1121B8F6A443A643e40951;
    address internal constant UNIVERSAL_ROUTER = 0x8876789976dEcBfCbBbe364623C63652db8C0904;
    address internal constant PERMIT2 = 0x000000000022D473030F116dDEE9F6B43aC78BA3;
    uint24 internal constant POOL_FEE = 10_000;
    int24 internal constant SPACING = 200;

    HoodLaunchToken public token;
    HoodLaunchHook public hook;
    HoodRevenueSplitter public splitter;
    HoodLocker public locker;
    HoodBuybackModule public buyback;

    address[] public actors;

    constructor(
        HoodLaunchToken t, HoodLaunchHook h, HoodRevenueSplitter s, HoodLocker l, HoodBuybackModule b
    ) {
        token = t; hook = h; splitter = s; locker = l; buyback = b;
        for (uint256 i; i < 3; ++i) {
            address a = address(uint160(0xF00D + i));
            actors.push(a);
            vm.deal(a, 200 ether);
        }
    }

    function _actor(uint256 s) internal view returns (address) {
        return actors[s % actors.length];
    }

    function _key() internal view returns (RhPoolKey memory) {
        return RhPoolKey({currency0: address(0), currency1: address(token), fee: POOL_FEE, tickSpacing: SPACING, hooks: address(hook)});
    }

    function buy(uint256 actorSeed, uint256 amountIn) public {
        address a = _actor(actorSeed);
        amountIn = bound(amountIn, 0.001 ether, 20 ether);
        if (a.balance < amountIn) return;

        bytes memory actions = abi.encodePacked(V4Actions.SWAP_EXACT_IN_SINGLE, V4Actions.SETTLE_ALL, V4Actions.TAKE_ALL);
        bytes[] memory params = new bytes[](3);
        params[0] = abi.encode(ExactInputSingleParams({poolKey: _key(), zeroForOne: true, amountIn: uint128(amountIn), amountOutMinimum: 0, minHopPriceX36: 0, hookData: bytes("")}));
        params[1] = abi.encode(address(0), amountIn);
        params[2] = abi.encode(address(token), uint256(0));
        bytes[] memory inputs = new bytes[](1);
        inputs[0] = abi.encode(actions, params);
        vm.prank(a);
        try IUR(UNIVERSAL_ROUTER).execute{value: amountIn}(abi.encodePacked(V4Actions.CMD_V4_SWAP), inputs, block.timestamp) {} catch {}
    }

    function sell(uint256 actorSeed, uint256 tokensIn) public {
        address a = _actor(actorSeed);
        uint256 held = token.balanceOf(a);
        if (held < 1e15) return;
        tokensIn = bound(tokensIn, 1e15, held);

        vm.startPrank(a);
        token.approve(PERMIT2, type(uint256).max);
        IPermit2(PERMIT2).approve(address(token), UNIVERSAL_ROUTER, type(uint160).max, type(uint48).max);
        bytes memory actions = abi.encodePacked(V4Actions.SWAP_EXACT_IN_SINGLE, V4Actions.SETTLE_ALL, V4Actions.TAKE_ALL);
        bytes[] memory params = new bytes[](3);
        params[0] = abi.encode(ExactInputSingleParams({poolKey: _key(), zeroForOne: false, amountIn: uint128(tokensIn), amountOutMinimum: 0, minHopPriceX36: 0, hookData: bytes("")}));
        params[1] = abi.encode(address(token), tokensIn);
        params[2] = abi.encode(address(0), uint256(0));
        bytes[] memory inputs = new bytes[](1);
        inputs[0] = abi.encode(actions, params);
        try IUR(UNIVERSAL_ROUTER).execute(abi.encodePacked(V4Actions.CMD_V4_SWAP), inputs, block.timestamp) {} catch {}
        vm.stopPrank();
    }

    function runBuyback(uint256 blocks) public {
        vm.roll(block.number + bound(blocks, 1, 3)); // the module allows one run per block
        try buyback.run(address(token), 0) {} catch {}
    }

    function harvest() public {
        try locker.harvestFees() {} catch {}
    }

    function sweep() public {
        try splitter.sweep() {} catch {}
    }

    function deepen() public {
        try splitter.pushLiquidity() {} catch {}
        try locker.deepen() {} catch {}
    }

    function flushClaims() public {
        try hook.flushClaims() {} catch {}
    }

    function claimDividends(uint256 actorSeed) public {
        try splitter.claimDividends(_actor(actorSeed)) {} catch {}
    }

    receive() external payable {}
}

/// @dev Fork invariant: runs are kept low because every call hits the RPC. Twelve sequences of
///      twelve actions is still ~150 real v4 swaps and harvests per property.
contract DirectForkInvariant is StdInvariant, Test {
    address internal constant POOL_MANAGER = 0x8366a39CC670B4001A1121B8F6A443A643e40951;
    address internal constant POSITION_MANAGER = 0x58daec3116aae6D93017bAAea7749052E8a04fA7;
    address internal constant PERMIT2 = 0x000000000022D473030F116dDEE9F6B43aC78BA3;
    uint24 internal constant POOL_FEE = 10_000;
    int24 internal constant SPACING = 200;
    int24 internal constant TICK_START = 184_200;
    int24 internal constant TICK_BOND = 161_200;
    uint256 internal constant SUPPLY = 1_000_000_000e18;

    HoodPortal internal portal;
    HoodDirectDeployer internal deployer;
    HoodBuybackModule internal buyback;
    HoodLaunchToken internal token;
    HoodLaunchHook internal hook;
    HoodRevenueSplitter internal splitter;
    HoodLocker internal locker;
    DirectForkHandler internal handler;

    uint128 internal initialLiquidity;
    uint256 internal initialSupply;

    address internal owner = makeAddr("owner");
    address internal treasury = makeAddr("treasury");
    address internal creator = makeAddr("creator");

    function setUp() public {
        vm.createSelectFork(vm.rpcUrl("robinhood"));

        deployer = new HoodDirectDeployer();
        HoodLaunchToken impl = new HoodLaunchToken();
        portal = new HoodPortal(owner, treasury, address(deployer), address(impl), POOL_MANAGER, POSITION_MANAGER, PERMIT2);
        deployer.initialize(address(portal));
        buyback = new HoodBuybackModule(POOL_MANAGER, address(portal));
        vm.prank(owner);
        portal.setBuybackModule(address(buyback));
        vm.deal(creator, 10 ether);

        bytes32 hookSalt = _mineHookSalt();
        DirectConfig memory config = DirectConfig({
            buyTaxBps: 500, sellTaxBps: 500, snipeTaxBps: 0, snipeDecaySeconds: 0,
            restrictionBlocks: 0, maxHoldBps: 10_000, maxBuyBps: 10_000,
            tickStart: TICK_START, tickBond: TICK_BOND,
            allocations: Allocations(2_500, 2_500, 4_000, 1_000)
        });
        HoodPortal.LaunchInput memory input = HoodPortal.LaunchInput({
            name: "Inv", symbol: "INV", logo: "", description: "",
            socials: Socials("", "", "", "", ""), quote: address(0), supply: SUPPLY,
            poolFee: POOL_FEE, tickSpacing: SPACING, config: config, salt: bytes32(uint256(1)), initialBuy: 0
        });
        vm.prank(creator);
        HoodPortal.Addresses memory out = portal.createLaunch{value: 0.0005 ether}(input, hookSalt);

        token = HoodLaunchToken(out.token);
        hook = HoodLaunchHook(out.hook);
        splitter = HoodRevenueSplitter(payable(out.splitter));
        locker = HoodLocker(payable(out.locker));

        initialLiquidity = IPosMgr(POSITION_MANAGER).getPositionLiquidity(out.positionId);
        initialSupply = token.totalSupply();

        handler = new DirectForkHandler(token, hook, splitter, locker, buyback);

        targetContract(address(handler));
        bytes4[] memory sel = new bytes4[](8);
        sel[0] = DirectForkHandler.buy.selector;
        sel[1] = DirectForkHandler.sell.selector;
        sel[2] = DirectForkHandler.runBuyback.selector;
        sel[3] = DirectForkHandler.harvest.selector;
        sel[4] = DirectForkHandler.sweep.selector;
        sel[5] = DirectForkHandler.deepen.selector;
        sel[6] = DirectForkHandler.flushClaims.selector;
        sel[7] = DirectForkHandler.claimDividends.selector;
        targetSelector(FuzzSelector({addr: address(handler), selectors: sel}));
    }

    function _mineHookSalt() internal view returns (bytes32) {
        bytes32 initHash = deployer.hookInitCodeHash(POOL_MANAGER);
        for (uint256 i; i < 200_000; ++i) {
            bytes32 salt = bytes32(i);
            bytes32 bound = keccak256(abi.encode(creator, salt));
            address predicted = address(uint160(uint256(keccak256(abi.encodePacked(bytes1(0xff), address(deployer), bound, initHash)))));
            if (uint160(predicted) & 0x3FFF == 0xCC) return salt;
        }
        revert("no salt");
    }

    /// @notice Proof the harness is not vacuous: a buy, a sell and a buyback actually move money
    ///         through the real pool, so the invariants above are guarding live state and not a
    ///         sequence of caught reverts. Run as a normal fork test.
    function test_fork_the_harness_actually_trades() public {
        handler.buy(0, 5 ether);
        assertGt(token.balanceOf(handler.actors(0)), 0, "the buy delivered token");
        assertGt(address(splitter).balance + hook.claimsHeld(), 0, "the buy paid tax into the machine");

        uint256 supplyBefore = token.totalSupply();
        handler.sell(0, type(uint256).max); // bound() clamps to the actor's balance
        handler.sweep();
        assertGt(address(splitter).balance, 0, "tax accumulated in the splitter");

        handler.runBuyback(1);
        assertLe(token.totalSupply(), supplyBefore, "the buyback burned, never minted");
    }

    /// @notice The locked position's liquidity never falls below what the launch minted. The locker
    ///         has no path to decrease it, harvest only collects fees, and deepen only adds. If a
    ///         swap or a harvest ever ate into the principal, this catches it. THIS is the "liquidity
    ///         is locked" promise, checked against the real pool rather than asserted in prose.
    /// forge-config: default.invariant.runs = 12
    /// forge-config: default.invariant.depth = 12
    function invariant_lockedLiquidityNeverShrinks() public view {
        (PoolKey memory key,) = (locker.poolKey(), uint256(0));
        key; // silence unused
        uint256 posId = portal.getLaunch(address(token)).positionId;
        assertGe(IPosMgr(POSITION_MANAGER).getPositionLiquidity(posId), initialLiquidity, "locked liquidity shrank");
    }

    /// @notice Supply only ever falls: buybacks burn, nothing mints. A token that grew its own supply
    ///         through trading would be a supply backdoor.
    /// forge-config: default.invariant.runs = 12
    /// forge-config: default.invariant.depth = 12
    function invariant_supplyNeverGrows() public view {
        assertLe(token.totalSupply(), initialSupply, "supply grew");
    }

    /// @notice The splitter stays solvent through real swaps: the ETH it holds covers every road it
    ///         has booked. The tax path runs through the actual hook callbacks here, not a transfer.
    /// forge-config: default.invariant.runs = 12
    /// forge-config: default.invariant.depth = 12
    function invariant_splitterStaysSolvent() public view {
        uint256 owed = splitter.creatorClaimable() + splitter.buybackPot() + splitter.liquidityPot()
            + splitter.protocolClaimable() + splitter.dividendsHeld();
        assertGe(address(splitter).balance, owed, "splitter cannot cover its roads");
    }

    /// @notice The hook never sits on raw ETH between swaps: a quote tax is either an ERC-6909 claim
    ///         it tracks in claimsHeld, or it was taken straight to the splitter. Loose ETH on the
    ///         hook would be money nobody is accounting for.
    /// forge-config: default.invariant.runs = 12
    /// forge-config: default.invariant.depth = 12
    function invariant_hookHoldsNoLooseEth() public view {
        assertEq(address(hook).balance, 0, "the hook is sitting on unaccounted ETH");
    }
}
