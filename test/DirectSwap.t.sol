// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {Vm} from "forge-std/Vm.sol";
import {console2} from "forge-std/console2.sol";
import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";

import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {CustomRevert} from "@uniswap/v4-core/src/libraries/CustomRevert.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {FullMath} from "@uniswap/v4-core/src/libraries/FullMath.sol";
import {FixedPoint96} from "@uniswap/v4-core/src/libraries/FixedPoint96.sol";
import {StateLibrary} from "@uniswap/v4-core/src/libraries/StateLibrary.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {BalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {ModifyLiquidityParams, SwapParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {PoolSwapTest} from "@uniswap/v4-core/src/test/PoolSwapTest.sol";
import {PoolModifyLiquidityTest} from "@uniswap/v4-core/src/test/PoolModifyLiquidityTest.sol";
import {LiquidityAmounts} from "@uniswap/v4-periphery/src/libraries/LiquidityAmounts.sol";

import {HoodLaunchHook} from "../src/direct/HoodLaunchHook.sol";
import {HoodLaunchToken} from "../src/direct/HoodLaunchToken.sol";
import {HoodRevenueSplitter} from "../src/direct/HoodRevenueSplitter.sol";
import {HoodBuybackModule} from "../src/direct/HoodBuybackModule.sol";
import {Allocations, Socials} from "../src/direct/DirectTypes.sol";
import {PairTransfer} from "../src/libraries/PairTransfer.sol";
import {RejectNative} from "./mocks/Mocks.sol";

/// @dev Exactly what the buyback module reads from the portal: whether a token is a launch of
///      ours, and where its splitter and locker are.
contract PortalStub {
    address public token;
    address public hook;
    address public splitter;
    address public locker;

    function set(address token_, address hook_, address splitter_, address locker_) external {
        token = token_;
        hook = hook_;
        splitter = splitter_;
        locker = locker_;
    }

    function getLaunch(address t)
        external
        view
        returns (address, address, address, address, address, address, uint256, uint64, uint64, bool)
    {
        return (t, address(0), hook, splitter, locker, address(0), 0, 0, 0, t == token);
    }
}

/// @dev The locker only has to answer `poolKey()` for the module and take the liquidity share.
contract LockerStub {
    PoolKey internal _key;

    receive() external payable {}

    function setKey(PoolKey calldata key) external {
        _key = key;
    }

    function poolKey() external view returns (PoolKey memory) {
        return _key;
    }
}

