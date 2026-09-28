// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {ModifyLiquidityParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {PoolModifyLiquidityTest} from "@uniswap/v4-core/src/test/PoolModifyLiquidityTest.sol";

import {HoodPortal} from "../src/direct/HoodPortal.sol";
import {HoodDirectDeployer} from "../src/direct/HoodDirectDeployer.sol";
import {HoodLaunchToken} from "../src/direct/HoodLaunchToken.sol";
import {HoodLaunchHook} from "../src/direct/HoodLaunchHook.sol";
import {HoodLocker} from "../src/direct/HoodLocker.sol";
import {HoodRevenueSplitter} from "../src/direct/HoodRevenueSplitter.sol";
import {HoodBuybackModule} from "../src/direct/HoodBuybackModule.sol";
import {HoodOpeningAuction} from "../src/direct/HoodOpeningAuction.sol";
import {Allocations, DirectConfig, Socials} from "../src/direct/DirectTypes.sol";
import {BagSplits, PenaltyConfig} from "../src/bag/BagTypes.sol";
import {ExactInputSingleParams, PoolKey as RhPoolKey, V4Actions} from "../src/interfaces/IExternal.sol";
import {HoodFactory} from "../src/HoodFactory.sol";
import {HoodDeployer} from "../src/HoodDeployer.sol";
import {HoodStaking} from "../src/HoodStaking.sol";
import {HoodFeeRouter} from "../src/HoodFeeRouter.sol";
import {UniswapV4Graduator} from "../src/graduation/UniswapV4Graduator.sol";
import {LaunchMode} from "../src/HoodTypes.sol";
import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";
import {MockUSD} from "./mocks/Mocks.sol";
import {MockBag} from "./mocks/DirectMocks.sol";
import {HoodTokenLock} from "../src/HoodTokenLock.sol";
import {TeamBuy} from "../src/TeamTypes.sol";

interface IPermit2 {
    function approve(address token, address spender, uint160 amount, uint48 expiration) external;
}

interface IUR {
    function execute(bytes calldata commands, bytes[] calldata inputs, uint256 deadline) external payable;
}

interface IStateView {
    function getSlot0(bytes32 poolId) external view returns (uint160 sqrtPriceX96, int24 tick, uint24, uint24);
    function getLiquidity(bytes32 poolId) external view returns (uint128);
}

/// @dev The registry the portal reports to, reduced to what a team launch reads: the token lock.
contract LockRegistry {
    address public firstBuyLocker;

    constructor(address lock) {
        firstBuyLocker = lock;
    }

    function registerDirectLaunch(address, address, address, address, address, address, string calldata, string calldata)
        external {}
}

