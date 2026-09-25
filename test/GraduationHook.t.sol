// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {Vm} from "forge-std/Vm.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {CustomRevert} from "@uniswap/v4-core/src/libraries/CustomRevert.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {StateLibrary} from "@uniswap/v4-core/src/libraries/StateLibrary.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {BalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {ModifyLiquidityParams, SwapParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {PoolSwapTest} from "@uniswap/v4-core/src/test/PoolSwapTest.sol";
import {PoolModifyLiquidityTest} from "@uniswap/v4-core/src/test/PoolModifyLiquidityTest.sol";
import {LiquidityAmounts} from "@uniswap/v4-periphery/src/libraries/LiquidityAmounts.sol";

import {HoodGraduationHook} from "../src/graduation/HoodGraduationHook.sol";
import {UniswapV4Graduator} from "../src/graduation/UniswapV4Graduator.sol";
import {BagReasons, BagSource, PenaltyConfig} from "../src/bag/BagTypes.sol";
import {PoolKey as GradPoolKey} from "../src/interfaces/IExternal.sol";
import {
    MockBag,
    MockCurve,
    MockFactory,
    MockFeeRouter,
    MockGradQuote,
    MockLaunchToken,
    MockPermit2,
    MockPositionManager,
    MockPot,
    MockStateView,
    MockVault
} from "./mocks/GradMocks.sol";

/// @dev Shared fixture: a real PoolManager from the v4-core artifact, the hook etched at an address
///      whose low bits say beforeSwap, afterSwap and both return deltas (0xCC), and mocks for
///      everything the hook pays.
abstract contract GraduationFixture is Test {
    using StateLibrary for IPoolManager;
    using PoolIdLibrary for PoolKey;

    uint24 internal constant POOL_FEE = 3_000;
    int24 internal constant SPACING = 60;
    address internal constant HOOK_ADDRESS = address(uint160(0x555500CC));
    uint160 internal constant SQRT_PRICE_1_1 = 79228162514264337593543950336;
    string internal constant POOL_MANAGER_ARTIFACT =
        "node_modules/@uniswap/v4-core/out/PoolManager.sol/PoolManager.json";

    IPoolManager internal pm;
    PoolSwapTest internal swapRouter;
    PoolModifyLiquidityTest internal lpRouter;
    MockFactory internal factory;
    MockBag internal bag;
    MockFeeRouter internal feeRouter;
    MockVault internal vault;
    HoodGraduationHook internal hook;

    address internal owner = makeAddr("owner");
    address internal graduator = makeAddr("graduator");
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");

    receive() external payable {}

    function _deployMachine() internal {
        pm = IPoolManager(deployCode(POOL_MANAGER_ARTIFACT, abi.encode(address(this))));
        swapRouter = new PoolSwapTest(pm);
        lpRouter = new PoolModifyLiquidityTest(pm);
        factory = new MockFactory(owner);
        bag = new MockBag();
        feeRouter = new MockFeeRouter(address(factory));
        vault = new MockVault();
        factory.setModules(address(feeRouter), address(vault), graduator, address(bag));
        deployCodeTo(
            "HoodGraduationHook.sol:HoodGraduationHook",
            abi.encode(pm, address(factory), address(bag), address(feeRouter), address(vault)),
            HOOK_ADDRESS
        );
        hook = HoodGraduationHook(payable(HOOK_ADDRESS));
        vm.deal(alice, 10_000 ether);
        vm.deal(bob, 10_000 ether);
        vm.deal(address(this), 100_000 ether);
    }

    function _keyFor(address token, address quote) internal pure returns (PoolKey memory) {
        (address c0, address c1) = quote < token ? (quote, token) : (token, quote);
        return PoolKey({
            currency0: Currency.wrap(c0),
            currency1: Currency.wrap(c1),
            fee: POOL_FEE,
            tickSpacing: SPACING,
            hooks: IHooks(HOOK_ADDRESS)
        });
    }

    function _fullRange() internal pure returns (int24 lower, int24 upper) {
        lower = (TickMath.MIN_TICK / SPACING) * SPACING;
        upper = (TickMath.MAX_TICK / SPACING) * SPACING;
    }

    /// @dev Opens the pool at 1:1 and puts `amount0` and `amount1` in it over the full range.
    function _openPool(PoolKey memory key, uint256 amount0, uint256 amount1) internal {
        pm.initialize(key, SQRT_PRICE_1_1);
        (int24 lower, int24 upper) = _fullRange();
        uint128 liquidity = LiquidityAmounts.getLiquidityForAmounts(
            SQRT_PRICE_1_1, TickMath.getSqrtPriceAtTick(lower), TickMath.getSqrtPriceAtTick(upper), amount0, amount1
        );
        uint256 value;
        if (Currency.unwrap(key.currency0) == address(0)) value = amount0 + 1 ether;
        else MockLaunchToken(Currency.unwrap(key.currency0)).approve(address(lpRouter), type(uint256).max);
        MockLaunchToken(Currency.unwrap(key.currency1)).approve(address(lpRouter), type(uint256).max);
        lpRouter.modifyLiquidity{value: value}(
            key,
            ModifyLiquidityParams({
                tickLower: lower, tickUpper: upper, liquidityDelta: int256(uint256(liquidity)), salt: bytes32(0)
            }),
            ""
        );
    }

    function _settings() internal pure returns (PoolSwapTest.TestSettings memory) {
        return PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false});
    }

    /// @dev One swap as `who`, who is also tx.origin, which is what the hook keys buyers by.
    function _swap(PoolKey memory key, address token, address who, bool isBuy, int256 amountSpecified, uint256 value)
        internal
        returns (BalanceDelta)
    {
        bool tokenIsZero = Currency.unwrap(key.currency0) == token;
        bool zeroForOne = isBuy ? !tokenIsZero : tokenIsZero;
        uint160 limit = zeroForOne ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1;
        vm.prank(who, who);
        return swapRouter.swap{value: value}(
            key,
            SwapParams({zeroForOne: zeroForOne, amountSpecified: amountSpecified, sqrtPriceLimitX96: limit}),
            _settings(),
            ""
        );
    }

    function _lastTaxed(Vm.Log[] memory logs) internal view returns (bool isBuy, uint256 fee, uint256 volume) {
        bytes32 sig = keccak256("Taxed(bytes32,address,bool,uint256,uint256)");
        for (uint256 i = logs.length; i > 0; --i) {
            Vm.Log memory l = logs[i - 1];
            if (l.emitter == address(hook) && l.topics[0] == sig) return abi.decode(l.data, (bool, uint256, uint256));
        }
        revert("no Taxed event");
    }

    struct PenaltyLog {
        bytes32 reason;
        address payer;
        address token;
        uint256 amount;
        uint256 toHolders;
        uint256 toBag;
    }

    function _penalties(Vm.Log[] memory logs) internal view returns (PenaltyLog[] memory out) {
        bytes32 sig = keccak256("Penalty(bytes32,address,address,uint256,uint256,uint256)");
        uint256 n;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter == address(hook) && logs[i].topics[0] == sig) ++n;
        }
        out = new PenaltyLog[](n);
        uint256 j;
        for (uint256 i; i < logs.length; ++i) {
            Vm.Log memory l = logs[i];
            if (l.emitter != address(hook) || l.topics[0] != sig) continue;
            (uint256 amount, uint256 toHolders, uint256 toBag) = abi.decode(l.data, (uint256, uint256, uint256));
            out[j++] = PenaltyLog({
                reason: l.topics[1],
                payer: address(uint160(uint256(l.topics[2]))),
                token: address(uint160(uint256(l.topics[3]))),
                amount: amount,
                toHolders: toHolders,
                toBag: toBag
            });
        }
    }

    function _hookRevert(bytes4 entry, bytes4 reason) internal view returns (bytes memory) {
        return abi.encodeWithSelector(
            CustomRevert.WrappedError.selector,
            address(hook),
            entry,
            abi.encodeWithSelector(reason),
            abi.encodeWithSelector(Hooks.HookCallFailed.selector)
        );
    }

    function _tick(PoolKey memory key) internal view returns (int24 tick) {
        (, tick,,) = pm.getSlot0(key.toId());
    }

    /// @dev How far the tick moved, whichever way: the token sorts as currency1 against ETH, so a
    ///      sell moves it UP; the hook measures the distance, not the direction.
    function _tickMove(int24 before, int24 after_) internal pure returns (uint256) {
        int256 d = int256(after_) - int256(before);
        return uint256(d < 0 ? -d : d);
    }
}

