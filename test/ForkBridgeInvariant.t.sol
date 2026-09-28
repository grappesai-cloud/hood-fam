// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {BagRig} from "./helpers/BagRig.sol";
import {HoodBag} from "../src/bag/HoodBag.sol";
import {HoodGraduationHook} from "../src/graduation/HoodGraduationHook.sol";
import {StdInvariant} from "forge-std/StdInvariant.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SendParam, MessagingFee} from "@layerzerolabs/oft-evm/contracts/interfaces/IOFT.sol";
import {OptionsBuilder} from "@layerzerolabs/oapp-evm/contracts/oapp/libs/OptionsBuilder.sol";

import {HoodFactory} from "../src/HoodFactory.sol";
import {HoodDeployer} from "../src/HoodDeployer.sol";
import {HoodCurve} from "../src/HoodCurve.sol";
import {HoodFeeRouter} from "../src/HoodFeeRouter.sol";
import {HoodStaking} from "../src/HoodStaking.sol";
import {HoodBridgeFactory} from "../src/omnichain/HoodBridgeFactory.sol";
import {HoodOFTAdapter} from "../src/omnichain/HoodOFTAdapter.sol";
import {UniswapV4Graduator} from "../src/graduation/UniswapV4Graduator.sol";
import {CurveConfig, FeeSplit, LaunchParams} from "../src/HoodTypes.sol";

/// @notice Sends a launched token out over the real LayerZero endpoint, again and again, from a pool
///         of holders. Every send locks tokens in the adapter; the invariant is that the canonical
///         supply on 4663 never moves and the lock box holds exactly what has left the local float.
///         A mint backdoor -- the thing the token deliberately does not have -- would break both.
contract BridgeHandler is Test {
    using OptionsBuilder for bytes;

    IERC20 public token;
    HoodOFTAdapter public adapter;
    uint32 public eid;

    address[] public actors;
    uint256 public sentOut; // sum of everything ever locked into the adapter, in local decimals

    constructor(address token_, HoodOFTAdapter adapter_, uint32 eid_, address[] memory holders) {
        token = IERC20(token_);
        adapter = adapter_;
        eid = eid_;
        actors = holders;
    }

    function _actor(uint256 s) internal view returns (address) {
        return actors[s % actors.length];
    }

    /// A cross-chain send: lock `amount` of the token in the adapter for a peer on `eid`.
    /// @dev Shared decimals are 6 by default in the OFT stack, so amounts are rounded to 1e12 to
    ///      avoid the dust the codec would strip (which would make locked != sent by a few wei and
    ///      is not what this invariant is about).
    function send(uint256 actorSeed, uint256 amount) public {
        address a = _actor(actorSeed);
        uint256 held = token.balanceOf(a);
        if (held < 1e12) return;
        amount = bound(amount, 1e12, held);
        amount = (amount / 1e12) * 1e12;
        if (amount == 0) return;

        bytes memory options = OptionsBuilder.newOptions().addExecutorLzReceiveOption(200_000, 0);
        SendParam memory sp = SendParam({
            dstEid: eid, to: bytes32(uint256(uint160(a))), amountLD: amount, minAmountLD: amount,
            extraOptions: options, composeMsg: "", oftCmd: ""
        });
        MessagingFee memory fee;
        try adapter.quoteSend(sp, false) returns (MessagingFee memory f) { fee = f; } catch { return; }

        vm.startPrank(a);
        token.approve(address(adapter), amount);
        vm.deal(a, a.balance + fee.nativeFee);
        try adapter.send{value: fee.nativeFee}(sp, fee, a) { sentOut += amount; } catch {}
        vm.stopPrank();
    }

    function actorCount() external view returns (uint256) {
        return actors.length;
    }
}

