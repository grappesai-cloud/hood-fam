// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {StateLibrary} from "@uniswap/v4-core/src/libraries/StateLibrary.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {ModifyLiquidityParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {PoolModifyLiquidityTest} from "@uniswap/v4-core/src/test/PoolModifyLiquidityTest.sol";

import {HoodBurnClock} from "../src/bag/HoodBurnClock.sol";
import {IHoodBurnClock} from "../src/interfaces/IHoodBurnClock.sol";
import {PairTransfer} from "../src/libraries/PairTransfer.sol";
import {BagUSD, MockBagFactory, MockBurnCoin, PlainCoin} from "./mocks/BagMocks.sol";

/// @notice The burn clock against a real v4 PoolManager, deployed from the artifact the package
///         ships, the way the direct-launch suite does it.
contract BurnClockTest is Test {
    using StateLibrary for IPoolManager;
    using PoolIdLibrary for PoolKey;

    string internal constant POOL_MANAGER_ARTIFACT = "node_modules/@uniswap/v4-core/out/PoolManager.sol/PoolManager.json";
    uint24 internal constant FEE = 3_000;
    int24 internal constant SPACING = 60;
    int24 internal constant RANGE = 600;
    uint128 internal constant LIQ = 1e21;
    int24 internal constant CAP = 296;

    IPoolManager internal pm;
    PoolModifyLiquidityTest internal lpRouter;
    MockBagFactory internal factory;
    HoodBurnClock internal clock;
    MockBurnCoin internal coin;
    BagUSD internal usd;
    PoolKey internal key;

    address internal keeper = makeAddr("keeper");
    address internal funder = makeAddr("bag");
    address internal alice = makeAddr("alice");

    receive() external payable {}

    function setUp() public {
        vm.warp(1_000_000);
        pm = IPoolManager(deployCode(POOL_MANAGER_ARTIFACT, abi.encode(address(this))));
        lpRouter = new PoolModifyLiquidityTest(pm);
        factory = new MockBagFactory(address(this));
        clock = new HoodBurnClock(address(factory), address(pm));
        clock.setKeeper(keeper);
        coin = new MockBurnCoin();
        coin.mint(address(this), 1_000_000e18);
        usd = new BagUSD();
        usd.mint(address(this), 1e30);
        usd.mint(funder, 1e30);
        vm.deal(address(this), 10_000 ether);
        vm.deal(funder, 10_000 ether);
        key = _nativePool(address(coin));
    }

    // ---------------------------------------------------------------- helpers

    /// @dev A pool of the chain's own currency against `c`, one to one, with LIQ of liquidity
    ///      across RANGE ticks either side of the price.
    function _nativePool(address c) internal returns (PoolKey memory k) {
        k = PoolKey({
            currency0: Currency.wrap(address(0)),
            currency1: Currency.wrap(c),
            fee: FEE,
            tickSpacing: SPACING,
            hooks: IHooks(address(0))
        });
        pm.initialize(k, TickMath.getSqrtPriceAtTick(0));
        IERC20(c).approve(address(lpRouter), type(uint256).max);
        lpRouter.modifyLiquidity{value: 100 ether}(
            k,
            ModifyLiquidityParams({tickLower: -RANGE, tickUpper: RANGE, liquidityDelta: int256(uint256(LIQ)), salt: 0}),
            ""
        );
    }

    function _tokenPool(address a, address b) internal returns (PoolKey memory k) {
        (address c0, address c1) = a < b ? (a, b) : (b, a);
        k = PoolKey({
            currency0: Currency.wrap(c0),
            currency1: Currency.wrap(c1),
            fee: FEE,
            tickSpacing: SPACING,
            hooks: IHooks(address(0))
        });
        pm.initialize(k, TickMath.getSqrtPriceAtTick(0));
        IERC20(c0).approve(address(lpRouter), type(uint256).max);
        IERC20(c1).approve(address(lpRouter), type(uint256).max);
        lpRouter.modifyLiquidity(
            k,
            ModifyLiquidityParams({tickLower: -RANGE, tickUpper: RANGE, liquidityDelta: int256(uint256(LIQ)), salt: 0}),
            ""
        );
    }

    function _fund(uint256 amount) internal {
        vm.prank(funder);
        clock.fund{value: amount}(address(0), amount);
    }

    function _tick(PoolKey memory k) internal view returns (int24 tick) {
        (, tick,,) = pm.getSlot0(k.toId());
    }

    // ---------------------------------------------------------------- setting the coin

    function test_set_house_coin_rules() public {
        vm.prank(alice);
        vm.expectRevert(HoodBurnClock.NotOwner.selector);
        clock.setHouseCoin(address(coin), key);

        PoolKey memory notOurs = key;
        notOurs.currency1 = Currency.wrap(address(usd));
        vm.expectRevert(HoodBurnClock.CoinNotInPool.selector);
        clock.setHouseCoin(address(coin), notOurs);

        PoolKey memory uninitialized = key;
        uninitialized.fee = 500;
        vm.expectRevert(HoodBurnClock.PoolNotInitialized.selector);
        clock.setHouseCoin(address(coin), uninitialized);

        vm.expectRevert(HoodBurnClock.ZeroAddress.selector);
        clock.setHouseCoin(address(0), key);

        vm.expectEmit(true, true, true, true, address(clock));
        emit IHoodBurnClock.HouseCoinSet(address(coin));
        clock.setHouseCoin(address(coin), key);
        assertEq(clock.houseCoin(), address(coin));
        assertEq(clock.spendAsset(), address(0), "the other currency is what the clock spends");
        assertFalse(clock.coinIsZero());
        assertEq(clock.poolKey().fee, FEE);

        vm.expectRevert(HoodBurnClock.AlreadySet.selector);
        clock.setHouseCoin(address(coin), key);
    }

    function test_keeper_is_set_by_the_factory_owner_only() public {
        vm.prank(alice);
        vm.expectRevert(HoodBurnClock.NotOwner.selector);
        clock.setKeeper(alice);
        vm.expectEmit(true, true, true, true, address(clock));
        emit IHoodBurnClock.KeeperSet(alice);
        clock.setKeeper(alice);
        assertEq(clock.keeper(), alice);
    }

    // ---------------------------------------------------------------- funding

    function test_fund_accumulates_every_asset_but_only_the_spend_asset_can_burn() public {
        vm.expectEmit(true, true, true, true, address(clock));
        emit IHoodBurnClock.Funded(address(0), 1 ether);
        _fund(1 ether);
        vm.startPrank(funder);
        usd.approve(address(clock), type(uint256).max);
        clock.fund(address(usd), 5e6);
        vm.stopPrank();
        assertEq(clock.balanceOf(address(0)), 1 ether);
        assertEq(clock.balanceOf(address(usd)), 5e6);
        assertEq(usd.balanceOf(address(clock)), 5e6);

        clock.setHouseCoin(address(coin), key);
        vm.prank(keeper);
        vm.expectRevert(HoodBurnClock.NotTheSpendAsset.selector);
        clock.burn(address(usd), 5e6, 0);
    }

    function test_fund_zero_is_a_no_op_and_value_mismatch_reverts() public {
        vm.prank(funder);
        clock.fund(address(0), 0);
        assertEq(clock.balanceOf(address(0)), 0);
        vm.prank(funder);
        vm.expectRevert(HoodBurnClock.WrongValue.selector);
        clock.fund{value: 1}(address(0), 0);
        vm.prank(funder);
        vm.expectRevert(PairTransfer.WrongValue.selector);
        clock.fund{value: 1}(address(0), 2);
    }

    // ---------------------------------------------------------------- burning

    function test_burn_needs_the_keeper_and_the_house_coin() public {
        _fund(1 ether);
        vm.prank(alice);
        vm.expectRevert(HoodBurnClock.NotKeeper.selector);
        clock.burn(address(0), 1 ether, 0);
        vm.prank(keeper);
        vm.expectRevert(HoodBurnClock.NoHouseCoin.selector);
        clock.burn(address(0), 1 ether, 0);
        clock.setHouseCoin(address(coin), key);
        // the owner may burn too
        (uint256 spent, uint256 burned) = clock.burn(address(0), 1 ether, 0);
        assertEq(spent, 1 ether);
        assertGt(burned, 0);
    }

    function test_burn_spends_the_balance_and_burns_what_it_bought() public {
        clock.setHouseCoin(address(coin), key);
        _fund(1 ether);
        uint256 supplyBefore = coin.totalSupply();
        uint256 pmBefore = address(pm).balance;
        int24 tickBefore = _tick(key);

        vm.expectEmit(true, false, false, false, address(clock));
        emit IHoodBurnClock.Burned(address(0), 0, 0, clock.epoch());
        vm.prank(keeper);
        (uint256 spent, uint256 burned) = clock.burn(address(0), 1 ether, 1);

        assertEq(spent, 1 ether, "a small spend fits under the cap whole");
        assertGt(burned, 0.9e18, "about one coin for one ether, less the fee");
        assertLt(burned, 1e18);
        assertEq(coin.totalSupply(), supplyBefore - burned, "burned, not parked");
        assertEq(coin.balanceOf(address(clock)), 0);
        assertEq(address(pm).balance, pmBefore + spent, "the pool got the ether");
        assertEq(clock.balanceOf(address(0)), 0);
        assertEq(clock.totalSpent(address(0)), 1 ether);
        assertEq(clock.totalBurned(), burned);
        assertEq(clock.lastBurnEpoch(address(0)), clock.epoch());
        assertLt(_tick(key), tickBefore, "buying the coin moved the price the coin's way");
    }

    function test_impact_cap_spends_only_what_moves_the_price_296_ticks() public {
        clock.setHouseCoin(address(coin), key);
        _fund(100 ether);
        int24 tickBefore = _tick(key);

        vm.prank(keeper);
        (uint256 spent, uint256 burned) = clock.burn(address(0), 100 ether, 0);

        int24 tickAfter = _tick(key);
        assertGe(tickAfter, tickBefore - CAP, "never past the cap");
        assertLe(tickAfter, tickBefore - CAP + 2, "and right up against it");
        assertLt(spent, 100 ether, "the rest waits");
        assertGt(spent, 10 ether);
        assertLt(spent, 20 ether);
        assertGt(burned, 0);
        assertEq(clock.balanceOf(address(0)), 100 ether - spent, "what was not spent is still booked");
        assertEq(address(clock).balance, 100 ether - spent);
    }

    function test_once_per_hour_per_asset() public {
        clock.setHouseCoin(address(coin), key);
        _fund(100 ether);
        vm.prank(keeper);
        (uint256 first,) = clock.burn(address(0), 100 ether, 0);
        vm.prank(keeper);
        vm.expectRevert(HoodBurnClock.AlreadyBurnedThisHour.selector);
        clock.burn(address(0), 100 ether, 0);

        vm.warp(block.timestamp + 1 hours);
        int24 tickBefore = _tick(key);
        vm.prank(keeper);
        (uint256 second,) = clock.burn(address(0), 100 ether, 0);
        assertGt(second, 0);
        assertGe(_tick(key), tickBefore - CAP);
        assertEq(clock.balanceOf(address(0)), 100 ether - first - second);
        assertEq(clock.totalSpent(address(0)), first + second);
    }

    function test_min_out_reverts_when_too_little_comes_back() public {
        clock.setHouseCoin(address(coin), key);
        _fund(1 ether);
        vm.prank(keeper);
        vm.expectRevert(HoodBurnClock.Slippage.selector);
        clock.burn(address(0), 1 ether, 2e18);
        assertEq(clock.balanceOf(address(0)), 1 ether, "nothing moved");
        assertEq(clock.lastBurnEpoch(address(0)), 0, "the hour is not used up by a failed burn");
    }

    function test_max_spend_caps_the_spend() public {
        clock.setHouseCoin(address(coin), key);
        _fund(10 ether);
        vm.prank(keeper);
        (uint256 spent,) = clock.burn(address(0), 1 ether, 0);
        assertEq(spent, 1 ether);
        assertEq(clock.balanceOf(address(0)), 9 ether);
    }

    function test_nothing_to_spend_reverts() public {
        clock.setHouseCoin(address(coin), key);
        vm.prank(keeper);
        vm.expectRevert(HoodBurnClock.Nothing.selector);
        clock.burn(address(0), 1 ether, 0);
        _fund(1 ether);
        vm.prank(keeper);
        vm.expectRevert(HoodBurnClock.Nothing.selector);
        clock.burn(address(0), 0, 0);
    }

    function test_coin_without_burn_goes_to_the_dead_address() public {
        PlainCoin plain = new PlainCoin();
        plain.mint(address(this), 1_000_000e18);
        PoolKey memory k2 = _nativePool(address(plain));
        HoodBurnClock c2 = new HoodBurnClock(address(factory), address(pm));
        c2.setKeeper(keeper);
        c2.setHouseCoin(address(plain), k2);
        vm.prank(funder);
        c2.fund{value: 1 ether}(address(0), 1 ether);
        uint256 supply = plain.totalSupply();
        vm.prank(keeper);
        (, uint256 burned) = c2.burn(address(0), 1 ether, 1);
        assertGt(burned, 0);
        assertEq(plain.balanceOf(c2.DEAD()), burned);
        assertEq(plain.totalSupply(), supply, "no burn function, so the supply stands");
        assertEq(plain.balanceOf(address(c2)), 0);
    }

    function test_erc20_spend_asset_in_whichever_direction_the_pool_sorts() public {
        PoolKey memory k2 = _tokenPool(address(usd), address(coin));
        HoodBurnClock c2 = new HoodBurnClock(address(factory), address(pm));
        c2.setKeeper(keeper);
        c2.setHouseCoin(address(coin), k2);
        assertEq(c2.spendAsset(), address(usd));
        assertEq(c2.coinIsZero(), address(coin) < address(usd));

        vm.startPrank(funder);
        usd.approve(address(c2), type(uint256).max);
        c2.fund(address(usd), 1e18);
        vm.stopPrank();
        uint256 supply = coin.totalSupply();
        uint256 pmUsd = usd.balanceOf(address(pm));

        vm.prank(keeper);
        (uint256 spent, uint256 burned) = c2.burn(address(usd), 1e18, 1);
        assertEq(spent, 1e18);
        assertGt(burned, 0.9e18);
        assertEq(coin.totalSupply(), supply - burned);
        assertEq(usd.balanceOf(address(pm)), pmUsd + spent);
        assertEq(usd.balanceOf(address(c2)), 0);
        assertEq(c2.balanceOf(address(usd)), 0);
    }

    function test_unlock_callback_is_for_the_pool_manager_only() public {
        vm.expectRevert(HoodBurnClock.NotPoolManager.selector);
        clock.unlockCallback(abi.encode(uint256(1)));
    }
}