/// @notice A graduated pool paired with native ETH: the platform fee on every shape of swap, the
///         flush, the sell-side penalties and who may register.
contract GraduationHookTest is GraduationFixture {
    using PoolIdLibrary for PoolKey;

    uint256 internal constant NATIVE_ID = 0;

    MockLaunchToken internal token;
    MockPot internal pot;
    PoolKey internal key;
    PoolId internal poolId;
    address internal curve;

    function setUp() public {
        _deployMachine();
        token = new MockLaunchToken();
        token.mint(address(this), 1_000_000e18);
        pot = new MockPot(address(token), address(0));
        // a launch's curve is always a contract, pinned to the handler it was born with
        curve = address(new MockCurve(graduator));
        factory.setLaunch(address(token), curve, address(0), address(pot));
        key = _keyFor(address(token), address(0));
        poolId = key.toId();
        _openPool(key, 1_000 ether, 1_000e18);
        vm.prank(alice);
        token.approve(address(swapRouter), type(uint256).max);
        vm.prank(bob);
        token.approve(address(swapRouter), type(uint256).max);
    }

    function _none() internal pure returns (PenaltyConfig memory p) {}

    function _jeet(bool toVault) internal pure returns (PenaltyConfig memory p) {
        p.jeetTaxBps = 500;
        p.jeetWindowSeconds = 300;
        p.penaltiesToVault = toVault;
    }

    function _whale() internal pure returns (PenaltyConfig memory p) {
        p.whaleTaxBps = 1_000;
        p.whaleTickLimit = 100;
    }

    function _register(PenaltyConfig memory p) internal {
        _registerWith(address(pot), p);
    }

    function _registerWith(address pot_, PenaltyConfig memory p) internal {
        vm.prank(graduator);
        hook.register(key, address(token), pot_, p);
    }

    function _buyExactIn(address who, uint256 ethIn) internal returns (BalanceDelta) {
        return _swap(key, address(token), who, true, -int256(ethIn), ethIn);
    }

    function _buyExactOut(address who, uint256 tokensOut, uint256 maxValue) internal returns (BalanceDelta) {
        return _swap(key, address(token), who, true, int256(tokensOut), maxValue);
    }

    function _sellExactIn(address who, uint256 tokensIn) internal returns (BalanceDelta) {
        return _swap(key, address(token), who, false, -int256(tokensIn), 0);
    }

    function _sellExactOut(address who, uint256 ethOut) internal returns (BalanceDelta) {
        return _swap(key, address(token), who, false, int256(ethOut), 0);
    }

    // ---------------------------------------------------------------- the platform fee

    function test_an_exact_input_buy_holds_one_percent_of_the_quote_as_a_claim() public {
        _register(_none());
        uint256 fee = 1 ether * 100 / 10_000;

        vm.recordLogs();
        BalanceDelta d = _buyExactIn(alice, 1 ether);
        (bool isBuy, uint256 taxed, uint256 volume) = _lastTaxed(vm.getRecordedLogs());

        assertEq(d.amount0(), -1e18, "the whole input leaves the buyer");
        assertGt(token.balanceOf(alice), 0);
        assertTrue(isBuy);
        assertEq(taxed, fee);
        assertEq(volume, 1 ether - fee, "the pool moved the input net of the fee");
        assertEq(hook.claimsHeld(poolId), fee);
        assertEq(pm.balanceOf(address(hook), NATIVE_ID), fee, "held as an ERC-6909 claim on the quote");
        assertEq(feeRouter.accrued(address(token)), 0, "nothing has left the manager yet");
        assertEq(bag.tradeFee(address(0), address(token)), 0);
    }

    function test_a_flush_pays_thirty_bps_to_the_fee_router_and_seventy_to_the_bag() public {
        _register(_none());
        _buyExactIn(alice, 1 ether);
        uint256 fee = 0.01 ether;

        vm.expectEmit(true, true, true, true, address(hook));
        emit HoodGraduationHook.ClaimsFlushed(poolId, address(token), 0.003 ether, 0.007 ether);
        vm.prank(bob);
        hook.flushClaims(key);

        assertEq(feeRouter.accrued(address(token)), fee * 30 / 100, "30 bps of the trade, as the creator leg");
        assertEq(address(feeRouter).balance, 0.003 ether);
        assertEq(bag.tradeFee(address(0), address(token)), fee * 70 / 100, "70 bps of the trade, into the Bag");
        assertEq(bag.totalIn(address(0), BagSource.Trade), 0.007 ether);
        assertEq(address(bag).balance, 0.007 ether);
        assertEq(hook.claimsHeld(poolId), 0);
        assertEq(pm.balanceOf(address(hook), NATIVE_ID), 0);
        assertEq(address(hook).balance, 0, "nothing sticks to the hook");

        // a second flush with nothing held is a no-op
        hook.flushClaims(key);
        assertEq(feeRouter.accrued(address(token)), 0.003 ether);
    }

    function test_an_exact_output_buy_pays_one_percent_of_the_quote_the_pool_charged() public {
        _register(_none());
        uint256 before = alice.balance;

        vm.recordLogs();
        BalanceDelta d = _buyExactOut(alice, 10e18, 20 ether);
        (bool isBuy, uint256 fee, uint256 volume) = _lastTaxed(vm.getRecordedLogs());

        uint256 paid = before - alice.balance;
        assertEq(token.balanceOf(alice), 10e18, "exactly the output asked for");
        assertEq(uint256(uint128(d.amount1())), 10e18);
        assertTrue(isBuy);
        assertEq(fee, volume * 100 / 10_000, "one percent of what the pool charged");
        assertEq(paid, volume + fee, "the quote for the tokens plus the fee on top");
        assertEq(hook.claimsHeld(poolId), fee, "held as a claim: the input settles after the hook ran");
        assertEq(pm.balanceOf(address(hook), NATIVE_ID), fee);
    }

    function test_an_exact_input_sell_pays_one_percent_of_the_quote_paid_out() public {
        _register(_none());
        _buyExactIn(alice, 10 ether);
        hook.flushClaims(key);
        uint256 tokens = token.balanceOf(alice);
        uint256 before = alice.balance;

        vm.recordLogs();
        BalanceDelta d = _sellExactIn(alice, tokens / 2);
        (bool isBuy, uint256 fee, uint256 volume) = _lastTaxed(vm.getRecordedLogs());

        uint256 received = alice.balance - before;
        assertFalse(isBuy);
        assertGt(received, 0);
        assertEq(fee, volume * 100 / 10_000, "one percent of the gross the pool paid out");
        assertEq(received, volume - fee, "the seller gets the gross net of the fee");
        assertEq(uint256(uint128(d.amount0())), received);
        assertEq(token.balanceOf(alice), tokens - tokens / 2);
        assertEq(hook.claimsHeld(poolId), fee, "held as a claim like every other fee, flushed later");
        assertEq(address(hook).balance, 0);
    }

    function test_an_exact_output_sell_pays_the_fee_on_a_pool_without_penalties() public {
        _register(_none());
        _buyExactIn(alice, 10 ether);
        hook.flushClaims(key);
        uint256 before = alice.balance;
        uint256 tokensBefore = token.balanceOf(alice);

        vm.recordLogs();
        _sellExactOut(alice, 1 ether);
        (bool isBuy, uint256 fee, uint256 volume) = _lastTaxed(vm.getRecordedLogs());

        assertEq(alice.balance - before, 1 ether, "exactly the quote asked for, net of the fee");
        assertFalse(isBuy);
        assertEq(fee, 0.01 ether, "one percent of the quote asked for");
        assertEq(volume, 1.01 ether, "the pool paid out the ask plus the fee");
        assertLt(token.balanceOf(alice), tokensBefore, "and the seller paid the fee in tokens");
        assertEq(hook.claimsHeld(poolId), fee);
    }

    /// @dev Absolute timestamps on purpose: under via-IR `block.timestamp` is read once per function
    ///      and reused across `vm.warp`, so every warp here is anchored to a literal instant.
    function test_swaps_after_the_interval_flush_the_prior_claims_and_a_broken_bag_never_blocks_a_trade() public {
        uint256 start = 1_000_000;
        vm.warp(start);
        _register(_none());
        _buyExactIn(alice, 1 ether);
        uint256 f1 = 0.01 ether;

        // inside the interval nothing moves
        vm.warp(start + hook.FLUSH_INTERVAL() - 1);
        _buyExactIn(bob, 2 ether);
        uint256 f2 = 0.02 ether;
        assertEq(feeRouter.accrued(address(token)), 0);
        assertEq(hook.claimsHeld(poolId), f1 + f2);

        // the first swap past the interval flushes everything held before it
        vm.warp(start + hook.FLUSH_INTERVAL());
        _buyExactIn(bob, 3 ether);
        uint256 f3 = 0.03 ether;
        assertEq(feeRouter.accrued(address(token)), (f1 + f2) * 30 / 100);
        assertEq(bag.tradeFee(address(0), address(token)), (f1 + f2) * 70 / 100);
        assertEq(hook.claimsHeld(poolId), f3, "this swap's own fee is still a claim");
        assertEq(hook.poolOf(poolId).lastFlushAt, uint40(start + hook.FLUSH_INTERVAL()));

        // a Bag that refuses the money does not stop the trade; the claims stay, whole
        bag.setBroken(true);
        vm.warp(start + 2 * hook.FLUSH_INTERVAL());
        _buyExactIn(alice, 1 ether);
        assertEq(hook.claimsHeld(poolId), f3 + f1, "nothing was flushed and nothing was lost");
        assertEq(pm.balanceOf(address(hook), NATIVE_ID), f3 + f1);
        assertEq(feeRouter.accrued(address(token)), (f1 + f2) * 30 / 100, "the router leg reverted with the Bag's");
        assertEq(
            hook.poolOf(poolId).lastFlushAt,
            uint40(start + 2 * hook.FLUSH_INTERVAL()),
            "and the clock moved on, so it is not retried every swap"
        );

        vm.expectRevert(MockBag.Broken.selector);
        hook.flushClaims(key);

        bag.setBroken(false);
        hook.flushClaims(key);
        assertEq(hook.claimsHeld(poolId), 0);
        assertEq(feeRouter.accrued(address(token)), (f1 + f2 + f3 + f1) * 30 / 100);
        assertEq(bag.tradeFee(address(0), address(token)), (f1 + f2 + f3 + f1) * 70 / 100);
    }

    // ---------------------------------------------------------------- penalties

    /// @dev Same absolute-timestamp rule as the flush test.
    function test_a_flip_inside_the_jeet_window_pays_the_jeet_tax_split_80_20() public {
        uint256 start = 1_000_000;
        vm.warp(start);
        _register(_jeet(false));
        _buyExactIn(alice, 10 ether);
        assertEq(hook.lastBuyAt(poolId, alice), start, "the buy is recorded by tx.origin");
        hook.flushClaims(key);
        uint256 tokens = token.balanceOf(alice);
        uint256 before = alice.balance;

        vm.warp(start + 100);
        vm.recordLogs();
        _sellExactIn(alice, tokens / 2);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        (, uint256 fee, uint256 gross) = _lastTaxed(logs);
        PenaltyLog[] memory p = _penalties(logs);

        assertEq(p.length, 1);
        assertEq(p[0].reason, BagReasons.JEET);
        assertEq(p[0].payer, alice);
        assertEq(p[0].token, address(token));
        assertEq(p[0].amount, gross * 500 / 10_000, "five percent of the gross");
        assertEq(p[0].toHolders, p[0].amount * 80 / 100);
        assertEq(p[0].toBag, p[0].amount - p[0].toHolders);
        assertEq(alice.balance - before, gross - fee - p[0].amount, "the seller paid the fee and the penalty");

        assertEq(pot.depositCount(), 1);
        MockPot.Deposit memory d = pot.lastDeposit();
        assertEq(d.amount, p[0].toHolders);
        assertEq(d.reason, BagReasons.JEET);
        assertEq(d.payer, alice);
        assertEq(address(pot).balance, p[0].toHolders, "the pot holds the money");
        assertEq(bag.penaltyCut(address(0), address(token)), p[0].toBag);
        assertEq(bag.totalIn(address(0), BagSource.Penalty), p[0].toBag);
        assertEq(vault.rewards(address(0)), 0);
        assertEq(address(hook).balance, 0);

        // somebody who never bought here is not a jeet
        vm.prank(alice);
        token.transfer(bob, tokens / 4);
        vm.recordLogs();
        _sellExactIn(bob, tokens / 4);
        assertEq(_penalties(vm.getRecordedLogs()).length, 0);
        assertEq(pot.depositCount(), 1);

        // and past the window the buyer is not one either
        vm.warp(start + 300);
        vm.recordLogs();
        _sellExactIn(alice, tokens / 4);
        assertEq(_penalties(vm.getRecordedLogs()).length, 0);
        assertEq(pot.depositCount(), 1);
    }

    function test_a_dump_past_the_tick_limit_pays_the_whale_tax() public {
        _register(_whale());
        token.transfer(alice, 200e18);
        int24 tickBefore = _tick(key);

        // a sell that barely moves the pool is not a dump
        vm.recordLogs();
        _sellExactIn(alice, 0.1e18);
        assertEq(_penalties(vm.getRecordedLogs()).length, 0);
        assertLt(_tickMove(tickBefore, _tick(key)), 100);
        assertEq(pot.depositCount(), 0);

        // one that moves it past the limit is
        uint256 before = alice.balance;
        vm.recordLogs();
        _sellExactIn(alice, 100e18);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        (, uint256 fee, uint256 gross) = _lastTaxed(logs);
        PenaltyLog[] memory p = _penalties(logs);
        assertGt(_tickMove(tickBefore, _tick(key)), 100, "the price moved more than the limit");

        assertEq(p.length, 1);
        assertEq(p[0].reason, BagReasons.WHALE);
        assertEq(p[0].payer, alice);
        assertEq(p[0].amount, gross * 1_000 / 10_000, "ten percent of the gross");
        assertEq(p[0].toHolders, p[0].amount * 80 / 100);
        assertEq(p[0].toBag, p[0].amount - p[0].toHolders);
        assertEq(alice.balance - before, gross - fee - p[0].amount);
        assertEq(pot.depositCount(), 1);
        MockPot.Deposit memory d = pot.lastDeposit();
        assertEq(d.reason, BagReasons.WHALE);
        assertEq(d.payer, alice);
        assertEq(d.amount, p[0].toHolders);
        assertEq(bag.penaltyCut(address(0), address(token)), p[0].toBag);
    }

    function test_a_flip_that_is_also_a_dump_pays_both() public {
        PenaltyConfig memory cfg = _jeet(false);
        cfg.whaleTaxBps = 1_000;
        cfg.whaleTickLimit = 100;
        _register(cfg);
        _buyExactIn(alice, 200 ether);
        uint256 tokens = token.balanceOf(alice);

        vm.recordLogs();
        _sellExactIn(alice, tokens);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        (,, uint256 gross) = _lastTaxed(logs);
        PenaltyLog[] memory p = _penalties(logs);
        assertEq(p.length, 2);
        assertEq(p[0].reason, BagReasons.JEET);
        assertEq(p[0].amount, gross * 500 / 10_000);
        assertEq(p[1].reason, BagReasons.WHALE);
        assertEq(p[1].amount, gross * 1_000 / 10_000);
        assertEq(pot.depositCount(), 2);
        assertEq(pot.totalDeposited(), p[0].toHolders + p[1].toHolders);
        assertEq(bag.penaltyCut(address(0), address(token)), p[0].toBag + p[1].toBag);
    }

    function test_lockers_eat_the_jeets_sends_the_holder_share_to_the_vault() public {
        _register(_jeet(true));
        _buyExactIn(alice, 10 ether);
        uint256 tokens = token.balanceOf(alice);

        vm.warp(block.timestamp + 10);
        vm.recordLogs();
        _sellExactIn(alice, tokens);
        PenaltyLog[] memory p = _penalties(vm.getRecordedLogs());
        assertEq(p.length, 1);
        assertEq(p[0].reason, BagReasons.JEET);
        assertEq(vault.rewards(address(0)), p[0].toHolders, "the holders' share went to the lockers");
        assertEq(address(vault).balance, p[0].toHolders);
        assertEq(pot.depositCount(), 0, "and not to the pot");
        assertEq(bag.penaltyCut(address(0), address(token)), p[0].toBag, "the Bag's fifth is the same either way");
    }

    function test_a_launch_without_a_pot_pays_the_holder_share_to_the_vault() public {
        _registerWith(address(0), _jeet(false));
        _buyExactIn(alice, 10 ether);
        uint256 tokens = token.balanceOf(alice);

        vm.warp(block.timestamp + 10);
        vm.recordLogs();
        _sellExactIn(alice, tokens);
        PenaltyLog[] memory p = _penalties(vm.getRecordedLogs());
        assertEq(p.length, 1);
        assertEq(vault.rewards(address(0)), p[0].toHolders);
        assertEq(bag.penaltyCut(address(0), address(token)), p[0].toBag);
    }

    function test_an_exact_output_sell_is_refused_on_a_pool_with_penalties() public {
        _register(_whale());
        token.transfer(alice, 10e18);
        assertEq(hook.claimsHeld(poolId), 0);

        vm.prank(alice, alice);
        vm.expectRevert(_hookRevert(IHooks.beforeSwap.selector, HoodGraduationHook.ExactOutputSellRefused.selector));
        swapRouter.swap(
            key,
            SwapParams({
                zeroForOne: false, amountSpecified: int256(1 ether), sqrtPriceLimitX96: TickMath.MAX_SQRT_PRICE - 1
            }),
            _settings(),
            ""
        );
        assertEq(token.balanceOf(alice), 10e18, "nothing left her wallet");

        // the same ask as an exact-input sell goes through
        _sellExactIn(alice, 1e18);
        assertGt(hook.claimsHeld(poolId), 0);
    }

    // ---------------------------------------------------------------- registration

    function test_a_swap_on_an_unregistered_pool_is_refused() public {
        // the pool exists (nothing stops anyone from opening one on this hook) but has no row
        vm.prank(alice, alice);
        vm.expectRevert(_hookRevert(IHooks.beforeSwap.selector, HoodGraduationHook.NotRegistered.selector));
        swapRouter.swap{value: 1 ether}(
            key,
            SwapParams({
                zeroForOne: true, amountSpecified: -int256(1 ether), sqrtPriceLimitX96: TickMath.MIN_SQRT_PRICE + 1
            }),
            _settings(),
            ""
        );
        assertEq(alice.balance, 10_000 ether, "nothing left her wallet");

        // a second pool on the same pair and hook, registered or not, is its own row
        PoolKey memory foreign = key;
        foreign.fee = 10_000;
        foreign.tickSpacing = 200;
        pm.initialize(foreign, SQRT_PRICE_1_1);
        _register(_none());
        vm.prank(alice, alice);
        vm.expectRevert(_hookRevert(IHooks.beforeSwap.selector, HoodGraduationHook.NotRegistered.selector));
        swapRouter.swap{value: 1 ether}(
            foreign,
            SwapParams({
                zeroForOne: true, amountSpecified: -int256(1 ether), sqrtPriceLimitX96: TickMath.MIN_SQRT_PRICE + 1
            }),
            _settings(),
            ""
        );
        _buyExactIn(alice, 1 ether);
        assertEq(hook.claimsHeld(poolId), 0.01 ether, "the registered one trades");
    }

    function test_only_the_graduator_can_register_and_only_once() public {
        PenaltyConfig memory cfg = _jeet(false);

        vm.prank(alice);
        vm.expectRevert(HoodGraduationHook.NotGraduator.selector);
        hook.register(key, address(token), address(pot), cfg);

        vm.prank(owner);
        vm.expectRevert(HoodGraduationHook.NotGraduator.selector);
        hook.register(key, address(token), address(pot), cfg);

        vm.expectEmit(true, true, true, true, address(hook));
        emit HoodGraduationHook.PoolRegistered(poolId, address(token), address(pot), cfg);
        vm.prank(graduator);
        hook.register(key, address(token), address(pot), cfg);

        HoodGraduationHook.Pool memory row = hook.poolOf(poolId);
        assertEq(row.token, address(token));
        assertEq(row.pot, address(pot));
        assertEq(row.jeetTaxBps, 500);
        assertEq(row.jeetWindowSeconds, 300);
        assertEq(row.whaleTaxBps, 0);
        assertFalse(row.penaltiesToVault);
        assertEq(row.lastFlushAt, uint40(block.timestamp));

        vm.prank(graduator);
        vm.expectRevert(HoodGraduationHook.AlreadyRegistered.selector);
        hook.register(key, address(token), address(pot), cfg);
    }

    function test_the_handler_a_curve_was_born_with_may_still_register_after_a_rotation() public {
        address oldHandler = makeAddr("oldHandler");
        MockCurve pinned = new MockCurve(oldHandler);
        factory.setLaunch(address(token), address(pinned), address(0), address(pot));
        factory.setModules(address(feeRouter), address(vault), makeAddr("newHandler"), address(bag));

        vm.prank(graduator);
        vm.expectRevert(HoodGraduationHook.NotGraduator.selector);
        hook.register(key, address(token), address(pot), _none());

        vm.prank(oldHandler);
        hook.register(key, address(token), address(pot), _none());
        assertEq(hook.poolOf(poolId).token, address(token));
    }

    function test_register_checks_the_key_and_the_penalties() public {
        vm.startPrank(graduator);

        PoolKey memory noHook = key;
        noHook.hooks = IHooks(address(0));
        vm.expectRevert(HoodGraduationHook.WrongHook.selector);
        hook.register(noHook, address(token), address(pot), _none());

        vm.expectRevert(HoodGraduationHook.TokenNotInPool.selector);
        hook.register(key, makeAddr("otherToken"), address(pot), _none());

        PenaltyConfig memory tooMuch;
        tooMuch.jeetTaxBps = 5_000;
        tooMuch.whaleTaxBps = 4_950; // 99.5% plus the 1% fee is over the line
        vm.expectRevert(HoodGraduationHook.BadPenalty.selector);
        hook.register(key, address(token), address(pot), tooMuch);

        tooMuch.whaleTaxBps = 4_900; // exactly 100% all in is allowed
        hook.register(key, address(token), address(pot), tooMuch);
        vm.stopPrank();
    }

    function test_the_hook_carries_exactly_the_permissions_its_address_says() public view {
        Hooks.Permissions memory p = hook.getHookPermissions();
        assertTrue(p.beforeSwap && p.afterSwap && p.beforeSwapReturnDelta && p.afterSwapReturnDelta);
        assertFalse(
            p.beforeInitialize || p.afterInitialize || p.beforeAddLiquidity || p.afterAddLiquidity
                || p.beforeRemoveLiquidity || p.afterRemoveLiquidity || p.beforeDonate || p.afterDonate
                || p.afterAddLiquidityReturnDelta || p.afterRemoveLiquidityReturnDelta
        );
        assertEq(
            uint160(HOOK_ADDRESS) & Hooks.ALL_HOOK_MASK,
            Hooks.BEFORE_SWAP_FLAG | Hooks.AFTER_SWAP_FLAG | Hooks.BEFORE_SWAP_RETURNS_DELTA_FLAG
                | Hooks.AFTER_SWAP_RETURNS_DELTA_FLAG
        );
    }
}