/// @notice A direct launch, end to end, against the real Uniswap v4 on chain 4663.
/// @dev Run with: forge test --match-path test/ForkDirect.t.sol --fork-url robinhood
contract ForkDirectTest is Test {
    address internal constant POOL_MANAGER = 0x8366a39CC670B4001A1121B8F6A443A643e40951;
    address internal constant POSITION_MANAGER = 0x58daec3116aae6D93017bAAea7749052E8a04fA7;
    address internal constant UNIVERSAL_ROUTER = 0x8876789976dEcBfCbBbe364623C63652db8C0904;
    address internal constant PERMIT2 = 0x000000000022D473030F116dDEE9F6B43aC78BA3;
    address internal constant STATE_VIEW = 0xF3334192D15450CdD385c8B70e03f9A6bD9E673b;

    uint24 internal constant POOL_FEE = 10_000; // 1%, the Argus tier
    int24 internal constant SPACING = 200;
    // The token sorts into currency1 against native ETH, so the price is tokens per ETH and it
    // falls as the token gets dearer. Start: ten ETH of fully diluted value. Bond: a hundred.
    int24 internal constant TICK_START = 184_200;
    int24 internal constant TICK_BOND = 161_200;
    uint256 internal constant SUPPLY = 1_000_000_000e18;

    HoodPortal internal portal;
    HoodDirectDeployer internal deployer;
    HoodBuybackModule internal buyback;
    /// @notice Where the platform's 70 bps and the launch fee land. A mock that records and holds;
    ///         the real Bag has its own suite and the curve fork suites stand up the real one.
    MockBag internal bag;
    address internal owner = makeAddr("owner");
    address internal treasury = makeAddr("treasury");
    address internal creator = makeAddr("creator");
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");

    HoodLaunchToken internal token;
    HoodLaunchHook internal hook;
    HoodRevenueSplitter internal splitter;
    HoodLocker internal locker;
    PoolKey internal key;

    function setUp() public {
        vm.createSelectFork(vm.rpcUrl("robinhood"));

        deployer = new HoodDirectDeployer();
        HoodLaunchToken implementation = new HoodLaunchToken();
        portal = new HoodPortal(
            owner, treasury, address(deployer), address(implementation),
            POOL_MANAGER, POSITION_MANAGER, PERMIT2
        );
        deployer.initialize(address(portal));
        buyback = new HoodBuybackModule(POOL_MANAGER, address(portal));
        bag = new MockBag();
        vm.startPrank(owner);
        portal.setBuybackModule(address(buyback));
        portal.setBag(address(bag));
        portal.setAuction(address(new HoodOpeningAuction(address(portal))));
        vm.stopPrank();

        vm.deal(creator, 100 ether);
        vm.deal(alice, 100 ether);
        vm.deal(bob, 100 ether);

        _launch();
    }

    /// @dev A v4 hook's permissions live in the low bits of its address, so the salt is mined until
    ///      the address lands on them. Off chain this is a loop in the SDK; here it is a loop.
    function _mineHookSalt() internal view returns (bytes32) {
        return _mineHookSalt(0);
    }

    /// @dev A second launch in the same test needs a salt setUp did not already spend: the same
    ///      salt is the same CREATE2 address, and deploying there twice reverts.
    function _mineHookSalt(uint256 start) internal view returns (bytes32) {
        return _mineHookSaltFor(deployer, creator, start);
    }

    /// @dev The portal binds the salt to the creator before CREATE2, so the miner has to as well.
    function _mineHookSaltFor(HoodDirectDeployer d, address creator, uint256 start) internal view returns (bytes32) {
        bytes32 initHash = d.hookInitCodeHash(POOL_MANAGER);
        for (uint256 i = start; i < start + 200_000; ++i) {
            bytes32 salt = bytes32(i);
            bytes32 bound = keccak256(abi.encode(creator, salt));
            address predicted = address(
                uint160(uint256(keccak256(abi.encodePacked(bytes1(0xff), address(d), bound, initHash))))
            );
            if (uint160(predicted) & 0x3FFF == 0xCC) return salt;
        }
        revert("no salt found");
    }

    function _launch() internal {
        DirectConfig memory config = DirectConfig({
            buyTaxBps: 500,
            sellTaxBps: 500,
            snipeTaxBps: 5_000,
            snipeDecaySeconds: 3,
            restrictionBlocks: 30,
            maxHoldBps: 500,
            maxBuyBps: 550,
            tickStart: TICK_START,
            tickBond: TICK_BOND,
            allocations: Allocations(2_500, 2_500, 4_000, 1_000),
            penalties: PenaltyConfig(0, 0, 0, 0, 0, false),
            auctionBlocks: 0
        });

        HoodPortal.LaunchInput memory input = HoodPortal.LaunchInput({
            name: "Hood Fam",
            symbol: "FAM",
            logo: "ipfs://logo",
            description: "the fam takes the fee",
            socials: Socials("@hoodfam", "t.me/hoodfam", "discord.gg/hoodfam", "https://hood.fam", "hoodfam.eth"),
            quote: address(0),
            creatorFeeRecipient: alice,
            supply: SUPPLY,
            poolFee: POOL_FEE,
            tickSpacing: SPACING,
            config: config,
            salt: bytes32(uint256(1)),
            initialBuy: 0.2 ether
        });

        // Mine first: the salt lookup is an external call, and it would eat the prank.
        bytes32 hookSalt = _mineHookSalt();
        vm.prank(creator);
        HoodPortal.Addresses memory out = portal.createLaunch{value: 0.002 ether + 0.2 ether}(input, hookSalt);

        token = HoodLaunchToken(out.token);
        hook = HoodLaunchHook(payable(out.hook));
        splitter = HoodRevenueSplitter(payable(out.splitter));
        assertEq(splitter.creator(), alice, "the launcher's fee recipient is independent from the launcher");
        locker = HoodLocker(payable(out.locker));
        key = PoolKey({
            currency0: Currency.wrap(address(0)),
            currency1: Currency.wrap(out.token),
            fee: POOL_FEE,
            tickSpacing: SPACING,
            hooks: IHooks(out.hook)
        });
    }

    /// @dev The pool opens at about ten ETH of fully diluted value, so a 5% hold cap is about half
    ///      an ETH of buying while the window is open. Past it, size is unrestricted.
    function _pastTheWindow() internal {
        vm.roll(block.number + 31);
        vm.warp(block.timestamp + 10);
    }

    function _poolId() internal view returns (bytes32) {
        return keccak256(abi.encode(key));
    }

    function _buy(address who, uint256 amountIn) internal {
        _buyOnDefault(who, amountIn);
    }

    function _buyOnDefault(address who, uint256 amountIn) internal {
        RhPoolKey memory rhKey = RhPoolKey({
            currency0: address(0),
            currency1: address(token),
            fee: POOL_FEE,
            tickSpacing: SPACING,
            hooks: address(hook)
        });
        bytes memory actions =
            abi.encodePacked(V4Actions.SWAP_EXACT_IN_SINGLE, V4Actions.SETTLE_ALL, V4Actions.TAKE_ALL);
        bytes[] memory params = new bytes[](3);
        params[0] = abi.encode(
            ExactInputSingleParams({
                poolKey: rhKey,
                zeroForOne: true,
                amountIn: uint128(amountIn),
                amountOutMinimum: 0,
                minHopPriceX36: 0,
                hookData: bytes("")
            })
        );
        params[1] = abi.encode(address(0), amountIn);
        params[2] = abi.encode(address(token), uint256(0));

        bytes memory commands = abi.encodePacked(V4Actions.CMD_V4_SWAP);
        bytes[] memory inputs = new bytes[](1);
        inputs[0] = abi.encode(actions, params);

        vm.prank(who);
        IUR(UNIVERSAL_ROUTER).execute{value: amountIn}(commands, inputs, block.timestamp);
    }

    // ---------------------------------------------------------------- tests

    /// @dev The two machines are one platform or they are two products wearing the same logo. This
    ///      is the seam: a direct launch has to land in the same registry the curve launches use,
    ///      under the same ticker lock, feeding the same volume counter.
    function test_fork_a_direct_launch_lands_in_the_shared_registry() public {
        HoodDeployer bytecode = new HoodDeployer();
        HoodFactory factory = new HoodFactory(address(this), treasury, address(bytecode));
        bytecode.initialize(address(factory));
        HoodStaking staking = new HoodStaking(address(factory));
        HoodFeeRouter feeRouter = new HoodFeeRouter(address(factory), address(staking));
        UniswapV4Graduator graduator = new UniswapV4Graduator(
            address(factory), POOL_MANAGER, POSITION_MANAGER, UNIVERSAL_ROUTER, PERMIT2, STATE_VIEW
        );
        factory.setModules(address(feeRouter), address(staking), address(graduator));
        factory.setPair(address(0), true, 1 ether); // a low bar, so one buy trips the ticker lock
        factory.setPortal(address(portal));

        HoodPortal freshPortal;
        {
            HoodDirectDeployer d2 = new HoodDirectDeployer();
            HoodLaunchToken impl2 = new HoodLaunchToken();
            freshPortal = new HoodPortal(
                owner, treasury, address(d2), address(impl2), POOL_MANAGER, POSITION_MANAGER, PERMIT2
            );
            d2.initialize(address(freshPortal));
            vm.startPrank(owner);
            freshPortal.setBuybackModule(address(new HoodBuybackModule(POOL_MANAGER, address(freshPortal))));
            freshPortal.setRegistry(address(factory));
            freshPortal.setBag(address(bag));
            freshPortal.setAuction(address(new HoodOpeningAuction(address(freshPortal))));
            vm.stopPrank();
            factory.setPortal(address(freshPortal));

            bytes32 salt2 = _mineSaltFor(d2);
            DirectConfig memory config = DirectConfig({
                buyTaxBps: 500, sellTaxBps: 500, snipeTaxBps: 0, snipeDecaySeconds: 0,
                restrictionBlocks: 0, maxHoldBps: 10_000, maxBuyBps: 10_000,
                tickStart: TICK_START, tickBond: TICK_BOND,
                allocations: Allocations(2_500, 2_500, 4_000, 1_000),
            penalties: PenaltyConfig(0, 0, 0, 0, 0, false),
            auctionBlocks: 0
            });
            HoodPortal.LaunchInput memory input = HoodPortal.LaunchInput({
                name: "Shared", symbol: "SHARED", logo: "ipfs://shared", description: "one registry",
                socials: Socials("", "", "", "", ""), quote: address(0), creatorFeeRecipient: creator, supply: SUPPLY,
                poolFee: POOL_FEE, tickSpacing: SPACING, config: config, salt: bytes32(uint256(7)),
                initialBuy: 0
            });
            vm.prank(creator);
            HoodPortal.Addresses memory out = freshPortal.createLaunch{value: 0.002 ether}(input, salt2);

            // the registry knows it, and knows which machine made it
            assertTrue(factory.getLaunch(out.token).exists);
            assertEq(uint8(factory.getLaunch(out.token).mode), uint8(LaunchMode.Direct));
            assertEq(factory.getLaunch(out.token).hook, out.hook);
            assertEq(factory.getLaunch(out.token).curve, address(0));

            // and a trade on it feeds the same ticker lock a curve launch would feed
            assertTrue(factory.isSymbolAvailable("SHARED"));
            _buyOn(out.token, out.hook, bob, 2 ether);
            assertFalse(factory.isSymbolAvailable("SHARED"), "volume from a hook locks a ticker too");
            assertFalse(factory.isSymbolAvailable("shared"), "and case does not get you around it");
        }
    }

    /// @dev A dollar-quoted launch runs the ERC-20 branch of every contract in the machine: pulling
    ///      the quote, settling it against the PoolManager, sweeping it in the splitter. Which side
    ///      of the price the position sits on depends on how the clone's address sorts against the
    ///      quote's, so the test predicts the clone and picks the direction the way the app would.
    function test_fork_a_dollar_quoted_launch_runs_the_erc20_branch_end_to_end() public {
        MockUSD usd = new MockUSD();
        vm.prank(owner);
        portal.setQuote(address(usd), true);

        bytes32 tokenSalt = bytes32(uint256(11));
        address predicted = Clones.predictDeterministicAddress(
            portal.tokenImplementation(), keccak256(abi.encode(creator, tokenSalt)), address(deployer)
        );
        bool tokenIsZero = predicted < address(usd);

        // ten thousand dollars at the open, a hundred thousand at the bond, six-decimal quote
        // price = token1/token0 in raw units
        int24 openTick;
        int24 bondTick;
        {
            // token wei per usd unit = 1e27 / 10_000e6 = 1e17 -> tick = ln(1e17)/ln(1.0001)
            // as token1: price = tokens per usd, falls as the token gets dearer (bond below open)
            // as token0: price = usd per token, rises as the token gets dearer (bond above open)
            int24 tenK = 391_400; // ln(1e17)/ln(1.0001) = 391,415 -> spacing 200
            int24 hundredK = 368_400; // ln(1e16)/ln(1.0001) = 368,389 -> spacing 200
            if (tokenIsZero) {
                openTick = -tenK;
                bondTick = -hundredK;
            } else {
                openTick = tenK;
                bondTick = hundredK;
            }
        }

        DirectConfig memory config = DirectConfig({
            buyTaxBps: 500, sellTaxBps: 500, snipeTaxBps: 0, snipeDecaySeconds: 0,
            restrictionBlocks: 0, maxHoldBps: 10_000, maxBuyBps: 10_000,
            tickStart: openTick, tickBond: bondTick,
            allocations: Allocations(2_500, 2_500, 4_000, 1_000),
            penalties: PenaltyConfig(0, 0, 0, 0, 0, false),
            auctionBlocks: 0
        });
        HoodPortal.LaunchInput memory input = HoodPortal.LaunchInput({
            name: "Dollar", symbol: "USDFAM", logo: "", description: "",
            socials: Socials("", "", "", "", ""), quote: address(usd), creatorFeeRecipient: creator, supply: SUPPLY,
            poolFee: POOL_FEE, tickSpacing: SPACING, config: config, salt: tokenSalt,
            initialBuy: 500e6
        });

        usd.mint(creator, 1_000_000e6);
        usd.mint(alice, 1_000_000e6);
        bytes32 hookSalt = _mineHookSalt(3_000_000);
        vm.startPrank(creator);
        usd.approve(address(portal), type(uint256).max);
        HoodPortal.Addresses memory out = portal.createLaunch{value: 0.002 ether}(input, hookSalt);
        vm.stopPrank();

        assertEq(out.token, predicted, "the clone landed where the app predicted");
        assertGt(IERC20(out.token).balanceOf(creator), 0, "the dollar first buy landed");

        // a dollar trade through the router, and the tax lands in the splitter as dollars
        vm.startPrank(alice);
        usd.approve(PERMIT2, type(uint256).max);
        IPermit2(PERMIT2).approve(address(usd), UNIVERSAL_ROUTER, type(uint160).max, type(uint48).max);
        vm.stopPrank();
        _buyWith(address(usd), out.token, out.hook, tokenIsZero, alice, 1_000e6);
        HoodLaunchHook(payable(out.hook)).flushClaims();

        // 5% creator tax plus the 30 bps creator leg of the platform fee, on both buys, in dollars
        assertApproxEqRel(usd.balanceOf(out.splitter), 79.5e6, 0.02e18, "five percent and thirty bps of both buys");
        HoodRevenueSplitter(payable(out.splitter)).sweep();
        assertEq(usd.balanceOf(treasury), 0, "nothing reaches the treasury by hand: the platform's share is the Bag's");
        assertApproxEqRel(bag.total(bag.TRADE(), address(usd)), 10.5e6, 0.02e18, "70 bps of both buys, in dollars, in the Bag");
        assertGt(HoodRevenueSplitter(payable(out.splitter)).pendingDividends(alice), 0);

        // the buyback module's ERC-20 branch
        uint256 supplyBefore = IERC20(out.token).totalSupply();
        buyback.run(out.token, 1);
        assertLt(IERC20(out.token).totalSupply(), supplyBefore, "bought back with dollars and burned");

        // the locker's ERC-20 branch
        HoodLocker(payable(out.locker)).harvestFees();
    }

    function _buyWith(address quote, address token_, address hook_, bool tokenIsZero, address who, uint256 amountIn) internal {
        (address c0, address c1) = tokenIsZero ? (token_, quote) : (quote, token_);
        RhPoolKey memory rhKey = RhPoolKey({currency0: c0, currency1: c1, fee: POOL_FEE, tickSpacing: SPACING, hooks: hook_});
        bytes memory actions =
            abi.encodePacked(V4Actions.SWAP_EXACT_IN_SINGLE, V4Actions.SETTLE_ALL, V4Actions.TAKE_ALL);
        bytes[] memory params = new bytes[](3);
        params[0] = abi.encode(
            ExactInputSingleParams({
                poolKey: rhKey, zeroForOne: !tokenIsZero, amountIn: uint128(amountIn),
                amountOutMinimum: 0, minHopPriceX36: 0, hookData: bytes("")
            })
        );
        params[1] = abi.encode(quote, amountIn);
        params[2] = abi.encode(token_, uint256(0));
        bytes memory commands = abi.encodePacked(V4Actions.CMD_V4_SWAP);
        bytes[] memory inputs = new bytes[](1);
        inputs[0] = abi.encode(actions, params);
        vm.prank(who);
        IUR(UNIVERSAL_ROUTER).execute(commands, inputs, block.timestamp);
    }

    function _mineSaltFor(HoodDirectDeployer d) internal view returns (bytes32) {
        return _mineHookSaltFor(d, creator, 0);
    }

    function _buyOn(address token_, address hook_, address who, uint256 amountIn) internal {
        RhPoolKey memory rhKey = RhPoolKey({
            currency0: address(0), currency1: token_, fee: POOL_FEE, tickSpacing: SPACING, hooks: hook_
        });
        bytes memory actions =
            abi.encodePacked(V4Actions.SWAP_EXACT_IN_SINGLE, V4Actions.SETTLE_ALL, V4Actions.TAKE_ALL);
        bytes[] memory params = new bytes[](3);
        params[0] = abi.encode(
            ExactInputSingleParams({
                poolKey: rhKey, zeroForOne: true, amountIn: uint128(amountIn),
                amountOutMinimum: 0, minHopPriceX36: 0, hookData: bytes("")
            })
        );
        params[1] = abi.encode(address(0), amountIn);
        params[2] = abi.encode(token_, uint256(0));
        bytes memory commands = abi.encodePacked(V4Actions.CMD_V4_SWAP);
        bytes[] memory inputs = new bytes[](1);
        inputs[0] = abi.encode(actions, params);
        vm.deal(who, amountIn + 1 ether);
        vm.prank(who);
        IUR(UNIVERSAL_ROUTER).execute{value: amountIn}(commands, inputs, block.timestamp);
    }

    function test_fork_the_launch_puts_every_token_into_one_locked_position() public view {
        // The liquidity maths leaves a hair of the supply behind, and the portal burns it, so what
        // exists is exactly what the pool holds.
        assertApproxEqRel(token.totalSupply(), SUPPLY, 0.000001e18);
        // everything that exists is either in the pool or in the creator's wallet from the first buy
        assertEq(
            IERC20(address(token)).balanceOf(POOL_MANAGER) + token.balanceOf(creator),
            token.totalSupply(),
            "the supply is the liquidity"
        );
        assertEq(IERC20(address(token)).balanceOf(address(portal)), 0, "the portal keeps nothing");

        (uint160 sqrtPriceX96, int24 tick,,) = IStateView(STATE_VIEW).getSlot0(_poolId());
        assertGt(sqrtPriceX96, 0, "the pool is open");
        // the creator's atomic first buy has already walked the price a little way in
        assertLt(tick, TICK_START, "and the first buy moved it off the opening tick");
        assertGt(tick, TICK_BOND);

        assertEq(locker.positionId(), portal.getLaunch(address(token)).positionId);
        assertEq(IERC20(POSITION_MANAGER).balanceOf(address(locker)), 1, "the locker holds it, forever");
    }

    /// @dev The position sits above the opening price, which in this pool's ordering is below the
    ///      opening tick. Nothing is in range until the first buy walks into it, and then the depth
    ///      is real rather than virtual.
    function test_fork_the_first_buy_walks_into_real_liquidity() public {
        // the creator's atomic first buy already walked into the position, so it is in range
        assertGt(IStateView(STATE_VIEW).getLiquidity(_poolId()), 0, "depth from the first buy on");
        _pastTheWindow();
        uint256 before = token.balanceOf(alice);
        _buy(alice, 1 ether);
        assertGt(token.balanceOf(alice), before);
    }

    function test_fork_the_launch_block_belongs_to_the_creator() public {
        // the atomic first buy already landed, inside the launch transaction, with the creator
        uint256 firstBuy = token.balanceOf(creator);
        assertGt(firstBuy, 0, "the creator's first buy is in the launch transaction");
        assertEq(IERC20(address(token)).balanceOf(address(portal)), 0, "and nothing stayed in the portal");

        vm.expectRevert();
        _buy(alice, 0.1 ether);

        _buy(creator, 0.1 ether);
        assertGt(token.balanceOf(creator), firstBuy);
    }

    function test_fork_the_creators_first_buy_is_first_dibs_not_the_whole_open() public {
        // control: a first buy inside the cap goes through on a fresh launch
        _launchWithFirstBuy(bytes32(uint256(8)), 1_000_000, 0.3 ether, false);
        // and one the cap cannot allow reverts the whole launch, not just the buy
        _launchWithFirstBuy(bytes32(uint256(9)), 2_000_000, 5 ether, true);
    }

    function _launchWithFirstBuy(bytes32 tokenSalt, uint256 saltStart, uint256 amount, bool expectFail) internal {
        DirectConfig memory config = DirectConfig({
            buyTaxBps: 500, sellTaxBps: 500, snipeTaxBps: 0, snipeDecaySeconds: 0,
            restrictionBlocks: 30, maxHoldBps: 500, maxBuyBps: 550,
            tickStart: TICK_START, tickBond: TICK_BOND,
            allocations: Allocations(2_500, 2_500, 4_000, 1_000),
            penalties: PenaltyConfig(0, 0, 0, 0, 0, false),
            auctionBlocks: 0
        });
        HoodPortal.LaunchInput memory input = HoodPortal.LaunchInput({
            name: "Greedy", symbol: expectFail ? "GREED" : "FAIR", logo: "", description: "",
            socials: Socials("", "", "", "", ""), quote: address(0), creatorFeeRecipient: address(0), supply: SUPPLY,
            poolFee: POOL_FEE, tickSpacing: SPACING, config: config, salt: tokenSalt,
            initialBuy: amount
        });
        bytes32 hookSalt = _mineHookSalt(saltStart);
        vm.deal(creator, 10 ether);
        vm.prank(creator);
        if (expectFail) vm.expectRevert();
        HoodPortal.Addresses memory out = portal.createLaunch{value: 0.002 ether + amount}(input, hookSalt);
        if (!expectFail) assertGt(IERC20(out.token).balanceOf(creator), 0);
    }

    function test_fork_graduation_status_moves_with_the_price() public {
        (int24 tick0, int24 bondTick, uint256 progress0, bool bonded0) = portal.graduationStatus(address(token));
        assertEq(bondTick, TICK_BOND);
        assertFalse(bonded0);
        assertLt(progress0, 2_000, "barely started after the first buy");

        _pastTheWindow();
        for (uint256 i; i < 12 && !hook.bonded(); ++i) {
            vm.roll(block.number + 1);
            vm.deal(bob, 100 ether);
            _buy(bob, 5 ether);
        }

        (int24 tick1,, uint256 progress1, bool bonded1) = portal.graduationStatus(address(token));
        assertLt(tick1, tick0);
        assertTrue(bonded1);
        assertEq(progress1, 10_000);
    }

    function test_fork_the_hold_cap_stops_one_wallet_taking_the_open() public {
        vm.roll(block.number + 1);
        vm.warp(block.timestamp + 10);

        // about 5% of the supply is all one wallet may hold while the window is open
        _buy(alice, 0.3 ether);
        assertGt(token.balanceOf(alice), 0);

        vm.expectRevert();
        _buy(alice, 5 ether);
    }

    function test_fork_a_buy_pays_the_tax_in_the_quote_asset() public {
        _pastTheWindow();

        hook.flushClaims(); // the creator's first buy from setUp is still held as a claim
        uint256 before = address(splitter).balance;
        _buy(alice, 1 ether);
        assertGt(token.balanceOf(alice), 0);

        // a buy's tax is held as a claim until its input is settled; anyone can then flush it. The
        // claim is the whole take: 5% creator tax plus the 1% platform fee.
        assertApproxEqRel(hook.claimsHeld(), 0.06 ether, 0.02e18, "six percent, held as a claim");
        hook.flushClaims();
        uint256 taxed = address(splitter).balance - before;
        // the splitter gets the creator's road: the 5% tax and the platform fee's 30 bps
        assertApproxEqRel(taxed, 0.053 ether, 0.02e18, "the creator's 5.3% of the trade, in ETH");
        assertEq(hook.claimsHeld(), 0);

        // and the next swap flushes on its own, no call needed
        _buy(bob, 1 ether);
        assertApproxEqRel(hook.claimsHeld(), 0.06 ether, 0.02e18);
        _buy(alice, 0.5 ether);
        assertApproxEqRel(hook.claimsHeld(), 0.03 ether, 0.02e18, "only this swap's slice is still a claim");
    }

    /// @dev Selling through the router is the path the app takes, and it is the one path where
    ///      the token is the INPUT: the router pulls it through Permit2, and the hook takes the tax
    ///      out of the ETH coming back. Never exercised by a buy.
    function test_fork_a_sell_through_the_router_pays_its_tax_in_eth() public {
        _pastTheWindow();
        _buy(alice, 1 ether);
        hook.flushClaims();
        uint256 splitterBefore = address(splitter).balance;
        uint256 aliceEthBefore = alice.balance;
        uint256 tokens = token.balanceOf(alice) / 2;

        // two approvals, once each: the token to Permit2, and Permit2 to the router
        vm.startPrank(alice);
        token.approve(PERMIT2, type(uint256).max);
        IPermit2(PERMIT2).approve(address(token), UNIVERSAL_ROUTER, type(uint160).max, type(uint48).max);
        vm.stopPrank();

        RhPoolKey memory rhKey = RhPoolKey({
            currency0: address(0), currency1: address(token), fee: POOL_FEE, tickSpacing: SPACING, hooks: address(hook)
        });
        bytes memory actions =
            abi.encodePacked(V4Actions.SWAP_EXACT_IN_SINGLE, V4Actions.SETTLE_ALL, V4Actions.TAKE_ALL);
        bytes[] memory params = new bytes[](3);
        params[0] = abi.encode(
            ExactInputSingleParams({
                poolKey: rhKey, zeroForOne: false, amountIn: uint128(tokens),
                amountOutMinimum: 0, minHopPriceX36: 0, hookData: bytes("")
            })
        );
        params[1] = abi.encode(address(token), tokens);
        params[2] = abi.encode(address(0), uint256(0));
        bytes memory commands = abi.encodePacked(V4Actions.CMD_V4_SWAP);
        bytes[] memory inputs = new bytes[](1);
        inputs[0] = abi.encode(actions, params);
        vm.prank(alice);
        IUR(UNIVERSAL_ROUTER).execute(commands, inputs, block.timestamp);

        uint256 received = alice.balance - aliceEthBefore;
        uint256 taxed = address(splitter).balance - splitterBefore;
        assertGt(received, 0, "she got ETH back");
        // the gross is what she got plus everything taken: the creator's 5.3% (to the splitter) and
        // the Bag's 0.7%, so what she got is 94% of it
        uint256 creatorBps = 500 + BagSplits.PLATFORM_CREATOR_BPS;
        uint256 gross = received * 10_000 / (10_000 - 500 - BagSplits.PLATFORM_FEE_BPS);
        assertApproxEqRel(taxed, gross * creatorBps / 10_000, 0.02e18, "the creator's 5.3% of the gross, taken on the way out");
        assertEq(hook.claimsHeld(), 0, "an output-side tax is taken directly, not held as a claim");
    }

    function test_fork_the_snipe_tax_is_brutal_at_the_open_and_gone_in_seconds() public {
        vm.roll(block.number + 1);

        uint256 atOpen = hook.currentTaxBps(true);
        assertGt(atOpen, 5_000, "the first second is expensive");

        vm.warp(block.timestamp + 1);
        uint256 afterOne = hook.currentTaxBps(true);
        assertLt(afterOne, atOpen);

        vm.warp(block.timestamp + 5);
        assertEq(hook.currentTaxBps(true), 500 + BagSplits.PLATFORM_FEE_BPS, "and then it is just the launch tax and the platform fee");
        assertEq(hook.currentSnipeBps(), 0);
    }

    function test_fork_the_price_walks_up_and_the_latch_holds() public {
        _pastTheWindow();

        assertFalse(hook.bonded());
        (, int24 startTick,,) = IStateView(STATE_VIEW).getSlot0(_poolId());

        // buy up through the position: the token is currency1, so the tick walks down
        for (uint256 i; i < 12 && !hook.bonded(); ++i) {
            vm.roll(block.number + 1);
            vm.deal(bob, 100 ether);
            _buy(bob, 5 ether);
        }

        (, int24 nowTick,,) = IStateView(STATE_VIEW).getSlot0(_poolId());
        assertLt(nowTick, startTick, "buys walk the price up");
        assertTrue(hook.bonded(), "and crossing the bonding tick latches");

        // it stays bonded even if somebody sells back down
        uint256 balance = token.balanceOf(bob);
        vm.startPrank(bob);
        token.approve(UNIVERSAL_ROUTER, balance);
        vm.stopPrank();
        assertTrue(hook.bonded());
    }

    function test_fork_the_tax_splits_four_ways_and_holders_can_claim() public {
        _pastTheWindow();

        _buy(alice, 2 ether);
        hook.flushClaims();
        splitter.sweep();

        assertGt(bag.total(bag.TRADE(), address(0)), 0, "the platform's 70 bps went into the Bag");
        assertEq(treasury.balance, 0, "nothing reaches the treasury by hand");
        assertGt(splitter.creatorClaimable(), 0);
        assertGt(splitter.buybackPot(), 0);
        assertGt(splitter.liquidityPot(), 0);
        assertGt(splitter.pendingDividends(alice), 0, "the only holder is owed the dividend share");

        uint256 before = alice.balance;
        splitter.claimDividends(alice);
        assertGt(alice.balance, before);

        uint256 recipientBefore = alice.balance;
        vm.prank(alice);
        splitter.claimCreator(alice);
        assertGt(alice.balance, recipientBefore, "the configured fee recipient can claim");
    }

    function test_fork_anybody_can_run_the_buyback_and_it_burns() public {
        _pastTheWindow();
        _buy(alice, 5 ether);
        hook.flushClaims();
        splitter.sweep();

        uint256 supplyBefore = token.totalSupply();
        vm.prank(bob);
        uint256 burned = buyback.run(address(token), 1);

        assertGt(burned, 0);
        assertEq(supplyBefore - token.totalSupply(), burned, "bought and burned");
        assertEq(splitter.buybackPot(), 0);
    }

    function test_fork_the_locker_harvests_into_the_same_four_roads() public {
        _pastTheWindow();
        _buy(alice, 5 ether);

        uint256 creatorBefore = splitter.creatorClaimable();
        locker.harvestFees();
        splitter.sweep();
        assertGt(splitter.creatorClaimable(), creatorBefore, "the pool fee comes home too");
        assertEq(IERC20(address(token)).balanceOf(address(locker)), 0, "the token side is burned");
    }

    function test_fork_liquidity_share_deepens_the_pool() public {
        _pastTheWindow();
        _buy(alice, 5 ether);
        hook.flushClaims();
        splitter.sweep();

        uint256 poolBefore = POOL_MANAGER.balance;
        splitter.pushLiquidity();
        assertTrue(locker.canDeepen(), "the launch position is the only thing in range");
        locker.deepen();
        assertGt(POOL_MANAGER.balance, poolBefore, "the donation landed in the pool");
        assertEq(address(locker).balance, 0);
    }

    /// @dev The surcharge and the opening window are the two things a launch can set that reach
    ///      every later trade, and both are uint32 fields. Unbounded, "an opening surcharge that
    ///      decays in seconds" becomes a 99% sell tax for a century and "a window that expires by
    ///      itself" becomes a token nobody may ever hold a hundredth of a percent of. Both are
    ///      refused at the door; the interface's own sliders are well inside these.
    function test_fork_a_launch_cannot_set_a_surcharge_that_never_decays() public {
        HoodPortal.LaunchInput memory input = _honeypotInput();
        input.config.snipeDecaySeconds = 601;
        bytes32 salt = _freeHookSalt();
        vm.prank(creator);
        vm.expectRevert(HoodLaunchHook.BadTax.selector);
        portal.createLaunch{value: 0.002 ether}(input, salt);

        input.config.snipeDecaySeconds = type(uint32).max;
        vm.prank(creator);
        vm.expectRevert(HoodLaunchHook.BadTax.selector);
        portal.createLaunch{value: 0.002 ether}(input, salt);
    }

    function test_fork_a_launch_cannot_set_a_window_that_never_ends() public {
        HoodPortal.LaunchInput memory input = _honeypotInput();
        input.config.restrictionBlocks = 1_201;
        bytes32 salt = _freeHookSalt();
        vm.prank(creator);
        vm.expectRevert(HoodPortal.BadWindow.selector);
        portal.createLaunch{value: 0.002 ether}(input, salt);

        input.config.restrictionBlocks = type(uint32).max;
        input.config.maxHoldBps = 1;
        input.config.maxBuyBps = 1;
        vm.prank(creator);
        vm.expectRevert(HoodPortal.BadWindow.selector);
        portal.createLaunch{value: 0.002 ether}(input, salt);
    }

    /// @dev A salt setUp has not already spent: mining from zero always lands on the same first
    ///      address, which is the one this launch's own hook already sits at.
    function _freeHookSalt() internal view returns (bytes32) {
        return _mineHookSalt(uint256(_mineHookSalt()) + 1);
    }

    /// @dev A launch whose numbers are all legal except the one each test bends.
    function _honeypotInput() internal pure returns (HoodPortal.LaunchInput memory) {
        return HoodPortal.LaunchInput({
            name: "Trap", symbol: "TRAP", logo: "", description: "",
            socials: Socials("", "", "", "", ""), quote: address(0), creatorFeeRecipient: address(0), supply: SUPPLY,
            poolFee: POOL_FEE, tickSpacing: SPACING,
            config: DirectConfig({
                buyTaxBps: 100, sellTaxBps: 100, snipeTaxBps: 9_800, snipeDecaySeconds: 3,
                restrictionBlocks: 30, maxHoldBps: 500, maxBuyBps: 550,
                tickStart: TICK_START, tickBond: TICK_BOND,
                allocations: Allocations(10_000, 0, 0, 0),
                penalties: PenaltyConfig(0, 0, 0, 0, 0, false),
                auctionBlocks: 0
            }),
            salt: bytes32(uint256(999)), initialBuy: 0
        });
    }

    /// @dev A donation is credited to whatever liquidity is in range at that instant, which Uniswap
    ///      says on `donate` itself. So a bot mints a one-spacing position on the current tick,
    ///      calls `deepen`, takes its share and burns the position again, all in one transaction
    ///      and with borrowed capital, because a narrow range buys a lot of liquidity cheaply. The
    ///      locker refuses to donate while anybody else is standing in the range.
    function test_fork_a_just_in_time_lp_cannot_take_the_liquidity_share() public {
        _pastTheWindow();
        _buy(alice, 5 ether);
        hook.flushClaims();
        splitter.sweep();
        splitter.pushLiquidity();
        uint256 pot = address(locker).balance;
        assertGt(pot, 0, "there is something to steal");

        // the bot buys the token side it needs, then straddles the current tick
        _buy(bob, 5 ether);
        PoolModifyLiquidityTest lpRouter = new PoolModifyLiquidityTest(IPoolManager(POOL_MANAGER));
        (, int24 tick,,) = IStateView(STATE_VIEW).getSlot0(_poolId());
        int24 lower = (tick / SPACING) * SPACING;
        uint128 launchLiquidity = IStateView(STATE_VIEW).getLiquidity(_poolId());
        ModifyLiquidityParams memory add = ModifyLiquidityParams({
            tickLower: lower,
            tickUpper: lower + SPACING,
            liquidityDelta: int256(uint256(launchLiquidity)),
            salt: bytes32(0)
        });

        vm.startPrank(bob);
        IERC20(address(token)).approve(address(lpRouter), type(uint256).max);
        lpRouter.modifyLiquidity{value: 20 ether}(key, add, "");
        vm.stopPrank();
        assertGt(IStateView(STATE_VIEW).getLiquidity(_poolId()), launchLiquidity, "the bot is in range");

        assertFalse(locker.canDeepen());
        vm.expectRevert(HoodLocker.NotAloneInRange.selector);
        locker.deepen();
        assertEq(address(locker).balance, pot, "the pot did not move");

        // and the moment the bot leaves, the donation goes where it was meant to
        add.liquidityDelta = -add.liquidityDelta;
        vm.prank(bob);
        lpRouter.modifyLiquidity(key, add, "");

        assertTrue(locker.canDeepen());
        uint256 poolBefore = POOL_MANAGER.balance;
        locker.deepen();
        assertEq(POOL_MANAGER.balance - poolBefore, pot, "all of it, onto the launch's own position");
        assertEq(address(locker).balance, 0);
    }

    // ---------------------------------------------------------------- team launch

    HoodTokenLock internal tokenLock;
    address internal t1 = makeAddr("t1");
    address internal t2 = makeAddr("t2");
    address internal t3 = makeAddr("t3");

    function _teamInput(string memory sym, uint32 restrictionBlocks) internal pure returns (HoodPortal.LaunchInput memory) {
        DirectConfig memory config = DirectConfig({
            buyTaxBps: 500,
            sellTaxBps: 500,
            snipeTaxBps: 5_000,
            snipeDecaySeconds: 3,
            restrictionBlocks: restrictionBlocks,
            maxHoldBps: 500,
            maxBuyBps: 550,
            tickStart: TICK_START,
            tickBond: TICK_BOND,
            allocations: Allocations(2_500, 2_500, 4_000, 1_000),
            penalties: PenaltyConfig(0, 0, 0, 0, 0, false),
            auctionBlocks: 0
        });
        return HoodPortal.LaunchInput({
            name: "Team Fam",
            symbol: sym,
            logo: "",
            description: "",
            socials: Socials("", "", "", "", ""),
            quote: address(0),
            creatorFeeRecipient: address(0),
            supply: SUPPLY,
            poolFee: POOL_FEE,
            tickSpacing: SPACING,
            config: config,
            salt: bytes32(uint256(777)),
            initialBuy: 0
        });
    }

    function _wireLock() internal {
        tokenLock = new HoodTokenLock();
        LockRegistry reg = new LockRegistry(address(tokenLock));
        vm.prank(owner);
        portal.setRegistry(address(reg));
    }

    function _legs() internal view returns (TeamBuy[] memory legs) {
        legs = new TeamBuy[](3);
        legs[0] = TeamBuy({wallet: t1, pairIn: 0.2 ether, minTokensOut: 0, lock: 0, gas: 0.005 ether});
        legs[1] = TeamBuy({wallet: t2, pairIn: 0.2 ether, minTokensOut: 0, lock: 30 days, gas: 0});
        legs[2] = TeamBuy({wallet: t3, pairIn: 0.1 ether, minTokensOut: 0, lock: 0, gas: 0});
    }

    function test_team_launch_buys_every_wallet_in_the_launch_transaction() public {
        _wireLock();
        bytes32 salt = _mineHookSalt(5_000_000);
        vm.prank(creator);
        HoodPortal.Addresses memory out =
            portal.createTeamLaunch{value: 0.002 ether + 0.5 ether + 0.005 ether}(_teamInput("TEAMD", 30), salt, _legs());
        HoodLaunchToken t = HoodLaunchToken(out.token);

        assertGt(t.balanceOf(t1), 0);
        assertGt(t.balanceOf(t3), 0);
        assertEq(t.balanceOf(t2), 0, "the locked wallet holds nothing in hand");
        (, address lockOwner, uint128 amount,) = tokenLock.locks(1);
        assertEq(lockOwner, t2);
        assertGt(amount, 0);
        assertEq(t1.balance, 0.005 ether, "gas went with the tokens");
        // The portal swapped, so the hook took no surcharge from the team.
        assertEq(HoodLaunchHook(payable(out.hook)).snipeClaims(), 0);
        assertEq(t.balanceOf(address(portal)), 0, "nothing left in the portal");
        assertEq(address(portal).balance, 0);
    }

    function test_the_hold_cap_still_applies_to_a_team_wallet() public {
        _wireLock();
        TeamBuy[] memory legs = new TeamBuy[](1);
        // about 10 ETH of FDV at the open, 5% hold cap: two ETH is far past it
        legs[0] = TeamBuy({wallet: t1, pairIn: 2 ether, minTokensOut: 0, lock: 0, gas: 0});
        bytes32 salt = _mineHookSalt(6_000_000);
        vm.prank(creator);
        vm.expectRevert(HoodLaunchToken.HoldsTooMuch.selector);
        portal.createTeamLaunch{value: 0.002 ether + 2 ether}(_teamInput("CAPD", 30), salt, legs);
    }

    function test_a_locked_leg_may_exceed_the_hold_cap_because_the_lock_is_not_a_wallet() public {
        _wireLock();
        TeamBuy[] memory legs = new TeamBuy[](1);
        legs[0] = TeamBuy({wallet: t2, pairIn: 2 ether, minTokensOut: 0, lock: 90 days, gas: 0});
        bytes32 salt = _mineHookSalt(7_000_000);
        vm.prank(creator);
        HoodPortal.Addresses memory out =
            portal.createTeamLaunch{value: 0.002 ether + 2 ether}(_teamInput("LOCKD", 30), salt, legs);
        assertGt(IERC20(out.token).balanceOf(address(tokenLock)), 0);
    }

    function test_team_launch_refusals() public {
        _wireLock();
        bytes32 salt = _mineHookSalt(8_000_000);
        HoodPortal.LaunchInput memory input = _teamInput("NOPE", 30);
        vm.startPrank(creator);
        vm.expectRevert(HoodPortal.NoLegs.selector);
        portal.createTeamLaunch{value: 0.002 ether}(input, salt, new TeamBuy[](0));
        input.initialBuy = 1;
        vm.expectRevert(HoodPortal.UseLegs.selector);
        portal.createTeamLaunch{value: 0.002 ether}(input, salt, _legs());
        input.initialBuy = 0;
        TeamBuy[] memory legs = _legs();
        legs[2].wallet = t1;
        vm.expectRevert(HoodPortal.BadLeg.selector);
        portal.createTeamLaunch{value: 0.502 ether + 0.005 ether}(input, salt, legs);
        vm.expectRevert(HoodPortal.BadFee.selector);
        portal.createTeamLaunch{value: 0.4 ether}(input, salt, _legs());
        vm.stopPrank();
    }
}
