// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
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
import {CurveConfig, FeeModel, LaunchParams} from "../src/HoodTypes.sol";

/// @notice The omnichain leg against the real LayerZero V2 endpoint on 4663.
/// @dev The endpoint on this chain is NOT at the canonical 0x1a44... address. It is at
///      0x6f47...DD5B, eid 30416, which is read off the LayerZero metadata and verified on chain.
///      Run with: forge test --match-path test/ForkLZ.t.sol --fork-url robinhood
contract ForkLZTest is Test {
    using OptionsBuilder for bytes;

    address internal constant LZ_ENDPOINT = 0x6F475642a6e85809B1c36Fa62763669b1b48DD5B;
    address internal constant POOL_MANAGER = 0x8366a39CC670B4001A1121B8F6A443A643e40951;
    address internal constant POSITION_MANAGER = 0x58daec3116aae6D93017bAAea7749052E8a04fA7;
    address internal constant UNIVERSAL_ROUTER = 0x8876789976dEcBfCbBbe364623C63652db8C0904;
    address internal constant PERMIT2 = 0x000000000022D473030F116dDEE9F6B43aC78BA3;
    address internal constant STATE_VIEW = 0xF3334192D15450CdD385c8B70e03f9A6bD9E673b;

    uint32 internal constant EID_ETHEREUM = 30101;
    uint32 internal constant EID_ARBITRUM = 30110;
    uint32 internal constant EID_BASE = 30184;
    uint32 internal constant EID_BNB = 30102;

    address internal constant DVN_LAYERZERO = 0xd01ae6905d48315f7bE10C7330aeCF8360Ef5b12;
    address internal constant DVN_NETHERMIND = 0x0Ffe02DF012299A370D5dd69298A5826EAcaFdF8;
    address internal constant LZ_EXECUTOR = 0x4208D6E27538189bB48E603D6123A94b8Abe0A0b;

    HoodFactory internal factory;
    HoodBridgeFactory internal bridge;
    address internal owner = makeAddr("owner");
    address internal treasury = makeAddr("treasury");
    address internal creator = makeAddr("creator");
    address internal token;
    HoodOFTAdapter internal adapter;

    function setUp() public {
        vm.createSelectFork(vm.rpcUrl("robinhood"));

        HoodDeployer bytecode = new HoodDeployer();
        factory = new HoodFactory(owner, treasury, address(bytecode));
        bytecode.initialize(address(factory));
        HoodStaking staking = new HoodStaking(address(factory));
        HoodFeeRouter feeRouter = new HoodFeeRouter(address(factory), address(staking));
        UniswapV4Graduator graduator = new UniswapV4Graduator(
            address(factory), POOL_MANAGER, POSITION_MANAGER, UNIVERSAL_ROUTER, PERMIT2, STATE_VIEW
        );
        bridge = new HoodBridgeFactory(owner, address(factory), LZ_ENDPOINT);

        vm.startPrank(owner);
        factory.setModules(address(feeRouter), address(staking), address(graduator));
        factory.setLaunchFee(0.0005 ether);
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
        vm.stopPrank();

        vm.deal(creator, 10 ether);
        vm.prank(creator);
        (address t,,) = factory.launch{value: 0.0005 ether + 1 ether}(
            LaunchParams({
                name: "Hood Fam",
                symbol: "FAM",
                image: "ipfs://image",
                description: "the fam",
                website: "https://hood.fam",
                twitter: "@hoodfam",
                telegram: "t.me/hoodfam",
                pairToken: address(0),
                configId: 0,
                feeModel: FeeModel.StakingRewards,
                creatorFeeRecipient: creator,
                firstBuy: 0,
                salt: bytes32(uint256(1)),
                econ: bytes32(0)
            })
        );
        token = t;
        adapter = HoodOFTAdapter(bridge.deployAdapter(token));
    }

    /// @dev What the protocol has to do once per route: name the peer, then say who verifies and
    ///      who delivers. On 4663 the second half is not optional.
    function _openRoute(uint32 eid) internal {
        address[] memory dvns = new address[](1);
        dvns[0] = DVN_LAYERZERO;
        vm.startPrank(owner);
        bridge.setPeer(token, eid, bytes32(uint256(uint160(makeAddr("remoteOFT")))));
        bridge.configureRoute(token, eid, dvns, 15, 10_000, LZ_EXECUTOR);
        vm.stopPrank();
    }

    function test_fork_an_adapter_cannot_send_before_the_protocol_opens_the_route() public {
        bytes memory options = OptionsBuilder.newOptions().addExecutorLzReceiveOption(200_000, 0);
        SendParam memory sp = SendParam({
            dstEid: EID_BASE,
            to: bytes32(uint256(uint160(creator))),
            amountLD: 1e18,
            minAmountLD: 1e18,
            extraOptions: options,
            composeMsg: "",
            oftCmd: ""
        });
        vm.expectRevert();
        adapter.quoteSend(sp, false);
    }

    function test_fork_the_endpoint_on_4663_is_the_one_we_think_it_is() public view {
        (bool ok, bytes memory ret) = LZ_ENDPOINT.staticcall(abi.encodeWithSignature("eid()"));
        assertTrue(ok);
        assertEq(abi.decode(ret, (uint32)), 30416);
        assertEq(address(adapter.endpoint()), LZ_ENDPOINT);
        assertEq(adapter.token(), token);
    }

    function test_fork_a_send_to_base_is_quotable_at_a_real_price() public {
        _openRoute(EID_BASE);

        bytes memory options = OptionsBuilder.newOptions().addExecutorLzReceiveOption(200_000, 0);
        SendParam memory sp = SendParam({
            dstEid: EID_BASE,
            to: bytes32(uint256(uint160(creator))),
            amountLD: 1_000e18,
            minAmountLD: 1_000e18,
            extraOptions: options,
            composeMsg: "",
            oftCmd: ""
        });

        MessagingFee memory fee = adapter.quoteSend(sp, false);
        assertGt(fee.nativeFee, 0, "the route is live and priced");
        assertEq(fee.lzTokenFee, 0);
        emit log_named_uint("fee to Base, wei", fee.nativeFee);
    }

    function test_fork_every_route_we_advertise_is_actually_open() public {
        uint32[4] memory eids = [EID_ETHEREUM, EID_ARBITRUM, EID_BASE, EID_BNB];
        bytes memory options = OptionsBuilder.newOptions().addExecutorLzReceiveOption(200_000, 0);

        for (uint256 i; i < eids.length; ++i) {
            _openRoute(eids[i]);
            MessagingFee memory fee = adapter.quoteSend(
                SendParam({
                    dstEid: eids[i],
                    to: bytes32(uint256(uint160(creator))),
                    amountLD: 1_000e18,
                    minAmountLD: 1_000e18,
                    extraOptions: options,
                    composeMsg: "",
                    oftCmd: ""
                }),
                false
            );
            assertGt(fee.nativeFee, 0);
            emit log_named_uint(string.concat("fee to eid ", vm.toString(eids[i])), fee.nativeFee);
        }
    }

    function test_fork_sending_locks_the_supply_it_does_not_burn_it() public {
        _openRoute(EID_BASE);

        uint256 amount = 1_000e18;
        uint256 supplyBefore = IERC20(token).totalSupply();

        bytes memory options = OptionsBuilder.newOptions().addExecutorLzReceiveOption(200_000, 0);
        SendParam memory sp = SendParam({
            dstEid: EID_BASE,
            to: bytes32(uint256(uint160(creator))),
            amountLD: amount,
            minAmountLD: amount,
            extraOptions: options,
            composeMsg: "",
            oftCmd: ""
        });
        MessagingFee memory fee = adapter.quoteSend(sp, false);

        vm.startPrank(creator);
        IERC20(token).approve(address(adapter), amount);
        vm.deal(creator, fee.nativeFee);
        adapter.send{value: fee.nativeFee}(sp, fee, creator);
        vm.stopPrank();

        assertEq(IERC20(token).balanceOf(address(adapter)), amount, "the tokens are locked, not gone");
        assertEq(IERC20(token).totalSupply(), supplyBefore, "and the supply on 4663 never moves");
    }
}