/// @notice The same hook on a pool paired with a six-decimal ERC-20: the fee router is paid by
///         transfer-then-call, the Bag and the pot pull what they were approved.
contract GraduationHookErc20Test is GraduationFixture {
    using PoolIdLibrary for PoolKey;

    MockLaunchToken internal token;
    MockGradQuote internal usd;
    MockPot internal pot;
    PoolKey internal key;
    PoolId internal poolId;

    function setUp() public {
        _deployMachine();
        token = new MockLaunchToken();
        usd = new MockGradQuote();
        token.mint(address(this), 1_000_000e18);
        usd.mint(address(this), 1_000_000e6);
        usd.mint(alice, 1_000_000e6);
        pot = new MockPot(address(token), address(usd));
        factory.setLaunch(address(token), address(new MockCurve(graduator)), address(usd), address(pot));
        key = _keyFor(address(token), address(usd));
        poolId = key.toId();
        // 1:1 in raw units: a million dollars against a million token wei is fine for a fee test
        _openPool(key, 1_000_000e6, 1_000_000e6);
        vm.startPrank(alice);
        token.approve(address(swapRouter), type(uint256).max);
        usd.approve(address(swapRouter), type(uint256).max);
        vm.stopPrank();
    }

    function test_an_erc20_quote_is_flushed_by_approve_and_pull() public {
        vm.prank(graduator);
        hook.register(key, address(token), address(pot), PenaltyConfig(0, 0, 0, 0, 0, false));
        uint256 quoteId = uint256(uint160(address(usd)));

        _swap(key, address(token), alice, true, -int256(uint256(1_000e6)), 0);
        assertEq(hook.claimsHeld(poolId), 10e6);
        assertEq(pm.balanceOf(address(hook), quoteId), 10e6);

        hook.flushClaims(key);
        assertEq(feeRouter.accrued(address(token)), 3e6);
        assertEq(usd.balanceOf(address(feeRouter)), 3e6, "transferred before the call");
        assertEq(bag.tradeFee(address(usd), address(token)), 7e6);
        assertEq(usd.balanceOf(address(bag)), 7e6, "pulled by the Bag");
        assertEq(usd.balanceOf(address(hook)), 0);
        assertEq(usd.allowance(address(hook), address(bag)), 0, "nothing left approved");
    }

    function test_an_erc20_jeet_penalty_reaches_the_pot_and_the_bag() public {
        PenaltyConfig memory cfg;
        cfg.jeetTaxBps = 500;
        cfg.jeetWindowSeconds = 300;
        vm.prank(graduator);
        hook.register(key, address(token), address(pot), cfg);

        _swap(key, address(token), alice, true, -int256(uint256(10_000e6)), 0);
        uint256 tokens = token.balanceOf(alice);
        vm.warp(block.timestamp + 10);
        vm.recordLogs();
        _swap(key, address(token), alice, false, -int256(tokens), 0);
        PenaltyLog[] memory p = _penalties(vm.getRecordedLogs());

        assertEq(p.length, 1);
        assertEq(p[0].reason, BagReasons.JEET);
        assertEq(p[0].payer, alice);
        assertEq(usd.balanceOf(address(pot)), p[0].toHolders);
        assertEq(pot.lastDeposit().payer, alice);
        assertEq(bag.penaltyCut(address(usd), address(token)), p[0].toBag);
        assertEq(usd.balanceOf(address(bag)), p[0].toBag);
        assertEq(usd.balanceOf(address(hook)), 0);
    }
}