/// @notice The four shapes a swap can take through the launch hook, against a real PoolManager,
///         with no chain underneath. The test contract plays the portal: it wires the machine and
///         it is the address the hook exempts from the opening surcharge.
contract DirectSwapTest is Test {
    using StateLibrary for IPoolManager;
    using PoolIdLibrary for PoolKey;

    uint24 internal constant POOL_FEE = 10_000;
    int24 internal constant SPACING = 200;
    // The token sorts into currency1 against native ETH, so the price is tokens per ETH and the
    // tick walks DOWN as the token gets dearer. Open at ten ETH of fully diluted value, bond at a
    // hundred, the same numbers the fork suite uses.
    int24 internal constant TICK_START = 184_200;
    int24 internal constant TICK_BOND = 161_200;
    uint256 internal constant SUPPLY = 1_000_000_000e18;
    uint256 internal constant BUY_TAX = 500;
    uint256 internal constant SELL_TAX = 500;
    uint256 internal constant SNIPE_TAX = 5_000;
    uint32 internal constant SNIPE_WINDOW = 3;
    // A real PoolManager reads a hook's permissions off its address: the low fourteen bits have
    // to be 0xCC (beforeSwap, afterSwap and both return deltas), so the hook is etched there.
    address internal constant HOOK_ADDRESS = address(uint160(0x444400CC));
    uint256 internal constant NATIVE_ID = 0;
    // The PoolManager only compiles with the settings v4-core ships it under (via-IR at 44,444,444
    // runs); under this project's 400 runs solc runs out of stack inside Pool.swap. The package
    // carries the artifact built with those settings, so that is the bytecode deployed here.
    string internal constant POOL_MANAGER_ARTIFACT = "node_modules/@uniswap/v4-core/out/PoolManager.sol/PoolManager.json";

    IPoolManager internal pm;
    PoolSwapTest internal swapRouter;
    PoolModifyLiquidityTest internal lpRouter;
    HoodLaunchToken internal token;
    HoodLaunchHook internal hook;
    HoodRevenueSplitter internal splitter;
    HoodBuybackModule internal module;
    PortalStub internal portalStub;
    LockerStub internal locker;
    PoolKey internal key;
    PoolId internal poolId;
    uint128 internal positionLiquidity;

    address internal treasury = makeAddr("treasury");
    address internal creator = makeAddr("creator");
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");

    receive() external payable {}

    function setUp() public {
        pm = IPoolManager(deployCode(POOL_MANAGER_ARTIFACT, abi.encode(address(this))));
        swapRouter = new PoolSwapTest(pm);
        lpRouter = new PoolModifyLiquidityTest(pm);

        token = HoodLaunchToken(Clones.clone(address(new HoodLaunchToken())));
        token.initialize("Hood Fam", "FAM", "", "", Socials("", "", "", "", ""), SUPPLY, creator, 0, 10_000, 10_000);

        portalStub = new PortalStub();
        locker = new LockerStub();
        module = new HoodBuybackModule(address(pm), address(portalStub));
        splitter = new HoodRevenueSplitter(address(this), treasury, address(module), address(token), address(0));

        key = PoolKey({
            currency0: Currency.wrap(address(0)),
            currency1: Currency.wrap(address(token)),
            fee: POOL_FEE,
            tickSpacing: SPACING,
            hooks: IHooks(HOOK_ADDRESS)
        });
        poolId = key.toId();

        deployCodeTo("HoodLaunchHook.sol:HoodLaunchHook", abi.encode(pm, address(this)), HOOK_ADDRESS);
        hook = HoodLaunchHook(HOOK_ADDRESS);
        hook.initialize(
            HoodLaunchHook.InitParams({
                token: address(token),
                quote: address(0),
                splitter: address(splitter),
                factory: address(0),
                buybackModule: address(module),
                tokenIsZero: false,
                buyTaxBps: uint16(BUY_TAX),
                sellTaxBps: uint16(SELL_TAX),
                snipeTaxBps: uint16(SNIPE_TAX),
                snipeDecaySeconds: SNIPE_WINDOW,
                tickBond: TICK_BOND,
                key: key
            })
        );

        splitter.initialize(creator, address(locker), Allocations(2_500, 2_500, 4_000, 1_000));
        splitter.exclude(address(pm));
        splitter.exclude(address(hook));
        token.setLaunchAddresses(address(pm), address(splitter), address(locker), address(hook), address(module));
        portalStub.set(address(token), address(hook), address(splitter), address(locker));
        locker.setKey(key);

        pm.initialize(key, TickMath.getSqrtPriceAtTick(TICK_START));
        positionLiquidity = LiquidityAmounts.getLiquidityForAmount1(
            TickMath.getSqrtPriceAtTick(TICK_BOND), TickMath.getSqrtPriceAtTick(TICK_START), SUPPLY
        );
        token.approve(address(lpRouter), SUPPLY);
        lpRouter.modifyLiquidity(
            key,
            ModifyLiquidityParams({
                tickLower: TICK_BOND,
                tickUpper: TICK_START,
                liquidityDelta: int256(uint256(positionLiquidity)),
                salt: bytes32(0)
            }),
            ""
        );
        uint256 dust = token.balanceOf(address(this));
        if (dust != 0) token.burn(dust);

        vm.deal(alice, 1_000 ether);
        vm.deal(bob, 1_000 ether);
        vm.deal(address(this), 1_000 ether);
    }

    // ---------------------------------------------------------------- helpers

    function _pastTheWindow() internal {
        vm.warp(uint256(hook.launchTime()) + SNIPE_WINDOW);
    }

    function _settings() internal pure returns (PoolSwapTest.TestSettings memory) {
        return PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false});
    }

    function _buyExactInParams(uint256 amountIn) internal pure returns (SwapParams memory) {
        return SwapParams({
            zeroForOne: true, amountSpecified: -int256(amountIn), sqrtPriceLimitX96: TickMath.MIN_SQRT_PRICE + 1
        });
    }

    function _buyExactOutParams(uint256 tokensOut) internal pure returns (SwapParams memory) {
        return SwapParams({
            zeroForOne: true, amountSpecified: int256(tokensOut), sqrtPriceLimitX96: TickMath.MIN_SQRT_PRICE + 1
        });
    }

    function _sellExactInParams(uint256 tokensIn) internal pure returns (SwapParams memory) {
        return SwapParams({
            zeroForOne: false, amountSpecified: -int256(tokensIn), sqrtPriceLimitX96: TickMath.MAX_SQRT_PRICE - 1
        });
    }

    function _sellExactOutParams(uint256 quoteOut) internal pure returns (SwapParams memory) {
        return SwapParams({
            zeroForOne: false, amountSpecified: int256(quoteOut), sqrtPriceLimitX96: TickMath.MAX_SQRT_PRICE - 1
        });
    }

    function _buyExactIn(address who, uint256 amountIn) internal returns (BalanceDelta) {
        vm.prank(who);
        return swapRouter.swap{value: amountIn}(key, _buyExactInParams(amountIn), _settings(), "");
    }

    /// @dev The router settles what the swap cost and refunds the rest, so `maxValue` only has to
    ///      cover it.
    function _buyExactOut(address who, uint256 tokensOut, uint256 maxValue) internal returns (BalanceDelta) {
        vm.prank(who);
        return swapRouter.swap{value: maxValue}(key, _buyExactOutParams(tokensOut), _settings(), "");
    }

    function _sellExactIn(address who, uint256 tokensIn) internal returns (BalanceDelta delta) {
        vm.startPrank(who);
        token.approve(address(swapRouter), tokensIn);
        delta = swapRouter.swap(key, _sellExactInParams(tokensIn), _settings(), "");
        vm.stopPrank();
    }

    function _sellExactOut(address who, uint256 quoteOut) internal returns (BalanceDelta delta) {
        vm.startPrank(who);
        token.approve(address(swapRouter), type(uint256).max);
        delta = swapRouter.swap(key, _sellExactOutParams(quoteOut), _settings(), "");
        vm.stopPrank();
    }

    /// @dev Straight against the PoolManager, the way the portal and the module trade, so the hook
    ///      sees this contract as the sender.
    function _swapAsPortal(SwapParams memory params) internal returns (BalanceDelta) {
        return abi.decode(pm.unlock(abi.encode(params)), (BalanceDelta));
    }

    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        require(msg.sender == address(pm), "not the manager");
        SwapParams memory params = abi.decode(data, (SwapParams));
        BalanceDelta delta = pm.swap(key, params, "");
        if (delta.amount0() < 0) pm.settle{value: uint256(uint128(-delta.amount0()))}();
        if (delta.amount1() < 0) {
            pm.sync(key.currency1);
            token.transfer(address(pm), uint256(uint128(-delta.amount1())));
            pm.settle();
        }
        if (delta.amount0() > 0) pm.take(key.currency0, address(this), uint256(uint128(delta.amount0())));
        if (delta.amount1() > 0) pm.take(key.currency1, address(this), uint256(uint128(delta.amount1())));
        return abi.encode(delta);
    }

    function _tick() internal view returns (int24 tick) {
        (, tick,,) = pm.getSlot0(poolId);
    }

    function _sqrtPrice() internal view returns (uint160 sqrtPriceX96) {
        (sqrtPriceX96,,,) = pm.getSlot0(poolId);
    }

    /// @dev The hook's `Taxed` event carries no indexed field, so the numbers are read back out of
    ///      the recorded logs rather than matched with expectEmit.
    function _lastTaxed(Vm.Log[] memory logs) internal view returns (bool isBuy, uint256 fee, uint256 volume) {
        bytes32 sig = keccak256("Taxed(bool,uint256,uint256)");
        for (uint256 i = logs.length; i > 0; --i) {
            Vm.Log memory l = logs[i - 1];
            if (l.emitter == address(hook) && l.topics[0] == sig) return abi.decode(l.data, (bool, uint256, uint256));
        }
        revert("no Taxed event");
    }

    // ---------------------------------------------------------------- 1. exact-input buy

    function test_exact_input_buy_holds_the_tax_as_a_claim_until_the_next_swap_or_a_flush() public {
        _pastTheWindow();
        assertEq(hook.currentTaxBps(true), BUY_TAX);
        uint256 fee = 1 ether * BUY_TAX / 10_000; // 0.05 ETH
        uint256 aliceBefore = alice.balance;

        BalanceDelta d = _buyExactIn(alice, 1 ether);

        assertEq(aliceBefore - alice.balance, 1 ether, "the whole input leaves the buyer");
        assertEq(d.amount0(), -1e18);
        assertGt(d.amount1(), 0);
        assertEq(token.balanceOf(alice), uint256(uint128(d.amount1())));
        assertEq(hook.claimsHeld(), fee);
        assertEq(pm.balanceOf(address(hook), NATIVE_ID), fee, "held as an ERC-6909 claim on the quote");
        assertEq(address(splitter).balance, 0, "nothing has reached the splitter yet");

        // the next swap, whoever makes it, flushes the claim on its way through afterSwap
        vm.expectEmit(true, true, true, true, address(hook));
        emit HoodLaunchHook.ClaimsFlushed(fee);
        _buyExactIn(bob, 0.5 ether);
        uint256 fee2 = 0.5 ether * BUY_TAX / 10_000;
        assertEq(address(splitter).balance, fee);
        assertEq(hook.claimsHeld(), fee2, "only this swap's slice is still a claim");
        assertEq(pm.balanceOf(address(hook), NATIVE_ID), fee2);

        // and a bare flush does the same, from anyone
        vm.expectEmit(true, true, true, true, address(hook));
        emit HoodLaunchHook.ClaimsFlushed(fee2);
        vm.prank(bob);
        hook.flushClaims();
        assertEq(address(splitter).balance, fee + fee2);
        assertEq(hook.claimsHeld(), 0);
        assertEq(pm.balanceOf(address(hook), NATIVE_ID), 0);
    }

    // ---------------------------------------------------------------- 2. exact-output buy

    function test_exact_output_buy_pays_the_quote_plus_the_tax_and_reports_the_volume() public {
        _pastTheWindow();
        uint256 rate = hook.currentTaxBps(true);
        assertEq(rate, BUY_TAX);
        uint256 tokensOut = 1_000_000e18;
        uint256 aliceBefore = alice.balance;
        uint256 pmBefore = address(pm).balance;

        vm.recordLogs();
        BalanceDelta d = _buyExactOut(alice, tokensOut, 1 ether);
        (bool isBuy, uint256 fee, uint256 volume) = _lastTaxed(vm.getRecordedLogs());

        uint256 paid = aliceBefore - alice.balance;
        assertEq(token.balanceOf(alice), tokensOut, "exactly the output asked for");
        assertEq(uint256(uint128(d.amount1())), tokensOut);
        assertEq(uint256(uint128(-d.amount0())), paid, "the delta is what she paid, tax included");
        assertTrue(isBuy, "reported as a buy");
        assertGt(fee, 0, "this shape used to pay nothing");
        assertEq(fee, volume * rate / 10_000, "the tax is the rate on the quote the pool charged");
        assertEq(paid, volume + fee, "the quote for the tokens, plus the tax on top");
        assertEq(hook.claimsHeld(), fee, "held as a claim, like an exact-input buy");
        assertEq(pm.balanceOf(address(hook), NATIVE_ID), fee);
        assertEq(address(pm).balance - pmBefore, paid, "the manager holds both the swap and the claim");
        assertEq(address(splitter).balance, 0);

        hook.flushClaims();
        assertEq(address(splitter).balance, fee);
        assertEq(address(pm).balance - pmBefore, volume, "what the pool itself kept is the volume");
    }

    // ---------------------------------------------------------------- 3. exact-input sell

    function test_exact_input_sell_takes_the_tax_out_of_the_quote_paid_out_straight_away() public {
        _pastTheWindow();
        _buyExactIn(alice, 1 ether);
        hook.flushClaims();
        uint256 splitterBefore = address(splitter).balance;
        uint256 aliceEthBefore = alice.balance;
        uint256 aliceTokensBefore = token.balanceOf(alice);
        uint256 tokensIn = aliceTokensBefore / 2;

        vm.recordLogs();
        BalanceDelta d = _sellExactIn(alice, tokensIn);
        (bool isBuy, uint256 fee, uint256 volume) = _lastTaxed(vm.getRecordedLogs());

        uint256 received = alice.balance - aliceEthBefore;
        uint256 taxed = address(splitter).balance - splitterBefore;
        assertFalse(isBuy);
        assertGt(received, 0);
        assertEq(taxed, fee, "the tax landed in the splitter inside the swap");
        assertEq(volume, received + fee, "volume is the gross the pool paid out");
        assertEq(fee, (received + fee) * SELL_TAX / 10_000);
        assertEq(uint256(uint128(d.amount0())), received, "the delta is the net of the tax");
        assertEq(uint256(uint128(-d.amount1())), tokensIn);
        assertEq(token.balanceOf(alice), aliceTokensBefore - tokensIn);
        assertEq(hook.claimsHeld(), 0, "an output-side tax is taken directly, never held");
        assertEq(pm.balanceOf(address(hook), NATIVE_ID), 0);
    }

    // ---------------------------------------------------------------- 4. exact-output sell

    function test_exact_output_sell_holds_the_tax_as_a_claim_and_the_seller_pays_it_in_tokens() public {
        _pastTheWindow();
        _buyExactIn(alice, 1 ether);
        hook.flushClaims();
        uint256 splitterBefore = address(splitter).balance;
        uint256 aliceEthBefore = alice.balance;
        uint256 aliceTokensBefore = token.balanceOf(alice);
        uint256 quoteOut = 0.1 ether;
        uint256 fee = quoteOut * SELL_TAX / 10_000; // 0.005 ETH

        uint256 snapshot = vm.snapshotState();
        vm.recordLogs();
        BalanceDelta d = _sellExactOut(alice, quoteOut);
        (bool isBuy, uint256 taxed, uint256 volume) = _lastTaxed(vm.getRecordedLogs());

        assertEq(alice.balance - aliceEthBefore, quoteOut, "exactly the output asked for, net of tax");
        assertEq(uint256(uint128(d.amount0())), quoteOut);
        assertFalse(isBuy);
        assertEq(taxed, fee);
        assertEq(volume, quoteOut + fee, "volume is what the pool paid out, the tax included");
        assertEq(hook.claimsHeld(), fee, "taken in beforeSwap, held as a claim");
        assertEq(pm.balanceOf(address(hook), NATIVE_ID), fee);
        assertEq(address(splitter).balance, splitterBefore, "nothing reaches the splitter until the next swap");
        uint256 tokensPaid = aliceTokensBefore - token.balanceOf(alice);
        assertGt(tokensPaid, 0);
        assertEq(tokensPaid, uint256(uint128(-d.amount1())));

        // The seller paid for it: the same tokens, sold exact-input from the same state, buy
        // quoteOut PLUS the tax out of the pool, not quoteOut alone.
        vm.revertToState(snapshot);
        vm.recordLogs();
        _sellExactIn(alice, tokensPaid);
        (, , uint256 grossForTheSameTokens) = _lastTaxed(vm.getRecordedLogs());
        assertApproxEqRel(grossForTheSameTokens, quoteOut + fee, 1e12, "the tokens bought quoteOut + tax");
        assertGt(grossForTheSameTokens, quoteOut + fee / 2, "and clearly more than quoteOut");
    }

    // ---------------------------------------------------------------- 5. the opening surcharge

    function test_the_opening_surcharge_hits_traders_but_not_the_portal_or_the_buyback() public {
        uint256 start = hook.launchTime();
        assertEq(block.timestamp, start, "the first instant of the launch");
        assertEq(hook.currentTaxBps(true), BUY_TAX + SNIPE_TAX);

        // a trader at the open: the launch tax plus the whole surcharge
        _buyExactIn(alice, 1 ether);
        assertEq(hook.claimsHeld(), 1 ether * (BUY_TAX + SNIPE_TAX) / 10_000, "55% of the trade");
        hook.flushClaims();

        // the portal at the open, straight against the manager: the base rate only
        uint256 before = token.balanceOf(address(this));
        _swapAsPortal(_buyExactInParams(1 ether));
        assertGt(token.balanceOf(address(this)), before);
        assertEq(hook.claimsHeld(), 1 ether * BUY_TAX / 10_000, "5%, the portal is not a snipe");
        hook.flushClaims();

        // the buyback module at the open, from the pot the two buys just filled: the base rate only
        splitter.sweep();
        uint256 pot = splitter.buybackPot();
        assertEq(pot, 0.6 ether * 9_000 / 10_000 * 2_500 / 10_000, "a quarter of the creator's nine tenths");
        uint256 supplyBefore = token.totalSupply();
        uint256 burned = module.run(address(token), 0);
        assertGt(burned, 0);
        assertEq(token.totalSupply(), supplyBefore - burned);
        assertEq(module.carried(address(token)), 0, "the whole pot fit under the impact cap");
        assertEq(address(module).balance, 0);
        assertEq(hook.claimsHeld(), pot * BUY_TAX / 10_000, "5%, the buyback is not a snipe");
        hook.flushClaims();

        // one second in, two thirds of the window remain and the surcharge is (2/3)^2 of itself
        vm.warp(start + 1);
        assertEq(hook.currentTaxBps(true), BUY_TAX + SNIPE_TAX * 4 / 9);
        _buyExactIn(bob, 1 ether);
        assertEq(hook.claimsHeld(), 1 ether * (BUY_TAX + SNIPE_TAX * 4 / 9) / 10_000, "27.22%");
        hook.flushClaims();

        // three seconds in, the same buy pays the launch tax and nothing else
        vm.warp(start + SNIPE_WINDOW);
        assertEq(hook.currentSnipeBps(), 0);
        _buyExactIn(bob, 1 ether);
        assertEq(hook.claimsHeld(), 1 ether * BUY_TAX / 10_000, "5%");
    }

    // ---------------------------------------------------------------- 6. one hook, one pool

    function test_a_second_pool_on_the_same_hook_cannot_swap() public {
        PoolKey memory foreign = PoolKey({
            currency0: Currency.wrap(address(0)),
            currency1: Currency.wrap(address(token)),
            fee: 3_000,
            tickSpacing: 60,
            hooks: IHooks(address(hook))
        });
        pm.initialize(foreign, TickMath.getSqrtPriceAtTick(TICK_START));
        assertTrue(PoolId.unwrap(foreign.toId()) != PoolId.unwrap(poolId));

        // The manager wraps a hook's revert in an ERC-7751 error: the hook, the entry point it
        // called, the hook's own reason, and the manager's context.
        bytes memory expected = abi.encodeWithSelector(
            CustomRevert.WrappedError.selector,
            address(hook),
            IHooks.beforeSwap.selector,
            abi.encodeWithSelector(HoodLaunchHook.WrongPool.selector),
            abi.encodeWithSelector(Hooks.HookCallFailed.selector)
        );
        vm.prank(alice);
        vm.expectRevert(expected);
        swapRouter.swap{value: 1 ether}(foreign, _buyExactInParams(1 ether), _settings(), "");

        assertFalse(hook.bonded());
        assertEq(hook.claimsHeld(), 0);
        assertEq(alice.balance, 1_000 ether, "nothing left her wallet");
    }

    function test_crossing_the_bond_tick_latches_and_the_latch_holds() public {
        _pastTheWindow();
        assertFalse(hook.bonded());
        assertEq(_tick(), TICK_START);

        // Enough to buy the entire position: the price stops one spacing under the bond, in the
        // empty range below it, rather than running to the end of the tick space.
        vm.expectEmit(false, false, false, false, address(hook));
        emit HoodLaunchHook.Bonded(0, 0);
        vm.prank(bob);
        swapRouter.swap{value: 40 ether}(
            key,
            SwapParams({
                zeroForOne: true,
                amountSpecified: -int256(40 ether),
                sqrtPriceLimitX96: TickMath.getSqrtPriceAtTick(TICK_BOND - SPACING)
            }),
            _settings(),
            ""
        );

        assertTrue(hook.bonded());
        assertLe(_tick(), TICK_BOND);
        assertGe(token.balanceOf(bob), SUPPLY * 999 / 1_000, "the whole position came out");
        assertLt(1_000 ether - bob.balance, 40 ether, "and the unfilled part of the input came back");

        // selling back over the line does not unset it
        _sellExactIn(bob, token.balanceOf(bob) / 2);
        assertGt(_tick(), TICK_BOND);
        assertTrue(hook.bonded(), "bonded is a latch, not a level");
    }

    // ---------------------------------------------------------------- 7. a treasury that cannot take ETH

    function test_a_treasury_that_rejects_native_only_blocks_its_own_claim() public {
        vm.etch(treasury, address(new RejectNative()).code);
        _pastTheWindow();
        _buyExactIn(alice, 2 ether);
        hook.flushClaims();
        splitter.sweep();
        assertEq(address(splitter).balance, 0.1 ether);
        assertEq(splitter.protocolClaimable(), 0.01 ether);

        vm.expectRevert(PairTransfer.NativeTransferFailed.selector);
        splitter.claimProtocol();
        assertEq(splitter.protocolClaimable(), 0.01 ether, "still owed, never lost");

        // everyone else's road stays open
        uint256 dividends = splitter.claimDividends(alice);
        assertApproxEqAbs(dividends, 0.036 ether, 2, "forty percent of the creator's nine tenths");
        assertApproxEqAbs(alice.balance, 1_000 ether - 2 ether + 0.036 ether, 2);

        vm.prank(creator);
        assertEq(splitter.claim(creator), 0.0225 ether);
        assertEq(creator.balance, 0.0225 ether);

        assertEq(splitter.pushLiquidity(), 0.009 ether);
        assertEq(address(locker).balance, 0.009 ether);

        uint256 supplyBefore = token.totalSupply();
        uint256 burned = module.run(address(token), 0);
        assertGt(burned, 0);
        assertEq(token.totalSupply(), supplyBefore - burned);
        assertEq(splitter.buybackPot(), 0);

        assertEq(splitter.protocolClaimable(), 0.01 ether);
        // What is left is the protocol's tenth plus the wei the per-share accumulator rounds away.
        assertLe(splitter.dividendsHeld(), 2);
        assertEq(address(splitter).balance, splitter.protocolClaimable() + splitter.dividendsHeld());
    }

    // ---------------------------------------------------------------- 8. the buyback impact cap

    function test_the_buyback_stops_at_the_impact_cap_and_carries_the_rest() public {
        _pastTheWindow();
        vm.deal(address(splitter), 50 ether);
        splitter.sweep();
        uint256 pot = splitter.buybackPot();
        assertEq(pot, 11.25 ether);

        int24 tickBefore = _tick();
        uint160 sqrtBefore = _sqrtPrice();
        uint256 supplyBefore = token.totalSupply();
        uint256 claimsBefore = hook.claimsHeld();

        uint256 burned = module.run(address(token), 0);

        int24 tickAfter = _tick();
        assertEq(int256(tickBefore) - int256(tickAfter), int256(module.MAX_IMPACT_TICKS()), "stopped exactly at the cap");
        assertGt(burned, 0);
        assertEq(token.totalSupply(), supplyBefore - burned, "what was bought was burned");
        assertEq(token.balanceOf(address(module)), 0);
        // The pool has one position and the whole run is one step through it, so the tokens that
        // came out are the position's token1 between the two prices, to the wei.
        assertEq(burned, FullMath.mulDiv(positionLiquidity, sqrtBefore - _sqrtPrice(), FixedPoint96.Q96));

        uint256 carried = module.carried(address(token));
        assertGt(carried, 0, "most of the pot did not fit");
        assertEq(address(module).balance, carried, "and it sits in the module");
        uint256 spent = pot - carried;
        uint256 fee = hook.claimsHeld() - claimsBefore;
        assertLt(spent, pot / 5);
        console2.log("buyback run 1: pot / spent / tax", pot, spent, fee);
        console2.log("buyback run 1: actually swapped", spent - fee);
        // The module sizes its input to the cap, so the tax is the base rate on what it spent and
        // not on the pot it was handed. Before that fix a capped run paid an effective 255%.
        assertApproxEqRel(fee * 10_000, spent * 500, 0.01e18, "taxed on what was spent, not on the pot");

        // A second run in the same block is refused. Otherwise the cap bounds one swap and nothing
        // else: a caller chains runs inside one transaction, walks the whole pot up the book and
        // sandwiches it, which is what the cap is there to prevent.
        vm.expectRevert(HoodBuybackModule.AlreadyRanThisBlock.selector);
        module.run(address(token), 0);

        // the next block's run starts from what was carried and moves the price by one more cap
        vm.roll(block.number + 1);
        uint256 burned2 = module.run(address(token), 0);
        assertEq(int256(tickAfter) - int256(_tick()), int256(module.MAX_IMPACT_TICKS()));
        assertGt(burned2, 0);
        assertEq(token.totalSupply(), supplyBefore - burned - burned2);
        assertLt(module.carried(address(token)), carried, "the carry shrinks");
        assertEq(address(module).balance, module.carried(address(token)));
        console2.log("buyback run 2: carried in / carried out", carried, module.carried(address(token)));
    }

    // ---------------------------------------------------------------- 9. gas

    function _measuredSwap(address who, SwapParams memory params, uint256 value) internal returns (uint256 used) {
        PoolSwapTest.TestSettings memory settings = _settings();
        vm.prank(who);
        uint256 before = gasleft();
        swapRouter.swap{value: value}(key, params, settings, "");
        used = before - gasleft();
    }

    function _holdTokens(address who) internal {
        _buyExactIn(who, 1 ether);
        hook.flushClaims();
        vm.prank(who);
        token.approve(address(swapRouter), type(uint256).max);
    }

    function test_gas_exact_input_buy_at_the_open() public {
        console2.log("gas exact-input buy, t=0", _measuredSwap(alice, _buyExactInParams(1 ether), 1 ether));
    }

    function test_gas_exact_output_buy_at_the_open() public {
        console2.log("gas exact-output buy, t=0", _measuredSwap(alice, _buyExactOutParams(1_000_000e18), 1 ether));
    }

    function test_gas_exact_input_sell_at_the_open() public {
        _holdTokens(alice);
        uint256 half = token.balanceOf(alice) / 2;
        console2.log("gas exact-input sell, t=0", _measuredSwap(alice, _sellExactInParams(half), 0));
    }

    function test_gas_exact_output_sell_at_the_open() public {
        _holdTokens(alice);
        console2.log("gas exact-output sell, t=0", _measuredSwap(alice, _sellExactOutParams(0.01 ether), 0));
    }

    function test_gas_exact_input_buy_after_the_window() public {
        _pastTheWindow();
        console2.log("gas exact-input buy, t=3", _measuredSwap(alice, _buyExactInParams(1 ether), 1 ether));
    }

    function test_gas_exact_output_buy_after_the_window() public {
        _pastTheWindow();
        console2.log("gas exact-output buy, t=3", _measuredSwap(alice, _buyExactOutParams(1_000_000e18), 1 ether));
    }

    function test_gas_exact_input_sell_after_the_window() public {
        _pastTheWindow();
        _holdTokens(alice);
        uint256 half = token.balanceOf(alice) / 2;
        console2.log("gas exact-input sell, t=3", _measuredSwap(alice, _sellExactInParams(half), 0));
    }

    function test_gas_exact_output_sell_after_the_window() public {
        _pastTheWindow();
        _holdTokens(alice);
        console2.log("gas exact-output sell, t=3", _measuredSwap(alice, _sellExactOutParams(0.01 ether), 0));
    }
}
