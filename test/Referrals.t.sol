// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Vm} from "forge-std/Vm.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

import {BaseTest} from "./Base.t.sol";
import {DirectPoolBase} from "./DirectSwap.t.sol";
import {HoodCurve} from "../src/HoodCurve.sol";
import {HoodReferrals} from "../src/HoodReferrals.sol";
import {HoodPortal} from "../src/direct/HoodPortal.sol";
import {CurveConfig, LaunchParams} from "../src/HoodTypes.sol";
import {BagSource} from "../src/bag/BagTypes.sol";
import {PairTransfer} from "../src/libraries/PairTransfer.sol";
import {RejectNative} from "./mocks/Mocks.sol";
import {MockBag} from "./mocks/DirectMocks.sol";

/// @dev A registry that cannot answer: what a claim, and a trade, has to survive.
contract RevertingReferrals {
    function split(address, uint256) external pure returns (address, uint256) {
        revert("broken");
    }
}

/// @notice The referral leg on the curve machine: carved out of the protocol's share, set by the
///         owner per launch, paid on chain when that share is claimed. The direct machine's leg is
///         DirectReferralsTest below.
contract ReferralsTest is BaseTest {
    HoodReferrals internal referrals;
    address internal referrer = makeAddr("referrer");
    address internal token;
    HoodCurve internal curve;

    event ReferralSet(address indexed token, address indexed to, uint16 bps);
    event ReferralPaid(address indexed to, uint256 amount);
    event ProtocolClaimed(address indexed to, uint256 amount);
    event ReferralsSet(address referrals);

    function setUp() public override {
        super.setUp();
        referrals = new HoodReferrals(owner);
        vm.prank(owner);
        factory.setReferrals(address(referrals));
        (token, curve) = _launch(_toCreator());
    }

    function _setReferral(address t, address to, uint16 bps) internal {
        vm.prank(owner);
        referrals.setReferral(t, to, bps);
    }

    function _referralPaidCount(Vm.Log[] memory logs) internal pure returns (uint256 n) {
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].topics[0] == ReferralPaid.selector) ++n;
        }
    }

    // ---------------------------------------------------------------- the registry

    function test_the_owner_sets_a_referral_and_anyone_can_read_the_split() public {
        vm.expectEmit(true, true, true, true, address(referrals));
        emit ReferralSet(token, referrer, 2_500);
        _setReferral(token, referrer, 2_500);

        (address to, uint16 bps) = referrals.referralOf(token);
        assertEq(to, referrer);
        assertEq(bps, 2_500);
        (address who, uint256 cut) = referrals.split(token, 1 ether);
        assertEq(who, referrer);
        assertEq(cut, 0.25 ether);

        (who, cut) = referrals.split(makeAddr("some other token"), 1 ether);
        assertEq(who, address(0), "unset means nobody");
        assertEq(cut, 0, "and nothing");
    }

    function test_a_referral_takes_at_most_half_of_the_protocols_share() public {
        assertEq(referrals.MAX_BPS(), 5_000);
        vm.prank(owner);
        vm.expectRevert(HoodReferrals.BpsTooHigh.selector);
        referrals.setReferral(token, referrer, 5_001);
        _setReferral(token, referrer, 5_000); // exactly half is allowed
    }

    function test_a_referral_with_a_cut_needs_somebody_to_pay() public {
        vm.prank(owner);
        vm.expectRevert(HoodReferrals.ZeroAddress.selector);
        referrals.setReferral(token, address(0), 1);
        _setReferral(token, address(0), 0); // clearing is always allowed
    }

    function test_only_the_owner_sets_a_referral() public {
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        referrals.setReferral(token, referrer, 100);
    }

    function test_only_the_owner_points_the_factory_and_the_portal_at_a_registry() public {
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        factory.setReferrals(address(0));

        vm.expectEmit(true, true, true, true, address(factory));
        emit ReferralsSet(address(0));
        vm.prank(owner);
        factory.setReferrals(address(0));
        assertEq(factory.referrals(), address(0));

        // The portal's constructor only pins addresses, so the pointer can be tested without a pool.
        HoodPortal portal =
            new HoodPortal(owner, treasury, address(0), address(0), address(0), address(0), address(0));
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        portal.setReferrals(address(referrals));

        vm.expectEmit(true, true, true, true, address(portal));
        emit ReferralsSet(address(referrals));
        vm.prank(owner);
        portal.setReferrals(address(referrals));
        assertEq(portal.referrals(), address(referrals));
    }

    // ---------------------------------------------------------------- the curve

    function test_a_curve_claim_pays_the_referrer_its_cut_and_the_bag_the_rest() public {
        _setReferral(token, referrer, 2_500);
        _buy(curve, alice, 1 ether);
        uint256 booked = curve.protocolClaimable();
        assertGt(booked, 0);
        uint256 cut = (booked * 2_500) / 10_000;
        uint256 bagBefore = address(bag).balance;

        vm.expectEmit(true, true, true, true, address(curve));
        emit ReferralPaid(referrer, cut);
        vm.expectEmit(true, true, true, true, address(curve));
        emit ProtocolClaimed(address(bag), booked - cut);
        assertEq(curve.claimProtocol(), booked, "the claim still reports the whole share");

        assertEq(referrer.balance, cut);
        assertEq(address(bag).balance - bagBefore, booked - cut);
        assertEq(bag.totalIn(address(0), BagSource.Trade), booked - cut, "the bag books the trade fee net of the cut");
        assertEq(bag.lastTake().token, token, "and knows which launch paid it");
        assertEq(curve.protocolClaimable(), 0);
        assertEq(address(curve).balance, curve.reserve(), "only the reserve stays behind");
    }

    function test_clearing_the_referral_stops_the_payments() public {
        _setReferral(token, referrer, 2_500);
        _buy(curve, alice, 1 ether);
        curve.claimProtocol();
        uint256 paidOnce = referrer.balance;
        assertGt(paidOnce, 0);

        _setReferral(token, address(0), 0);
        _buy(curve, alice, 1 ether);
        uint256 booked = curve.protocolClaimable();
        uint256 bagBefore = address(bag).balance;
        vm.recordLogs();
        curve.claimProtocol();
        assertEq(_referralPaidCount(vm.getRecordedLogs()), 0, "no referral leg any more");
        assertEq(referrer.balance, paidOnce);
        assertEq(address(bag).balance - bagBefore, booked);
    }

    function test_a_referral_on_one_token_leaves_the_others_alone() public {
        _setReferral(makeAddr("some other token"), referrer, 5_000);
        _buy(curve, alice, 1 ether);
        uint256 booked = curve.protocolClaimable();
        uint256 bagBefore = address(bag).balance;
        curve.claimProtocol();
        assertEq(referrer.balance, 0);
        assertEq(address(bag).balance - bagBefore, booked);
    }

    function test_without_a_registry_everything_goes_into_the_bag() public {
        _setReferral(token, referrer, 2_500);
        vm.prank(owner);
        factory.setReferrals(address(0));
        _buy(curve, alice, 1 ether);
        uint256 booked = curve.protocolClaimable();
        uint256 bagBefore = address(bag).balance;

        vm.recordLogs();
        curve.claimProtocol();
        assertEq(_referralPaidCount(vm.getRecordedLogs()), 0, "no ReferralPaid");
        assertEq(referrer.balance, 0);
        assertEq(address(bag).balance - bagBefore, booked);
    }

    function test_a_registry_that_reverts_never_blocks_the_claim() public {
        RevertingReferrals broken = new RevertingReferrals();
        vm.prank(owner);
        factory.setReferrals(address(broken));
        _buy(curve, alice, 1 ether);
        uint256 booked = curve.protocolClaimable();
        uint256 bagBefore = address(bag).balance;

        vm.recordLogs();
        assertEq(curve.claimProtocol(), booked);
        assertEq(_referralPaidCount(vm.getRecordedLogs()), 0, "no ReferralPaid");
        assertEq(address(bag).balance - bagBefore, booked);
        assertEq(curve.protocolClaimable(), 0);
    }

    function test_a_registry_with_no_code_never_blocks_the_claim() public {
        vm.prank(owner);
        factory.setReferrals(makeAddr("nothing lives here"));
        _buy(curve, alice, 1 ether);
        uint256 booked = curve.protocolClaimable();
        uint256 bagBefore = address(bag).balance;
        curve.claimProtocol();
        assertEq(address(bag).balance - bagBefore, booked);
    }

    function test_a_referrer_that_rejects_the_transfer_blocks_only_that_claim_until_cleared() public {
        _setReferral(token, address(new RejectNative()), 1_000);
        _buy(curve, alice, 1 ether);
        uint256 booked = curve.protocolClaimable();

        vm.expectRevert(PairTransfer.NativeTransferFailed.selector);
        curve.claimProtocol();
        assertEq(curve.protocolClaimable(), booked, "still owed, never lost");

        // trading never notices: the leg is only touched on the claim
        _buy(curve, bob, 1 ether);
        assertGt(curve.protocolClaimable(), booked);

        _setReferral(token, address(0), 0);
        uint256 owed = curve.protocolClaimable();
        uint256 bagBefore = address(bag).balance;
        curve.claimProtocol();
        assertEq(address(bag).balance - bagBefore, owed);
    }

    function test_the_referral_leg_is_paid_in_the_pair_asset_on_an_erc20_curve() public {
        CurveConfig memory c = _config();
        c.pairToken = address(usd);
        c.startCap = 5_000e6;
        c.graduationCap = 50_000e6;
        vm.prank(owner);
        uint256 usdConfig = factory.addConfig(c);
        LaunchParams memory p = _params(_toCreator());
        p.pairToken = address(usd);
        p.configId = usdConfig;
        p.symbol = "USDFAM";
        p.salt = bytes32(uint256(2));
        (address usdToken, HoodCurve usdCurve) = _launch(_toCreator(), p, LAUNCH_FEE);
        _setReferral(usdToken, referrer, 5_000);

        usd.mint(alice, 1_000e6);
        vm.startPrank(alice);
        usd.approve(address(usdCurve), 1_000e6);
        usdCurve.buy(1_000e6, 0, alice);
        vm.stopPrank();

        uint256 booked = usdCurve.protocolClaimable();
        assertGt(booked, 0);
        vm.expectEmit(true, true, true, true, address(usdCurve));
        emit ReferralPaid(referrer, booked / 2);
        usdCurve.claimProtocol();
        assertEq(usd.balanceOf(referrer), booked / 2);
        assertEq(usd.balanceOf(address(bag)), booked - booked / 2);
        assertEq(bag.totalIn(address(usd), BagSource.Trade), booked - booked / 2, "booked as a trade fee, in dollars");
    }
}