/// @dev Fork invariant over the LayerZero send path. Runs are low: every send is a real endpoint
///      dispatch. The RECEIVE (unlock) path needs the far chain and lives in the two-chain harness;
///      what this proves is the half a mint backdoor would attack: locking never inflates 4663.
contract ForkBridgeInvariant is StdInvariant, BagRig {
    address internal constant LZ_ENDPOINT = 0x6F475642a6e85809B1c36Fa62763669b1b48DD5B;
    address internal constant POOL_MANAGER = 0x8366a39CC670B4001A1121B8F6A443A643e40951;
    address internal constant POSITION_MANAGER = 0x58daec3116aae6D93017bAAea7749052E8a04fA7;
    address internal constant UNIVERSAL_ROUTER = 0x8876789976dEcBfCbBbe364623C63652db8C0904;
    address internal constant PERMIT2 = 0x000000000022D473030F116dDEE9F6B43aC78BA3;
    address internal constant STATE_VIEW = 0xF3334192D15450CdD385c8B70e03f9A6bD9E673b;
    address internal constant DVN_LAYERZERO = 0xd01ae6905d48315f7bE10C7330aeCF8360Ef5b12;
    address internal constant LZ_EXECUTOR = 0x4208D6E27538189bB48E603D6123A94b8Abe0A0b;
    uint32 internal constant EID_BASE = 30184;

    HoodFactory internal factory;
    HoodBridgeFactory internal bridge;
    HoodOFTAdapter internal adapter;
    address internal token;
    BridgeHandler internal handler;
    uint256 internal launchedSupply;

    address internal owner = makeAddr("owner");
    address internal treasury = makeAddr("treasury");
    address internal creator = makeAddr("creator");

    function setUp() public {
        vm.createSelectFork(vm.rpcUrl("robinhood"));

        HoodDeployer bytecode = new HoodDeployer();
        factory = new HoodFactory(owner, treasury, address(bytecode));
        bytecode.initialize(address(factory));
        HoodStaking staking = new HoodStaking(address(factory));
        HoodFeeRouter feeRouter = new HoodFeeRouter(address(factory), address(staking));
        UniswapV4Graduator graduator = new UniswapV4Graduator(address(factory), POOL_MANAGER, POSITION_MANAGER, UNIVERSAL_ROUTER, PERMIT2, STATE_VIEW);
        bridge = new HoodBridgeFactory(owner, address(factory), LZ_ENDPOINT);
        (HoodBag bag,,) = _bagStack(address(factory), treasury, address(staking), POOL_MANAGER);
        HoodGraduationHook hook =
            _graduationHook(POOL_MANAGER, address(factory), address(bag), address(feeRouter));

        vm.startPrank(owner);
        factory.setModules(address(feeRouter), address(staking), address(graduator));
        factory.setBag(address(bag));
        graduator.setHook(address(hook));
        factory.setLaunchFee(0);
        factory.addConfig(CurveConfig({
            pairToken: address(0),
            totalSupply: 1_000_000_000e18, curveSupplyBps: 8000, startCap: 1 ether,
            graduationCap: 10 ether, liquidityBps: 9000, protocolFeeBps: 70, creatorFeeBps: 30,
            poolFee: 3000, tickSpacing: 60, enabled: true
        }));
        vm.stopPrank();

        LaunchParams memory p;
        p.name = "Bridge"; p.symbol = "BRDG"; p.pairToken = address(0); p.configId = 0;
        p.feeSplit = FeeSplit({stakersBps: 0, buybackBps: 0, liquidityBps: 0, creatorBps: 10_000}); p.creatorFeeRecipient = creator; p.salt = bytes32(uint256(1));
        vm.prank(creator);
        (token,,) = factory.launch(p);
        launchedSupply = IERC20(token).totalSupply();

        adapter = HoodOFTAdapter(bridge.deployAdapter(token));
        address[] memory dvns = new address[](1);
        dvns[0] = DVN_LAYERZERO;
        vm.startPrank(owner);
        bridge.setPeer(token, EID_BASE, bytes32(uint256(uint160(makeAddr("remoteOFT")))));
        bridge.configureRoute(token, EID_BASE, dvns, 15, 10_000, LZ_EXECUTOR);
        vm.stopPrank();

        // Buy the whole curve out and spread the token to actors so they have something to bridge.
        HoodCurve curve = HoodCurve(payable(factory.getLaunch(token).curve));
        vm.deal(address(this), 10_000 ether);
        curve.buy{value: 5_000 ether}(5_000 ether, 0, address(this));
        address[] memory holders = new address[](3);
        uint256 bal = IERC20(token).balanceOf(address(this));
        for (uint256 i; i < 3; ++i) {
            holders[i] = address(uint160(0xB41D6E + i));
            IERC20(token).transfer(holders[i], bal / 4);
        }

        handler = new BridgeHandler(token, adapter, EID_BASE, holders);

        targetContract(address(handler));
        bytes4[] memory sel = new bytes4[](1);
        sel[0] = BridgeHandler.send.selector;
        targetSelector(FuzzSelector({addr: address(handler), selectors: sel}));
    }

    receive() external payable {}

    /// @notice Proof the harness actually bridges, so the invariants above guard real sends and not
    ///         a run of caught reverts: one send locks tokens and leaves the supply put.
    function test_fork_the_bridge_harness_actually_sends() public {
        uint256 supplyBefore = IERC20(token).totalSupply();
        handler.send(0, 1_000e18);
        assertGt(handler.sentOut(), 0, "a send went through");
        assertEq(IERC20(token).balanceOf(address(adapter)), handler.sentOut(), "and it locked exactly that");
        assertEq(IERC20(token).totalSupply(), supplyBefore, "the supply did not move");
    }

    /// @notice The canonical supply on 4663 never moves, whatever gets bridged. The token has no
    ///         mint function; a lock box that travels by locking rather than minting is the whole
    ///         point, and this proves no send path inflates the supply. A mint backdoor breaks here.
    /// forge-config: default.invariant.runs = 12
    /// forge-config: default.invariant.depth = 10
    function invariant_canonicalSupplyIsImmutable() public view {
        assertEq(IERC20(token).totalSupply(), launchedSupply, "the 4663 supply moved");
    }

    /// @notice The lock box holds exactly what has left the local float: everything ever sent out is
    ///         locked in the adapter, to the wei. If the adapter ever held less than was sent, the
    ///         remote mint would be minting against nothing; if more, it locked tokens that never
    ///         went anywhere. Locked == owed to remote holders.
    /// forge-config: default.invariant.runs = 12
    /// forge-config: default.invariant.depth = 10
    function invariant_lockedEqualsSent() public view {
        assertEq(IERC20(token).balanceOf(address(adapter)), handler.sentOut(), "locked drifted from sent");
    }

    /// @notice The adapter can never lock more than the whole supply: the amount abroad is always a
    ///         slice of what exists, never a phantom balance.
    /// forge-config: default.invariant.runs = 12
    /// forge-config: default.invariant.depth = 10
    function invariant_lockedNeverExceedsSupply() public view {
        assertLe(IERC20(token).balanceOf(address(adapter)), IERC20(token).totalSupply(), "locked exceeds supply");
    }
}