/// @notice The graduator's side: the hook is named once, every pool opens on it, and graduating
///         writes the pool's row and keeps the pool's own addresses out of the pot.
contract GraduatorWiringTest is GraduationFixture {
    using PoolIdLibrary for PoolKey;

    uint256 internal constant Q96 = 1 << 96;

    MockLaunchToken internal token;
    MockPot internal pot;
    MockPositionManager internal posm;
    UniswapV4Graduator internal grad;
    PoolKey internal key;
    PenaltyConfig internal cfg;

    function setUp() public {
        _deployMachine();
        token = new MockLaunchToken();
        pot = new MockPot(address(token), address(0));
        posm = new MockPositionManager();
        grad = new UniswapV4Graduator(
            address(factory),
            address(pm),
            address(posm),
            makeAddr("universalRouter"),
            address(new MockPermit2()),
            address(new MockStateView(pm))
        );
        factory.setModules(address(feeRouter), address(vault), address(grad), address(bag));
        // this contract plays the curve
        factory.setLaunch(address(token), address(this), address(0), address(pot));
        cfg.jeetTaxBps = 300;
        cfg.jeetWindowSeconds = 120;
        cfg.whaleTaxBps = 800;
        cfg.whaleTickLimit = 250;
        factory.setPenalties(address(token), cfg);
        pot.setExcluder(address(grad));
        key = _keyFor(address(token), address(0));
    }

    function _sqrtPriceFor(uint256 amount0, uint256 amount1) internal pure returns (uint160) {
        return uint160(Math.sqrt(Math.mulDiv(amount1, Q96 * Q96, amount0)));
    }

    function _price(PoolKey memory k) internal view returns (uint160 sqrtPriceX96) {
        (sqrtPriceX96,,,) = StateLibrary.getSlot0(pm, k.toId());
    }

    function test_the_hook_is_named_once_by_the_factory_owner() public {
        vm.prank(alice);
        vm.expectRevert(UniswapV4Graduator.NotOwner.selector);
        grad.setHook(HOOK_ADDRESS);

        vm.prank(owner);
        vm.expectRevert(UniswapV4Graduator.HookNotSet.selector);
        grad.setHook(address(0));

        vm.expectEmit(true, true, true, true, address(grad));
        emit UniswapV4Graduator.HookSet(HOOK_ADDRESS);
        vm.prank(owner);
        grad.setHook(HOOK_ADDRESS);
        assertEq(grad.hook(), HOOK_ADDRESS);

        vm.prank(owner);
        vm.expectRevert(UniswapV4Graduator.HookAlreadySet.selector);
        grad.setHook(makeAddr("another"));
    }

    function test_no_pool_opens_until_the_hook_is_named_and_then_it_opens_on_the_hook() public {
        vm.prank(address(factory));
        vm.expectRevert(UniswapV4Graduator.HookNotSet.selector);
        grad.prepare(address(token), address(0), 200e18, 10 ether, POOL_FEE, SPACING);

        vm.prank(owner);
        grad.setHook(HOOK_ADDRESS);
        vm.prank(address(factory));
        grad.prepare(address(token), address(0), 200e18, 10 ether, POOL_FEE, SPACING);

        assertEq(_price(key), _sqrtPriceFor(10 ether, 200e18), "opened on the hook at the raise's ratio");
        PoolKey memory bare = key;
        bare.hooks = IHooks(address(0));
        assertEq(_price(bare), 0, "and not on a hookless pool");
    }

    function test_graduating_registers_the_pool_and_excludes_the_manager_and_the_hook_from_the_pot() public {
        vm.prank(owner);
        grad.setHook(HOOK_ADDRESS);
        vm.prank(address(factory));
        grad.prepare(address(token), address(0), 200e18, 10 ether, POOL_FEE, SPACING);
        token.mint(address(grad), 200e18);

        vm.expectEmit(true, true, true, true, address(hook));
        emit HoodGraduationHook.PoolRegistered(key.toId(), address(token), address(pot), cfg);
        grad.graduate{value: 10 ether}(address(token), address(0), 200e18, 10 ether, POOL_FEE, SPACING);

        assertTrue(grad.isGraduated(address(token)));
        (GradPoolKey memory stored,) = grad.positionOf(address(token));
        assertEq(stored.hooks, HOOK_ADDRESS);
        HoodGraduationHook.Pool memory row = hook.poolOf(key.toId());
        assertEq(row.token, address(token));
        assertEq(row.pot, address(pot));
        assertEq(row.jeetTaxBps, cfg.jeetTaxBps);
        assertEq(row.jeetWindowSeconds, cfg.jeetWindowSeconds);
        assertEq(row.whaleTaxBps, cfg.whaleTaxBps);
        assertEq(row.whaleTickLimit, cfg.whaleTickLimit);
        assertTrue(pot.excluded(address(pm)), "the pool's reserves never count as a holder");
        assertTrue(pot.excluded(HOOK_ADDRESS), "and neither does the hook");
        assertEq(posm.calls(), 1, "the position was minted");
        // this contract is the curve and the graduator's sender: it cannot graduate twice
        vm.expectRevert(UniswapV4Graduator.AlreadyGraduated.selector);
        grad.graduate{value: 10 ether}(address(token), address(0), 200e18, 10 ether, POOL_FEE, SPACING);
    }

    function test_a_raise_that_landed_off_the_opening_price_is_repriced_through_the_registered_pool() public {
        vm.prank(owner);
        grad.setHook(HOOK_ADDRESS);
        vm.prank(address(factory));
        grad.prepare(address(token), address(0), 200e18, 10 ether, POOL_FEE, SPACING);
        token.mint(address(grad), 200e18);

        // the raise came in a little under plan: the pool is empty, so the graduator walks the
        // price to the real ratio with a one-wei swap, which passes through the hook
        uint160 expected = _sqrtPriceFor(9 ether, 200e18);
        grad.graduate{value: 9 ether}(address(token), address(0), 200e18, 9 ether, POOL_FEE, SPACING);
        assertEq(_price(key), expected, "repriced to the ratio actually raised");
        assertTrue(grad.isGraduated(address(token)));
        assertEq(hook.poolOf(key.toId()).token, address(token));
        assertEq(hook.claimsHeld(key.toId()), 0, "the repricing swap paid no fee");
    }

    function test_a_pot_that_refuses_the_exclusion_does_not_block_graduation() public {
        pot.setExcluder(address(0));
        vm.prank(owner);
        grad.setHook(HOOK_ADDRESS);
        vm.prank(address(factory));
        grad.prepare(address(token), address(0), 200e18, 10 ether, POOL_FEE, SPACING);
        token.mint(address(grad), 200e18);

        vm.expectEmit(true, true, true, true, address(grad));
        emit UniswapV4Graduator.PotExcludeFailed(address(token), address(pot), address(pm));
        vm.expectEmit(true, true, true, true, address(grad));
        emit UniswapV4Graduator.PotExcludeFailed(address(token), address(pot), HOOK_ADDRESS);
        grad.graduate{value: 10 ether}(address(token), address(0), 200e18, 10 ether, POOL_FEE, SPACING);
        assertTrue(grad.isGraduated(address(token)));
        assertFalse(pot.excluded(address(pm)));
    }
}
