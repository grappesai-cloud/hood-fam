// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";

import {HoodFactory} from "../src/HoodFactory.sol";
import {HoodDeployer} from "../src/HoodDeployer.sol";
import {HoodCurve} from "../src/HoodCurve.sol";
import {HoodFeeRouter} from "../src/HoodFeeRouter.sol";
import {HoodStaking} from "../src/HoodStaking.sol";
import {CurveConfig, FeeSplit, LaunchParams} from "../src/HoodTypes.sol";
import {MockGraduator, MockUSD} from "./mocks/Mocks.sol";

/// @notice Shared rig: one launchpad, one preset, helpers to launch and to trade.
contract BaseTest is Test {
    HoodFactory internal factory;
    HoodStaking internal staking;
    HoodFeeRouter internal router;
    MockGraduator internal graduator;
    MockUSD internal usd;

    address internal owner = makeAddr("owner");
    address internal treasury = makeAddr("treasury");
    address internal creator = makeAddr("creator");
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");

    uint256 internal configId;
    uint256 internal constant LAUNCH_FEE = 0.0005 ether;

    function setUp() public virtual {
        HoodDeployer bytecode = new HoodDeployer();
        factory = new HoodFactory(owner, treasury, address(bytecode));
        bytecode.initialize(address(factory));
        staking = new HoodStaking(address(factory));
        router = new HoodFeeRouter(address(factory), address(staking));
        graduator = new MockGraduator(address(factory));
        usd = new MockUSD();

        vm.startPrank(owner);
        factory.setModules(address(router), address(staking), address(graduator));
        factory.setLaunchFee(LAUNCH_FEE);
        configId = factory.addConfig(_config());
        factory.setPair(address(0), true, 100 ether); // lock a ticker after 100 ETH in 24h
        factory.setPair(address(usd), true, 0);
        vm.stopPrank();

        vm.deal(alice, 1000 ether);
        vm.deal(bob, 1000 ether);
        vm.deal(creator, 1000 ether);
    }

    function _config() internal pure returns (CurveConfig memory) {
        return CurveConfig({
            totalSupply: 1_000_000_000e18,
            curveSupplyBps: 8000,
            startCap: 1 ether, // fully diluted valuation at the first token
            graduationCap: 10 ether, // and at the last curve token
            liquidityBps: 9000,
            protocolFeeBps: 30,
            creatorFeeBps: 70,
            poolFee: 3000,
            tickSpacing: 60,
            enabled: true
        });
    }

    /// @notice The four splits that send the whole creator leg down one road. Most of the suite
    ///         wants one destination at a time; `_split` is there for the mixtures.
    function _toStakers() internal pure returns (FeeSplit memory) {
        return _split(10_000, 0, 0, 0);
    }

    function _toBuyback() internal pure returns (FeeSplit memory) {
        return _split(0, 10_000, 0, 0);
    }

    function _toLiquidity() internal pure returns (FeeSplit memory) {
        return _split(0, 0, 10_000, 0);
    }

    function _toCreator() internal pure returns (FeeSplit memory) {
        return _split(0, 0, 0, 10_000);
    }

    function _split(uint16 stakers, uint16 buyback, uint16 liquidity, uint16 creatorBps)
        internal
        pure
        returns (FeeSplit memory)
    {
        return FeeSplit({
            stakersBps: stakers,
            buybackBps: buyback,
            liquidityBps: liquidity,
            creatorBps: creatorBps
        });
    }

    function _params(FeeSplit memory split) internal view returns (LaunchParams memory p) {
        p = LaunchParams({
            name: "Hood Fam",
            symbol: "FAM",
            image: "ipfs://image",
            description: "the fam",
            website: "https://hood.fam",
            twitter: "@hoodfam",
            telegram: "t.me/hoodfam",
            pairToken: address(0),
            configId: configId,
            feeSplit: split,
            creatorFeeRecipient: creator,
            firstBuy: 0,
            firstBuyLock: 0,
            salt: bytes32(uint256(1)),
            econ: bytes32(0)
        });
    }

    function _launch(FeeSplit memory split) internal returns (address token, HoodCurve curve) {
        return _launch(split, _params(split), LAUNCH_FEE);
    }

    function _launch(FeeSplit memory split, LaunchParams memory p, uint256 value)
        internal
        returns (address token, HoodCurve curve)
    {
        p.feeSplit = split;
        vm.prank(creator);
        (address t, address c,) = factory.launch{value: value}(p);
        return (t, HoodCurve(payable(c)));
    }

    function _buy(HoodCurve curve, address who, uint256 amount) internal returns (uint256) {
        vm.prank(who);
        return curve.buy{value: amount}(amount, 0, who);
    }

    /// @notice Buys the curve out and opens the pool.
    function _graduate(HoodCurve curve) internal {
        uint256 left = curve.remaining();
        (uint256 needed,) = curve.quoteBuyExactOut(left);
        vm.deal(bob, needed + 1 ether);
        vm.prank(bob);
        curve.buyExactOut{value: needed}(left, needed, bob);
        curve.finalize();
    }
}
