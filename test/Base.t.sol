// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {HoodFactory} from "../src/HoodFactory.sol";
import {HoodDeployer} from "../src/HoodDeployer.sol";
import {HoodCurve} from "../src/HoodCurve.sol";
import {HoodFeeRouter} from "../src/HoodFeeRouter.sol";
import {HoodStaking} from "../src/HoodStaking.sol";
import {HoodTokenLock} from "../src/HoodTokenLock.sol";
import {CurveConfig, FeeSplit, LaunchParams} from "../src/HoodTypes.sol";
import {MockGraduator, MockUSD} from "./mocks/Mocks.sol";

/// @notice Shared rig: one launchpad, one preset, helpers to launch and to trade.
contract BaseTest is Test {
    HoodFactory internal factory;
    HoodStaking internal staking;
    HoodFeeRouter internal router;
    HoodTokenLock internal locker;
    MockGraduator internal graduator;
    MockUSD internal usd;

    address internal owner = makeAddr("owner");
    address internal treasury = makeAddr("treasury");
    address internal creator = makeAddr("creator");
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");

    address internal house;
    HoodCurve internal houseCurve;

    uint256 internal configId;
    uint256 internal constant LAUNCH_FEE = 0.0005 ether;

    function setUp() public virtual {
        HoodDeployer bytecode = new HoodDeployer();
        factory = new HoodFactory(owner, treasury, address(bytecode));
        bytecode.initialize(address(factory));
        staking = new HoodStaking(address(factory));
        router = new HoodFeeRouter(address(factory), address(staking));
        locker = new HoodTokenLock();
        graduator = new MockGraduator(address(factory));
        usd = new MockUSD();

        vm.startPrank(owner);
        factory.setModules(address(router), address(staking), address(graduator));
        factory.setFirstBuyLocker(address(locker));
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
        // A stakers leg needs somewhere for the money to land, and the factory refuses one before
        // the house coin exists. The rig provides it the way a real deployment would: by launching
        // the coin first, once.
        if (split.stakersBps != 0) _house();
        p.feeSplit = split;
        vm.prank(creator);
        (address t, address c,) = factory.launch{value: value}(p);
        return (t, HoodCurve(payable(c)));
    }

    /// @notice The house coin: the one token the vault accepts, launched on the pad like any other.
    /// @dev It cannot point its own fee at stakers, because at the moment it launches there is no
    ///      house coin yet. Everything launched after it can.
    function _house() internal returns (address token, HoodCurve curve) {
        if (house != address(0)) return (house, houseCurve);
        LaunchParams memory p = _params(_toBuyback());
        p.name = "House Coin";
        p.symbol = "HOUSE";
        p.salt = bytes32(uint256(7777));
        (token, curve) = _launch(_toBuyback(), p, LAUNCH_FEE);
        vm.prank(owner);
        staking.setHouseToken(token);
        house = token;
        houseCurve = curve;
    }

    /// @notice Buys the house coin and locks it, which is now the only way to earn a stakers leg.
    function _lockHouse(address who, uint256 spend, uint64 lock) internal returns (uint256 id) {
        (address token, HoodCurve curve) = _house();
        uint256 got = _buy(curve, who, spend);
        vm.startPrank(who);
        IERC20(token).approve(address(staking), got);
        id = staking.stake(got, lock);
        vm.stopPrank();
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
