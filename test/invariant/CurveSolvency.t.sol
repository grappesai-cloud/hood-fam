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
import {CurveMath} from "../../src/libraries/CurveMath.sol";
import {CurveConfig, FeeSplit, LaunchParams, Phase} from "../../src/HoodTypes.sol";
import {MockGraduator} from "../mocks/Mocks.sol";

/// @notice Drives one native-paired curve with random buys, sells and donations from a pool of
///         actors. It exists so the invariants below are checked against sequences a human would
///         never think to write, not just the handful in the unit tests.
/// @dev Every action bounds its own input and swallows the reverts that are just the curve saying
///      "no" (a buy past sold-out, a sell of more than you hold). The fuzzer is meant to try those.
contract CurveHandler is Test {
    HoodCurve public immutable curve;
    IERC20 public immutable token;

    address[] public actors;
    uint256 public totalDonated;

    constructor(HoodCurve curve_, address token_) {
        curve = curve_;
        token = IERC20(token_);
        for (uint256 i; i < 5; ++i) {
            address a = address(uint160(0xA11CE + i));
            actors.push(a);
            vm.deal(a, 1_000 ether);
        }
    }

    function _actor(uint256 seed) internal view returns (address) {
        return actors[seed % actors.length];
    }

    function buy(uint256 actorSeed, uint256 pairIn) public {
        if (curve.phase() != Phase.Curve) return;
        address a = _actor(actorSeed);
        pairIn = bound(pairIn, 0, a.balance);
        if (pairIn == 0) return;
        vm.prank(a);
        try curve.buy{value: pairIn}(pairIn, 0, a) {} catch {}
    }

    function sell(uint256 actorSeed, uint256 tokensIn) public {
        if (curve.phase() != Phase.Curve) return;
        address a = _actor(actorSeed);
        uint256 held = token.balanceOf(a);
        if (held == 0) return;
        tokensIn = bound(tokensIn, 1, held);
        vm.startPrank(a);
        token.approve(address(curve), tokensIn);
        try curve.sell(tokensIn, 0, a) {} catch {}
        vm.stopPrank();
    }

    function donate(uint256 actorSeed, uint256 amount) public {
        if (curve.phase() == Phase.Graduated) return;
        address a = _actor(actorSeed);
        amount = bound(amount, 0, a.balance);
        if (amount == 0) return;
        vm.prank(a);
        try curve.donate{value: amount}(amount) { totalDonated += amount; } catch {}
    }

    function actorCount() external view returns (uint256) {
        return actors.length;
    }

    function actorAt(uint256 i) external view returns (address) {
        return actors[i];
    }
}

/// @notice The property that matters for a curve: it can always pay everyone who wants out.
contract CurveSolvencyInvariant is StdInvariant, Test {
    HoodFactory internal factory;
    HoodDeployer internal deployer;
    HoodFeeRouter internal router;
    HoodStaking internal staking;
    MockGraduator internal graduator;

    HoodCurve internal curve;
    address internal token;
    CurveHandler internal handler;

    address internal owner = makeAddr("owner");
    address internal treasury = makeAddr("treasury");
    address internal creator = makeAddr("creator");

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
                pairToken: address(0),
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

        LaunchParams memory p;
        p.name = "Inv";
        p.symbol = "INV";
        p.pairToken = address(0);
        p.configId = configId;
        // What the curve books for the creator leg is what this rig is about; where that leg goes
        // afterwards is the router's business, so it points somewhere that needs no house coin.
        p.feeSplit = FeeSplit({stakersBps: 0, buybackBps: 0, liquidityBps: 0, creatorBps: 10_000});
        p.creatorFeeRecipient = creator;
        p.salt = bytes32(uint256(1));
        vm.prank(creator);
        (token, , ) = factory.launch(p);
        curve = HoodCurve(payable(factory.getLaunch(token).curve));

        handler = new CurveHandler(curve, token);

        // Only the handler is a target, and only its three actions, so the fuzzer builds sequences
        // out of buy/sell/donate rather than poking the curve's internals directly.
        targetContract(address(handler));
        bytes4[] memory sel = new bytes4[](3);
        sel[0] = CurveHandler.buy.selector;
        sel[1] = CurveHandler.sell.selector;
        sel[2] = CurveHandler.donate.selector;
        targetSelector(FuzzSelector({addr: address(handler), selectors: sel}));
    }

    /// @notice Native accounting is exact: the pair the curve is holding is, to the wei, the reserve
    ///         that backs sellers plus the protocol's booked legs plus the donations waiting for the
    ///         pool. Not a wei sits unaccounted, and the balance is never short of what it owes.
    function invariant_balanceIsReservePlusClaimablePlusBonus() public view {
        assertEq(
            address(curve).balance,
            curve.reserve() + curve.protocolClaimable() + curve.bonus(),
            "curve native balance drifted from its accounting"
        );
    }

    /// @notice The reserve always covers the closed-form value of every token sold. This is the
    ///         solvency property: if it holds, everyone who bought can sell back and be paid, in any
    ///         order, because the curve rounds every trade in its own favour. If a sequence ever made
    ///         the reserve dip below the integral, some seller at the end would be short.
    function invariant_reserveCoversEverySeller() public view {
        uint256 sold = curve.sold();
        if (sold == 0) return;
        uint256 owed = CurveMath.cost(curve.p0(), curve.p1(), curve.curveSupply(), 0, sold, false);
        assertGe(curve.reserve(), owed, "reserve fell below what sellers are owed");
    }

    /// @notice The curve can never sell more than its curve supply.
    function invariant_soldNeverExceedsCurveSupply() public view {
        assertLe(curve.sold(), curve.curveSupply(), "sold past the curve supply");
    }

    /// @notice No token is created or destroyed by trading: what buyers hold plus what the curve
    ///         still holds is always the whole supply. (Nothing here burns; graduation is the only
    ///         way tokens leave the curve, and this suite stays pre-graduation.)
    function invariant_tokenConservation() public view {
        uint256 held = IERC20(token).balanceOf(address(curve));
        uint256 n = handler.actorCount();
        for (uint256 i; i < n; ++i) {
            held += IERC20(token).balanceOf(handler.actorAt(i));
        }
        assertEq(held, IERC20(token).totalSupply(), "tokens appeared or vanished");
    }
}