/// @notice The referral leg on the direct machine. There is no protocol tenth any more: the
///         platform's 70 bps go to the Bag from the hook, so the referrer's share comes off those
///         70 bps as the hook routes them, inline on a sell and at the flush for buys. The test
///         contract plays the portal, so its `referrals()` is what the hook reads.
contract DirectReferralsTest is DirectPoolBase {
    HoodReferrals internal registry;
    address internal referrer = makeAddr("referrer");
    /// @dev What the portal answers when the hook asks which registry to read.
    address internal registryPointer;
    bool internal portalDown;

    event ReferralPaid(address indexed to, uint256 amount);

    bytes32 internal constant TAXED = keccak256("Taxed(bool,uint256,uint256)");

    function setUp() public override {
        super.setUp();
        registry = new HoodReferrals(address(this));
        registryPointer = address(registry);
        // No opening surcharge in the way: the leg is about the platform fee, not the penalties.
        _pastTheWindow();
    }

    function referrals() external view returns (address) {
        if (portalDown) revert("the portal cannot answer");
        return registryPointer;
    }

    function _referralPaidCount(Vm.Log[] memory logs) internal view returns (uint256 n) {
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter == address(hook) && logs[i].topics[0] == ReferralPaid.selector) ++n;
        }
    }

    /// @dev The quote the pool moved on the sell, off the hook's own Taxed event: what the 70 bps
    ///      were computed on.
    function _sellVolume(Vm.Log[] memory logs) internal view returns (uint256) {
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter != address(hook) || logs[i].topics[0] != TAXED) continue;
            (bool isBuy,, uint256 volume) = abi.decode(logs[i].data, (bool, uint256, uint256));
            if (!isBuy) return volume;
        }
        revert("no sell was taxed");
    }

    function _bagTrade() internal view returns (uint256) {
        return bag.total(bag.TRADE(), address(0));
    }

    function test_a_buys_bag_share_pays_the_referrer_its_cut_when_it_is_flushed() public {
        registry.setReferral(address(token), referrer, 2_500);
        _buyExactIn(alice, 1 ether);
        uint256 bagFee = (1 ether * BAG_BPS) / BPS;
        assertEq(hook.bagClaims(), bagFee, "a buy's platform fee waits as a claim");
        assertEq(referrer.balance, 0, "so nothing has moved yet");

        vm.expectEmit(true, true, true, true, address(hook));
        emit ReferralPaid(referrer, bagFee / 4);
        hook.flushClaims();

        assertEq(referrer.balance, bagFee / 4, "a quarter of the Bag's 70 bps");
        assertEq(_bagTrade(), bagFee - bagFee / 4, "the Bag books the fee net of the cut");
        MockBag.Call memory last = bag.lastCall();
        assertEq(last.kind, bag.TRADE());
        assertEq(last.token, address(token), "and knows which launch paid it");
        assertEq(hook.bagClaims(), 0);
        // The creator's leg is untouched: the base tax plus the 30 bps, all of it in the splitter.
        assertEq(address(splitter).balance, (1 ether * CREATOR_BUY) / BPS, "the leg is the Bag's, never the creator's");
    }

    function test_a_sells_bag_share_pays_the_referrer_its_cut_inline() public {
        registry.setReferral(address(token), referrer, 2_500);
        _buyExactIn(alice, 1 ether);
        hook.flushClaims();
        uint256 referrerBefore = referrer.balance;
        uint256 bagBefore = _bagTrade();

        vm.recordLogs();
        _sellExactIn(alice, token.balanceOf(alice) / 2);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        uint256 bagFee = (_sellVolume(logs) * BAG_BPS) / BPS;
        assertGt(bagFee, 0);

        assertEq(_referralPaidCount(logs), 1, "one ReferralPaid, from the hook, inside the swap");
        assertEq(referrer.balance - referrerBefore, bagFee / 4);
        assertEq(_bagTrade() - bagBefore, bagFee - bagFee / 4);
    }

    function test_clearing_the_referral_stops_the_payments() public {
        registry.setReferral(address(token), referrer, 2_500);
        _buyExactIn(alice, 1 ether);
        hook.flushClaims();
        uint256 paidOnce = referrer.balance;
        assertGt(paidOnce, 0);

        registry.setReferral(address(token), address(0), 0);
        _buyExactIn(bob, 1 ether);
        uint256 bagBefore = _bagTrade();
        vm.recordLogs();
        hook.flushClaims();
        assertEq(_referralPaidCount(vm.getRecordedLogs()), 0, "no referral leg any more");
        assertEq(referrer.balance, paidOnce);
        assertEq(_bagTrade() - bagBefore, (1 ether * BAG_BPS) / BPS, "the whole 70 bps to the Bag");
    }

    function test_a_referral_on_another_token_leaves_this_one_alone() public {
        registry.setReferral(makeAddr("some other token"), referrer, 5_000);
        _buyExactIn(alice, 1 ether);
        hook.flushClaims();
        assertEq(referrer.balance, 0);
        assertEq(_bagTrade(), (1 ether * BAG_BPS) / BPS);
    }

    /// @dev Three ways the read can fail, none of which may touch a trade: the portal itself
    ///      reverts on `referrals()`, the registry it names reverts on `split`, and the registry
    ///      it names has no code. Every one of them pays the Bag in full and blocks nothing.
    function test_a_portal_or_registry_that_cannot_answer_pays_no_referral_and_blocks_nothing() public {
        registry.setReferral(address(token), referrer, 5_000);
        uint256 bagFee = (1 ether * BAG_BPS) / BPS;

        portalDown = true;
        _buyExactIn(alice, 1 ether);
        vm.recordLogs();
        hook.flushClaims();
        assertEq(_referralPaidCount(vm.getRecordedLogs()), 0, "the portal cannot answer: no leg");
        assertEq(_bagTrade(), bagFee);
        _sellExactIn(alice, token.balanceOf(alice) / 4); // the inline road goes through as well
        assertEq(referrer.balance, 0);

        portalDown = false;
        registryPointer = address(new RevertingReferrals());
        _buyExactIn(bob, 1 ether);
        hook.flushClaims();
        assertEq(referrer.balance, 0, "a registry that reverts: no leg");

        registryPointer = makeAddr("nothing lives here");
        _buyExactIn(bob, 1 ether);
        hook.flushClaims();
        assertEq(referrer.balance, 0, "a registry with no code: no leg");
        assertEq(hook.bagClaims(), 0, "every flush went through");
    }

    /// @dev On the curve a referrer that rejects the transfer blocks that launch's claim until the
    ///      owner clears it, because a claim is its own transaction. Here the leg is paid inside a
    ///      swap, so a referrer can never be allowed to fail one: the cut it refuses stays in the
    ///      Bag, and nothing is announced.
    function test_a_referrer_that_rejects_the_transfer_forfeits_the_cut_to_the_bag() public {
        address refuser = address(new RejectNative());
        registry.setReferral(address(token), refuser, 1_000);
        _buyExactIn(alice, 1 ether);
        uint256 bagFee = (1 ether * BAG_BPS) / BPS;

        vm.recordLogs();
        hook.flushClaims();
        assertEq(_referralPaidCount(vm.getRecordedLogs()), 0, "nothing was paid, so nothing is announced");
        assertEq(refuser.balance, 0);
        assertEq(_bagTrade(), bagFee, "the Bag takes the whole share");

        // trading never notices either
        uint256 bagBefore = _bagTrade();
        vm.recordLogs();
        _sellExactIn(alice, token.balanceOf(alice) / 2);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertEq(_referralPaidCount(logs), 0);
        assertEq(_bagTrade() - bagBefore, (_sellVolume(logs) * BAG_BPS) / BPS);
    }
}
