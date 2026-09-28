// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {BaseTest} from "./Base.t.sol";
import {HoodBlockZero} from "../src/HoodBlockZero.sol";
import {HoodCurve} from "../src/HoodCurve.sol";
import {HoodFactory} from "../src/HoodFactory.sol";
import {CurveGuard, LaunchParams} from "../src/HoodTypes.sol";
import {TeamBuy} from "../src/TeamTypes.sol";
import {BagSource} from "../src/bag/BagTypes.sol";
import {IHoodPot} from "../src/interfaces/IHoodPot.sol";

/// @notice The curve's opening rules: the decaying surcharge, the per-wallet cap, and the one
///         exemption, which is the launch transaction's own buys.
/// @dev Isolated: every top-level call is its own transaction, which is what makes the launch
///      transaction end where it does on a real chain. Without it a whole test is one transaction
///      and the curve's transient mark would still be set on the next "block".
/// forge-config: default.isolate = true
contract CurveGuardTest is BaseTest {
    HoodBlockZero internal zero;
    address internal w1 = makeAddr("w1");
    address internal w2 = makeAddr("w2");

    function setUp() public override {
        super.setUp();
        zero = new HoodBlockZero(address(factory));
    }

    function _guard(uint16 snipeBps, uint32 decay, uint32 blocks, uint16 maxBuyBps) internal pure returns (CurveGuard memory) {
        return CurveGuard({snipeTaxBps: snipeBps, snipeDecaySeconds: decay, restrictionBlocks: blocks, maxBuyBps: maxBuyBps});
    }

    function _guarded(CurveGuard memory g, string memory sym) internal returns (address token, HoodCurve curve) {
        LaunchParams memory p = _params(_toCreator());
        p.guard = g;
        p.symbol = sym;
        p.image = string.concat("ipfs://", sym);
        return _launch(_toCreator(), p, LAUNCH_FEE);
    }

    function test_the_surcharge_starts_full_and_decays_quadratically() public {
        (, HoodCurve curve) = _guarded(_guard(5_000, 4, 0, 0), "DECAY");
        assertEq(curve.currentSnipeBps(), 5_000);
        vm.warp(block.timestamp + 2);
        assertEq(curve.currentSnipeBps(), 1_250); // half the window left: a quarter of the rate
        vm.warp(block.timestamp + 2);
        assertEq(curve.currentSnipeBps(), 0);
    }

    function test_a_sniper_pays_eighty_percent_to_holders_and_twenty_to_the_bag() public {
        (address token, HoodCurve curve) = _guarded(_guard(5_000, 3, 0, 0), "SNIPE");
        // a holder so the pot has somebody to pay
        vm.warp(block.timestamp + 3);
        _buy(curve, bob, 0.1 ether);
        vm.warp(block.timestamp - 3); // back into the window for the sniper
        address pot = factory.getLaunch(token).pot;
        uint256 potBefore = pot.balance;

        vm.prank(alice);
        curve.buy{value: 1 ether}(1 ether, 0, alice);

        uint256 toHolders = pot.balance - potBefore;
        uint256 toBag = curve.penaltyClaimable();
        uint256 penalty = toHolders + toBag;
        // half of what alice handed in, give or take the wei the rounding moves
        assertApproxEqAbs(penalty, 0.5 ether, 1e6);
        assertApproxEqAbs(toHolders * 10_000 / penalty, 8_000, 1);
        assertGt(IHoodPot(pot).pending(bob), 0, "the holder is paid by the sniper");

        curve.claimProtocol();
        assertEq(curve.penaltyClaimable(), 0);
        assertEq(bag.totalIn(address(0), BagSource.Penalty), toBag);
    }

    function test_the_quote_is_what_the_buy_does() public {
        (address token, HoodCurve curve) = _guarded(_guard(4_000, 5, 0, 0), "QUOTE");
        vm.warp(block.timestamp + 1);
        (uint256 tokensOut, uint256 pairSpent,) = curve.quoteBuy(0.7 ether);
        uint256 before = alice.balance;
        vm.prank(alice);
        uint256 got = curve.buy{value: 0.7 ether}(0.7 ether, 0, alice);
        assertEq(got, tokensOut);
        assertEq(before - alice.balance, pairSpent);
        assertEq(IERC20(token).balanceOf(alice), got);
    }

    function test_an_exact_out_buy_pays_the_surcharge_on_top() public {
        (, HoodCurve curve) = _guarded(_guard(3_000, 5, 0, 0), "EXOUT");
        (uint256 quoted, uint256 fee) = curve.quoteBuyExactOut(1_000_000e18);
        assertGt(fee * 10, quoted * 3 - 1, "the surcharge is in the quote");
        uint256 before = alice.balance;
        vm.prank(alice);
        uint256 paid = curve.buyExactOut{value: quoted}(1_000_000e18, quoted, alice);
        assertEq(paid, quoted);
        assertEq(before - alice.balance, quoted);
        vm.prank(bob);
        vm.expectRevert(HoodCurve.TooExpensive.selector);
        curve.buyExactOut{value: quoted}(1_000_000e18, quoted * 7 / 10, bob);
    }

    function test_the_wallet_cap_holds_for_its_blocks_then_lets_go() public {
        // 1% of the supply per wallet for 10 blocks
        (, HoodCurve curve) = _guarded(_guard(0, 0, 10, 100), "CAP");
        assertEq(curve.maxBuy(), 10_000_000e18);
        vm.prank(alice);
        vm.expectRevert(HoodCurve.BuysTooMuch.selector);
        curve.buy{value: 1 ether}(1 ether, 0, alice);

        _buy(curve, alice, 0.01 ether);
        vm.roll(block.number + 11);
        _buy(curve, alice, 1 ether);
    }

    function test_the_creators_first_buy_inside_the_launch_is_exempt() public {
        LaunchParams memory p = _params(_toCreator());
        p.guard = _guard(9_000, 600, 1_200, 1);
        p.symbol = "FIRST";
        vm.prank(creator);
        (, address c, uint256 bought) = factory.launch{value: LAUNCH_FEE + 1 ether}(p);

        LaunchParams memory q = _params(_toCreator());
        q.symbol = "FIRST2";
        q.image = "ipfs://other";
        q.salt = bytes32(uint256(99));
        vm.prank(creator);
        (,, uint256 open) = factory.launch{value: LAUNCH_FEE + 1 ether}(q);

        assertEq(bought, open, "no surcharge and no cap on the launch's own buy");
        assertEq(HoodCurve(payable(c)).penaltyClaimable(), 0);
    }

    function test_the_creator_one_transaction_later_is_a_buyer_like_any_other() public {
        (, HoodCurve curve) = _guarded(_guard(5_000, 600, 0, 0), "LATER");
        vm.prank(creator);
        curve.buy{value: 1 ether}(1 ether, 0, creator);
        assertGt(curve.penaltyClaimable(), 0);
    }

    function test_block_zero_legs_are_exempt_and_the_follow_up_is_not() public {
        LaunchParams memory p = _params(_toCreator());
        p.creatorFeeRecipient = address(0);
        p.symbol = "BZG";
        p.guard = _guard(5_000, 600, 1_200, 10);
        TeamBuy[] memory legs = new TeamBuy[](2);
        legs[0] = TeamBuy({wallet: w1, pairIn: 1 ether, minTokensOut: 0, lock: 0, gas: 0.01 ether});
        legs[1] = TeamBuy({wallet: w2, pairIn: 1 ether, minTokensOut: 0, lock: 0, gas: 0});
        vm.deal(creator, 100 ether);
        vm.prank(creator);
        (address token, address c) = zero.launch{value: LAUNCH_FEE + 2 ether + 0.01 ether}(p, legs);
        HoodCurve curve = HoodCurve(payable(c));

        // 2 ETH bought well past the 0.1% cap, and no surcharge was taken
        assertGt(IERC20(token).balanceOf(w1), curve.maxBuy());
        assertEq(curve.penaltyClaimable(), 0);
        assertEq(w1.balance, 0.01 ether, "the gas went with the tokens");

        // The follow-up, one transaction later, pays like anyone.
        TeamBuy[] memory more = new TeamBuy[](1);
        more[0] = TeamBuy({wallet: makeAddr("w3"), pairIn: 0.001 ether, minTokensOut: 0, lock: 0, gas: 0});
        vm.prank(creator);
        zero.followUp{value: 0.001 ether}(token, more, type(uint256).max);
        assertGt(curve.penaltyClaimable(), 0);
    }

    function test_the_follow_up_stands_down_when_outsiders_got_in() public {
        LaunchParams memory p = _params(_toCreator());
        p.creatorFeeRecipient = address(0);
        p.symbol = "GUARD";
        TeamBuy[] memory legs = new TeamBuy[](1);
        legs[0] = TeamBuy({wallet: w1, pairIn: 0.5 ether, minTokensOut: 0, lock: 0, gas: 0});
        vm.prank(creator);
        (address token, address c) = zero.launch{value: LAUNCH_FEE + 0.5 ether}(p, legs);
        assertEq(zero.outsideBought(token), 0);

        uint256 got = _buy(HoodCurve(payable(c)), alice, 0.3 ether);
        assertEq(zero.outsideBought(token), got);

        TeamBuy[] memory more = new TeamBuy[](1);
        more[0] = TeamBuy({wallet: w2, pairIn: 0.2 ether, minTokensOut: 0, lock: 0, gas: 0});
        vm.prank(creator);
        vm.expectRevert(abi.encodeWithSelector(HoodBlockZero.OutsidersAhead.selector, got, got - 1));
        zero.followUp{value: 0.2 ether}(token, more, got - 1);

        vm.prank(alice);
        vm.expectRevert(HoodBlockZero.NotLauncher.selector);
        zero.followUp{value: 0.2 ether}(token, more, type(uint256).max);

        vm.prank(creator);
        zero.followUp{value: 0.2 ether}(token, more, got);
        assertTrue(zero.isTeamWallet(token, w2));
        assertEq(zero.teamCount(token), 2);

        // the same wallet twice is refused across waves too
        vm.prank(creator);
        vm.expectRevert(HoodBlockZero.DuplicateWallet.selector);
        zero.followUp{value: 0.2 ether}(token, more, type(uint256).max);
    }

    function test_fund_gas_moves_only_the_callers_money() public {
        address[] memory ws = new address[](2);
        ws[0] = w1;
        ws[1] = w2;
        uint256[] memory amts = new uint256[](2);
        amts[0] = 0.02 ether;
        amts[1] = 0.03 ether;
        vm.prank(creator);
        zero.fundGas{value: 0.05 ether}(address(0), ws, amts);
        assertEq(w1.balance, 0.02 ether);
        assertEq(w2.balance, 0.03 ether);
        vm.prank(creator);
        vm.expectRevert(HoodBlockZero.BadValue.selector);
        zero.fundGas{value: 0.06 ether}(address(0), ws, amts);
    }

    function test_guard_limits() public {
        LaunchParams memory p = _params(_toCreator());
        p.guard = _guard(9_001, 3, 0, 0);
        vm.startPrank(creator);
        vm.expectRevert(HoodFactory.BadGuard.selector);
        factory.launch{value: LAUNCH_FEE}(p);
        p.guard = _guard(5_000, 0, 0, 0);
        vm.expectRevert(HoodFactory.BadGuard.selector);
        factory.launch{value: LAUNCH_FEE}(p);
        p.guard = _guard(5_000, 601, 0, 0);
        vm.expectRevert(HoodFactory.BadGuard.selector);
        factory.launch{value: LAUNCH_FEE}(p);
        p.guard = _guard(0, 0, 1_201, 10);
        vm.expectRevert(HoodFactory.BadGuard.selector);
        factory.launch{value: LAUNCH_FEE}(p);
        p.guard = _guard(0, 0, 10, 0);
        vm.expectRevert(HoodFactory.BadGuard.selector);
        factory.launch{value: LAUNCH_FEE}(p);
        vm.stopPrank();
    }
}
