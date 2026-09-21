// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {StdInvariant} from "forge-std/StdInvariant.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {HoodFactory} from "../../src/HoodFactory.sol";
import {HoodDeployer} from "../../src/HoodDeployer.sol";
import {HoodCurve} from "../../src/HoodCurve.sol";
import {HoodFeeRouter} from "../../src/HoodFeeRouter.sol";
import {HoodStaking} from "../../src/HoodStaking.sol";
import {CurveConfig, FeeSplit, LaunchParams} from "../../src/HoodTypes.sol";
import {MockGraduator} from "../mocks/Mocks.sol";

/// @notice Random stake / unstake / claim / demote / reward on one launch's staking vault.
contract StakeHandler is Test {
    HoodStaking public immutable staking;
    IERC20 public immutable token;
    address public immutable launch;

    address[] public actors;
    uint256[] public ids;
    uint256 public totalNotified; // native rewards paid in, ever
    uint256 public totalClaimed; // native rewards paid out, ever

    constructor(HoodStaking staking_, address token_, address launch_) {
        staking = staking_;
        token = IERC20(token_);
        launch = launch_;
        for (uint256 i; i < 4; ++i) {
            address a = address(uint160(0x5A1E + i));
            actors.push(a);
            vm.deal(a, 100 ether);
        }
    }

    function _actor(uint256 s) internal view returns (address) {
        return actors[s % actors.length];
    }

    function stake(uint256 actorSeed, uint256 amount, uint64 lock) public {
        address a = _actor(actorSeed);
        uint256 held = token.balanceOf(a);
        if (held == 0) return;
        amount = bound(amount, 1, held);
        lock = uint64(bound(lock, 0, 365 days));
        vm.startPrank(a);
        token.approve(address(staking), amount);
        try staking.stake(amount, lock) returns (uint256 id) { ids.push(id); } catch {}
        vm.stopPrank();
    }

    function claim(uint256 idSeed) public {
        if (ids.length == 0) return;
        uint256 id = ids[idSeed % ids.length];
        (address ownerOf,,,) = staking.positions(id);
        if (ownerOf == address(0)) return;
        // Measured at the receiver, because a claim now pays every asset a position has earned and
        // no longer reports one number back.
        uint256 before = ownerOf.balance;
        try staking.claim(id) { totalClaimed += ownerOf.balance - before; } catch {}
    }

    function unstake(uint256 idSeed) public {
        if (ids.length == 0) return;
        uint256 id = ids[idSeed % ids.length];
        (address ownerOf,, uint64 unlockAt,) = staking.positions(id);
        if (ownerOf == address(0)) return;
        if (block.timestamp < unlockAt) vm.warp(unlockAt);
        uint256 before = ownerOf.balance;
        vm.prank(ownerOf);
        try staking.unstake(id) returns (uint256) { totalClaimed += ownerOf.balance - before; } catch {}
    }

    function demote(uint256 idSeed) public {
        if (ids.length == 0) return;
        uint256 id = ids[idSeed % ids.length];
        (address ownerOf,, uint64 unlockAt,) = staking.positions(id);
        if (ownerOf == address(0)) return;
        if (block.timestamp < unlockAt) vm.warp(unlockAt);
        try staking.demote(id) {} catch {}
    }

    function reward(uint256 amount) public {
        amount = bound(amount, 1, 10 ether);
        vm.deal(address(this), amount);
        try staking.notifyReward{value: amount}(address(0), amount) { totalNotified += amount; } catch {}
    }

    function warp(uint256 dt) public {
        vm.warp(block.timestamp + bound(dt, 1, 30 days));
    }

    function idCount() external view returns (uint256) {
        return ids.length;
    }

    function idAt(uint256 i) external view returns (uint256) {
        return ids[i];
    }

    receive() external payable {}
}

