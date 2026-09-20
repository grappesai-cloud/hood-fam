// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

import {HoodCurve} from "../src/HoodCurve.sol";
import {HoodFactory} from "../src/HoodFactory.sol";
import {HoodDeployer} from "../src/HoodDeployer.sol";
import {HoodFeeRouter} from "../src/HoodFeeRouter.sol";
import {HoodStaking} from "../src/HoodStaking.sol";
import {UniswapV4Graduator} from "../src/graduation/UniswapV4Graduator.sol";
import {CurveConfig, FeeSplit, LaunchParams, Phase} from "../src/HoodTypes.sol";
import {IPoolManager, PoolKey, SwapParams} from "../src/interfaces/IExternal.sol";
import {MockUSD} from "./mocks/Mocks.sol";

interface IStateView {
    function getSlot0(bytes32 poolId)
        external
        view
        returns (uint160 sqrtPriceX96, int24 tick, uint24 protocolFee, uint24 lpFee);
    function getLiquidity(bytes32 poolId) external view returns (uint128 liquidity);
}

/// @notice The graduation path against the real Uniswap v4 deployment on Robinhood Chain 4663.
/// @dev Run with: forge test --match-path test/ForkV4.t.sol --fork-url robinhood
contract ForkV4Test is Test {
    address internal constant POOL_MANAGER = 0x8366a39CC670B4001A1121B8F6A443A643e40951;
    address internal constant POSITION_MANAGER = 0x58daec3116aae6D93017bAAea7749052E8a04fA7;
    address internal constant UNIVERSAL_ROUTER = 0x8876789976dEcBfCbBbe364623C63652db8C0904;
    address internal constant PERMIT2 = 0x000000000022D473030F116dDEE9F6B43aC78BA3;
    address internal constant STATE_VIEW = 0xF3334192D15450CdD385c8B70e03f9A6bD9E673b;
    uint160 internal constant MIN_SQRT_PRICE = 4295128739;

    HoodFactory internal factory;
    HoodStaking internal staking;
    HoodFeeRouter internal router;
    UniswapV4Graduator internal graduator;

    address internal owner = makeAddr("owner");
    address internal treasury = makeAddr("treasury");
    address internal creator = makeAddr("creator");
    address internal whale = makeAddr("whale");

    uint256 internal configId;

    function setUp() public {
        vm.createSelectFork(vm.rpcUrl("robinhood"));

        HoodDeployer bytecode = new HoodDeployer();
        factory = new HoodFactory(owner, treasury, address(bytecode));
        bytecode.initialize(address(factory));
        staking = new HoodStaking(address(factory));
        router = new HoodFeeRouter(address(factory), address(staking));
        graduator =
        new UniswapV4Graduator(
            address(factory), POOL_MANAGER, POSITION_MANAGER, UNIVERSAL_ROUTER, PERMIT2, STATE_VIEW
        );

        vm.startPrank(owner);
        factory.setModules(address(router), address(staking), address(graduator));
        factory.setLaunchFee(0.0005 ether);
        configId = factory.addConfig(
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

        vm.deal(creator, 100 ether);
        vm.deal(whale, 100 ether);
    }

    function _toStakers() internal pure returns (FeeSplit memory) {
        return FeeSplit({stakersBps: 10_000, buybackBps: 0, liquidityBps: 0, creatorBps: 0});
    }

    function _toBuyback() internal pure returns (FeeSplit memory) {
        return FeeSplit({stakersBps: 0, buybackBps: 10_000, liquidityBps: 0, creatorBps: 0});
    }

    function _toLiquidity() internal pure returns (FeeSplit memory) {
        return FeeSplit({stakersBps: 0, buybackBps: 0, liquidityBps: 10_000, creatorBps: 0});
    }

    function _toCreator() internal pure returns (FeeSplit memory) {
        return FeeSplit({stakersBps: 0, buybackBps: 0, liquidityBps: 0, creatorBps: 10_000});
    }

    function _launch(FeeSplit memory split, string memory symbol)
        internal
        returns (address token, HoodCurve curve)
    {
        LaunchParams memory p = LaunchParams({
            name: "Hood Fam",
            symbol: symbol,
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
            salt: keccak256(bytes(symbol)),
            econ: bytes32(0)
        });
        vm.prank(creator);
        (address t, address c,) = factory.launch{value: 0.0005 ether}(p);
        return (t, HoodCurve(payable(c)));
    }

    function _poolId(PoolKey memory key) internal pure returns (bytes32) {
        return keccak256(abi.encode(key));
    }

    function _sellOutAndFinalize(HoodCurve curve) internal {
        uint256 left = curve.remaining();
        (uint256 needed,) = curve.quoteBuyExactOut(left);
        vm.deal(whale, needed + 1 ether);
        vm.prank(whale);
        curve.buyExactOut{value: needed}(left, needed, whale);
        curve.finalize();
    }

    function test_fork_graduation_opens_a_real_v4_pool() public {
        (address token, HoodCurve curve) = _launch(_toStakers(), "FAM1");
        uint256 lpSupply = curve.lpSupply();
        _sellOutAndFinalize(curve);

        assertEq(uint8(curve.phase()), uint8(Phase.Graduated));
        assertTrue(graduator.isGraduated(token));

        (PoolKey memory key, uint256 tokenId) = graduator.positionOf(token);
        assertGt(tokenId, 0);

        (uint160 sqrtPriceX96,,,) = IStateView(STATE_VIEW).getSlot0(_poolId(key));
        assertGt(sqrtPriceX96, 0, "the pool is initialized");
        uint128 liquidity = IStateView(STATE_VIEW).getLiquidity(_poolId(key));
        assertGt(liquidity, 0, "and it has liquidity");

        // the pool holds what the curve handed over, give or take the rounding headroom
        assertApproxEqRel(IERC20(token).balanceOf(POOL_MANAGER), lpSupply, 0.001e18);
        assertEq(IERC20(token).balanceOf(address(graduator)), 0, "no token left behind");
        assertEq(address(graduator).balance, 0, "no pair left behind");

        // the position NFT is held by a contract that cannot transfer or unwind it
        assertEq(IERC20(POSITION_MANAGER).balanceOf(address(graduator)), 1);
    }

    /// @dev A dollar-paired curve graduating runs the ERC-20 branch of the graduator: Permit2 for
    ///      both currencies at the mint, sync/settle for the donation, Permit2 again for the router
    ///      swap on a buyback. None of that is touched by a native launch.
    function test_fork_a_dollar_paired_curve_graduates_and_buys_back_in_dollars() public {
        MockUSD usd = new MockUSD();
        vm.startPrank(owner);
        factory.setPair(address(usd), true, 0);
        uint256 usdConfig = factory.addConfig(
            CurveConfig({
                totalSupply: 1_000_000_000e18,
                curveSupplyBps: 8000,
                startCap: 5_000e6,
                graduationCap: 50_000e6,
                liquidityBps: 9000,
                protocolFeeBps: 30,
                creatorFeeBps: 70,
                poolFee: 3000,
                tickSpacing: 60,
                enabled: true
            })
        );
        vm.stopPrank();

        LaunchParams memory p = LaunchParams({
            name: "Dollar Curve", symbol: "USDC1", image: "ipfs://usd", description: "", website: "",
            twitter: "", telegram: "", pairToken: address(usd), configId: usdConfig,
            feeSplit: _toBuyback(), creatorFeeRecipient: creator, firstBuy: 0, firstBuyLock: 0,
            salt: bytes32(uint256(77)), econ: bytes32(0)
        });
        vm.prank(creator);
        (address token, address curveAddr,) = factory.launch{value: 0.0005 ether}(p);
        HoodCurve curve = HoodCurve(payable(curveAddr));

        // buy the whole curve in dollars and open the pool
        usd.mint(whale, 10_000_000e6);
        uint256 left = curve.remaining();
        (uint256 needed,) = curve.quoteBuyExactOut(left);
        vm.startPrank(whale);
        usd.approve(address(curve), type(uint256).max);
        curve.buyExactOut(left, needed, whale);
        vm.stopPrank();
        curve.finalize();

        assertTrue(graduator.isGraduated(token));
        (PoolKey memory key,) = graduator.positionOf(token);
        (uint160 sqrtPriceX96,,,) = IStateView(STATE_VIEW).getSlot0(_poolId(key));
        assertGt(sqrtPriceX96, 0, "the dollar pool is open");
        assertGt(IStateView(STATE_VIEW).getLiquidity(_poolId(key)), 0);
        assertEq(usd.balanceOf(address(graduator)), 0, "no dollars left behind");
        assertEq(IERC20(token).balanceOf(address(graduator)), 0, "no token left behind");

        // the booked creator fee buys the token back out of the dollar pool and burns it
        uint256 booked = router.accrued(token);
        assertGt(booked, 0);
        uint256 supplyBefore = IERC20(token).totalSupply();
        router.flushBuyback(token, 1);
        assertLt(IERC20(token).totalSupply(), supplyBefore, "bought back in dollars, burned");
        assertEq(usd.balanceOf(address(graduator)), 0);
        assertEq(router.accrued(token), 0);

        // and the position's dollar fees come home
        graduator.collect(token);
        assertGt(router.accrued(token), 0, "the pool fee, in dollars, back in the split");
    }

    function test_fork_the_pool_is_opened_and_priced_inside_the_launch_transaction() public {
        (address token, HoodCurve curve) = _launch(_toStakers(), "FAM5");

        // native currency sorts first, so currency0 is ETH and currency1 is the token
        PoolKey memory key =
            PoolKey({currency0: address(0), currency1: token, fee: 3000, tickSpacing: 60, hooks: address(0)});
        (uint160 sqrtPriceX96,,,) = IStateView(STATE_VIEW).getSlot0(_poolId(key));
        assertGt(sqrtPriceX96, 0, "nobody gets to open this pool before we do");

        // priced at the raise it is heading for: pool supply against nine tenths of the raise
        uint256 plannedPair = (curve.raiseTarget() * 9000) / 10_000;
        // price = token per ETH, so the ETH the pool is priced for is lpSupply / price
        uint256 impliedPair =
            Math.mulDiv(curve.lpSupply(), 1 << 192, uint256(sqrtPriceX96) * uint256(sqrtPriceX96));
        assertApproxEqRel(impliedPair, plannedPair, 0.01e18);

        // and graduating into that already-open pool works
        _sellOutAndFinalize(curve);
        assertTrue(graduator.isGraduated(token));
        assertGt(IStateView(STATE_VIEW).getLiquidity(_poolId(key)), 0);
    }

    function test_fork_anyone_can_swap_the_graduated_pool() public {
        (address token, HoodCurve curve) = _launch(_toBuyback(), "FAM2");
        _sellOutAndFinalize(curve);

        // the creator fee booked during the sell-out buys the token back out of the real pool
        uint256 booked = router.accrued(token);
        assertGt(booked, 0);
        uint256 supplyBefore = IERC20(token).totalSupply();

        router.flushBuyback(token, 1);

        assertLt(IERC20(token).totalSupply(), supplyBefore, "the buyback burned what it bought");
        assertEq(router.accrued(token), 0);
        assertEq(IERC20(token).balanceOf(address(graduator)), 0);
    }

    function test_fork_pool_fees_come_back_to_the_fee_split() public {
        (address token, HoodCurve curve) = _launch(_toBuyback(), "FAM3");
        _sellOutAndFinalize(curve);

        // a real swap through the pool, which is what makes the position earn a fee
        router.flushBuyback(token, 1);
        assertEq(router.accrued(token), 0);

        graduator.collect(token);
        uint256 fees = router.accrued(token);
        assertGt(fees, 0, "the locked position earned the pool fee and handed it back");
        assertEq(IERC20(token).balanceOf(address(graduator)), 0);
        assertEq(address(graduator).balance, 0);
    }

    function test_fork_liquidity_compounding_donates_to_the_pool() public {
        (address token, HoodCurve curve) = _launch(_toLiquidity(), "FAM4");
        _sellOutAndFinalize(curve);
        (PoolKey memory key,) = graduator.positionOf(token);

        uint256 booked = router.accrued(token);
        assertGt(booked, 0);
        uint256 poolBefore = POOL_MANAGER.balance;

        router.flush(token);

        assertEq(router.accrued(token), 0);
        assertEq(POOL_MANAGER.balance - poolBefore, booked, "the donation landed in the pool");
        assertEq(address(graduator).balance, 0);
        (uint160 sqrtPriceX96,,,) = IStateView(STATE_VIEW).getSlot0(_poolId(key));
        assertGt(sqrtPriceX96, 0);
    }

    /// @dev The pool is opened inside the launch transaction so that nobody else opens it first,
    ///      but it holds no liquidity until graduation, and a swap in an EMPTY v4 pool consumes
    ///      nothing: it walks the price to whatever limit it is handed, for the cost of gas. So a
    ///      stranger (or the creator, on a launch whose split pays them) could pick the price
    ///      the raise gets minted at, and with it how much of the raise ends up in the pool at all.
    ///      Graduation therefore pins the price to the ratio actually raised.
    function test_fork_a_stranger_cannot_choose_the_price_the_raise_graduates_at() public {
        (address token, HoodCurve curve) = _launch(_toCreator(), "FAM5");
        uint256 lpSupply = curve.lpSupply();
        PoolKey memory key = _emptyKeyFor(token);
        bytes32 id = _poolId(key);

        (uint160 openedAt,,,) = IStateView(STATE_VIEW).getSlot0(id);
        assertGt(openedAt, 0, "the launch opened the pool");
        assertEq(IStateView(STATE_VIEW).getLiquidity(id), 0, "and it is empty until graduation");

        // one transaction, no capital, no token: the price is now at the floor
        EmptyPoolPriceMover mover = new EmptyPoolPriceMover(POOL_MANAGER);
        mover.move(key, true, MIN_SQRT_PRICE + 1);
        (uint160 moved,,,) = IStateView(STATE_VIEW).getSlot0(id);
        assertEq(moved, MIN_SQRT_PRICE + 1, "anybody can walk an empty pool anywhere");

        // sell the curve out and graduate into that pool
        uint256 left = curve.remaining();
        (uint256 needed,) = curve.quoteBuyExactOut(left);
        vm.deal(whale, needed + 1 ether);
        vm.prank(whale);
        curve.buyExactOut{value: needed}(left, needed, whale);

        uint256 forLp = Math.mulDiv(curve.reserve(), 9000, 10_000) + curve.bonus();
        uint256 poolBefore = POOL_MANAGER.balance;
        uint256 creatorBefore = creator.balance;
        curve.finalize();

        // the position is where the raise says it is, not where the stranger left the price
        (uint160 graduatedAt,,,) = IStateView(STATE_VIEW).getSlot0(id);
        assertApproxEqRel(graduatedAt, openedAt, 0.05e18, "priced by the raise, not by the stranger");
        assertGt(IStateView(STATE_VIEW).getLiquidity(id), 0);
        assertApproxEqRel(POOL_MANAGER.balance - poolBefore, forLp, 0.02e18, "the raise went into the pool");
        assertApproxEqRel(IERC20(token).balanceOf(POOL_MANAGER), lpSupply, 0.01e18, "and so did the supply");
        assertEq(IERC20(token).balanceOf(address(graduator)), 0, "nothing burned out the side door");
        assertEq(creator.balance, creatorBefore, "and nothing leaked to the fee router");
    }

    /// @dev The key of a pool that has been opened but not yet graduated into. Native sorts first,
    ///      the handler is hookless, and the fee and spacing come from the preset.
    function _emptyKeyFor(address token) internal pure returns (PoolKey memory) {
        return PoolKey({currency0: address(0), currency1: token, fee: 3000, tickSpacing: 60, hooks: address(0)});
    }
}

/// @notice A swap in a pool with no liquidity: it fills nothing and lands on its own price limit.
/// @dev This is the whole attack behind `test_fork_a_stranger_cannot_choose_the_price_...`, in the
///      smallest contract that can do it. One wei of exact input, a limit at the far end.
contract EmptyPoolPriceMover {
    IPoolManager internal immutable poolManager;

    constructor(address poolManager_) {
        poolManager = IPoolManager(poolManager_);
    }

    function move(PoolKey memory key, bool zeroForOne, uint160 limit) external {
        poolManager.unlock(abi.encode(key, zeroForOne, limit));
    }

    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        (PoolKey memory key, bool zeroForOne, uint160 limit) = abi.decode(data, (PoolKey, bool, uint160));
        poolManager.swap(
            key, SwapParams({zeroForOne: zeroForOne, amountSpecified: -1, sqrtPriceLimitX96: limit}), bytes("")
        );
        return bytes("");
    }
}