contract StakingSolvencyInvariant is StdInvariant, Test {
    HoodFactory internal factory;
    HoodDeployer internal deployer;
    HoodFeeRouter internal router;
    HoodStaking internal staking;
    MockGraduator internal graduator;

    address internal token;
    HoodCurve internal curve;
    StakeHandler internal handler;

    address internal owner = makeAddr("owner");
    address internal treasury = makeAddr("treasury");
    address internal creator = makeAddr("creator");

    receive() external payable {}

    function setUp() public {
        deployer = new HoodDeployer();
        factory = new HoodFactory(owner, treasury, address(deployer));
        deployer.initialize(address(factory));
        staking = new HoodStaking(address(factory));
        router = new HoodFeeRouter(address(factory), address(staking));
        graduator = new MockGraduator(address(factory));

        vm.startPrank(owner);
        factory.setModules(address(router), address(staking), address(graduator));
        factory.setLaunchFee(0);
        uint256 configId = factory.addConfig(
            CurveConfig({
                totalSupply: 1_000_000_000e18, curveSupplyBps: 8000, startCap: 1 ether,
                graduationCap: 10 ether, liquidityBps: 9000, protocolFeeBps: 30, creatorFeeBps: 70,
                poolFee: 3000, tickSpacing: 60, enabled: true
            })
        );
        vm.stopPrank();

        LaunchParams memory p;
        p.name = "Stk"; p.symbol = "STK"; p.pairToken = address(0); p.configId = configId;
        // The coin of the house cannot point its own fee at a room that does not exist yet, so it
        // launches paying its creator and becomes the room a moment later.
        p.feeSplit = FeeSplit({stakersBps: 0, buybackBps: 0, liquidityBps: 0, creatorBps: 10_000}); p.creatorFeeRecipient = creator; p.salt = bytes32(uint256(1));
        vm.prank(creator);
        (token, , ) = factory.launch(p);
        curve = HoodCurve(payable(factory.getLaunch(token).curve));
        vm.prank(owner);
        staking.setHouseToken(token);

        handler = new StakeHandler(staking, token, token);

        // Buy the whole curve so the actors hold real token to stake, then spread it to them.
        vm.deal(address(this), 10_000 ether);
        curve.buy{value: 5_000 ether}(5_000 ether, 0, address(this));
        uint256 bal = IERC20(token).balanceOf(address(this));
        for (uint256 i; i < 4; ++i) {
            IERC20(token).transfer(handler.actors(i), bal / 5);
        }

        targetContract(address(handler));
        bytes4[] memory sel = new bytes4[](6);
        sel[0] = StakeHandler.stake.selector;
        sel[1] = StakeHandler.claim.selector;
        sel[2] = StakeHandler.unstake.selector;
        sel[3] = StakeHandler.demote.selector;
        sel[4] = StakeHandler.reward.selector;
        sel[5] = StakeHandler.warp.selector;
        targetSelector(FuzzSelector({addr: address(handler), selectors: sel}));
    }

    /// @notice What the vault has actually PAID OUT never exceeds what was paid in. This is the hard
    ///         solvency line and it holds to the wei: rewards can only leave along a claim, a claim
    ///         is bounded by `accounted`, and `accounted` only ever grew from a notify.
    function invariant_paidOutNeverExceedsPaidIn() public view {
        assertLe(handler.totalClaimed(), handler.totalNotified(), "vault paid out more than it took in");
    }

    /// @notice The sum of what every live position could still claim is covered by what was notified,
    ///         to within the accumulator's rounding dust (one wei can be lost per notify to the
    ///         per-share floor, so the last claimer eats it). This is the same "dust" accepted risk
    ///         SECURITY.md names for the splitter, holding here too: the shortfall is bounded and
    ///         never a user's principal.
    function invariant_claimableCoveredWithinDust() public view {
        uint256 pendingSum;
        uint256 n = handler.idCount();
        for (uint256 i; i < n; ++i) {
            pendingSum += staking.pending(handler.idAt(i), address(0));
        }
        // The dust is bounded by one wei per position that has settled against the accumulator.
        assertLe(handler.totalClaimed() + pendingSum, handler.totalNotified() + n + 1, "claimable exceeds notified beyond dust");
    }

    /// @notice The native balance the vault holds always covers what it has booked as owed to
    ///         stakers (`accounted`). Rounding may leave dust ABOVE, never below.
    function invariant_balanceCoversAccounted() public view {
        assertGe(address(staking).balance, staking.accounted(address(0)), "vault balance is short of what it owes");
    }

    /// @notice Staked principal booked equals the token the vault actually holds. Principal never
    ///         leaks: unstake returns exactly what was put in.
    function invariant_stakedMatchesBalance() public view {
        assertEq(IERC20(token).balanceOf(address(staking)), staking.staked(), "staked bookkeeping drifted from balance");
    }
}
