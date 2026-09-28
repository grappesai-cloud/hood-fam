// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {BaseTest} from "./Base.t.sol";
import {HoodCurve} from "../src/HoodCurve.sol";
import {HoodFactory} from "../src/HoodFactory.sol";
import {HoodStaking} from "../src/HoodStaking.sol";
import {HoodToken} from "../src/HoodToken.sol";
import {HoodTokenLock} from "../src/HoodTokenLock.sol";
import {CurveConfig, FeeSplit, Launch, LaunchParams} from "../src/HoodTypes.sol";
import {BagSource} from "../src/bag/BagTypes.sol";
import {IHoodPot} from "../src/interfaces/IHoodPot.sol";
import {PairTransfer} from "../src/libraries/PairTransfer.sol";
import {MockBag, MockPot, MockQuote, MockTaxQuote} from "./mocks/Mocks.sol";

contract FactoryTest is BaseTest {
    function test_any_creator_can_launch_against_a_custom_erc20_without_owner_permission() public {
        MockQuote quote = new MockQuote("OG", 9);
        CurveConfig memory c = _config();
        c.pairToken = address(quote);
        c.startCap = 5_000_000_000; // five OG, in nine-decimal quote units
        c.graduationCap = 50_000_000_000;

        LaunchParams memory p = _params(_toCreator());
        p.pairToken = address(quote);
        p.symbol = "BABYOG";
        p.salt = bytes32(uint256(9001));

        uint256 beforeConfigs = factory.configCount();
        vm.prank(creator);
        (address token, address curve,) = factory.launchCustom{value: LAUNCH_FEE}(p, c);

        assertTrue(factory.pairAllowed(address(quote)), "the custom quote becomes reusable");
        assertEq(factory.configCount(), beforeConfigs + 1);
        assertEq(factory.getLaunch(token).configId, beforeConfigs, "the generated preset is recorded");
        assertEq(factory.getConfig(beforeConfigs).pairToken, address(quote));

        quote.mint(alice, 2_000_000_000);
        vm.startPrank(alice);
        quote.approve(curve, type(uint256).max);
        uint256 bought = HoodCurve(payable(curve)).buy(1_000_000_000, 0, alice);
        vm.stopPrank();
        assertGt(bought, 0, "meme-to-meme trading is live");
    }

    function test_custom_quote_over_eighteen_decimals_is_refused() public {
        MockQuote quote = new MockQuote("WEIRD", 19);
        CurveConfig memory c = _config();
        c.pairToken = address(quote);
        LaunchParams memory p = _params(_toCreator());
        p.pairToken = address(quote);
        p.symbol = "NOPE";

        vm.prank(creator);
        vm.expectRevert(HoodFactory.UnsupportedPairDecimals.selector);
        factory.launchCustom{value: LAUNCH_FEE}(p, c);
    }

    function test_a_taxed_custom_quote_cannot_corrupt_the_curve_reserve() public {
        MockTaxQuote quote = new MockTaxQuote();
        CurveConfig memory c = _config();
        c.pairToken = address(quote);
        LaunchParams memory p = _params(_toCreator());
        p.pairToken = address(quote);
        p.symbol = "TAXED";
        p.salt = bytes32(uint256(9002));

        vm.prank(creator);
        (, address curve,) = factory.launchCustom{value: LAUNCH_FEE}(p, c);
        quote.mint(alice, 2 ether);
        vm.startPrank(alice);
        quote.approve(curve, type(uint256).max);
        vm.expectRevert(PairTransfer.FeeOnTransferPair.selector);
        HoodCurve(payable(curve)).buy(1 ether, 0, alice);
        vm.stopPrank();

        assertEq(HoodCurve(payable(curve)).reserve(), 0, "a taxed transfer books no phantom reserve");
    }

    /// @dev This one is here because it already bit: the factory inlined the token and the curve
    ///      bytecode and came out 2,461 bytes over what an account may hold, so it could not be
    ///      deployed at all. The bytecode lives in HoodDeployer now.
    function test_every_contract_fits_in_an_account() public view {
        assertLt(address(factory).code.length, 24_576, "factory");
        assertLt(address(staking).code.length, 24_576, "staking");
        assertLt(address(router).code.length, 24_576, "fee router");
        assertLt(address(factory.deployer()).code.length, 24_576, "deployer");
        assertLt(address(factory.deployer().potDeployer()).code.length, 24_576, "pot deployer");
    }

    function test_the_launch_fee_goes_into_the_bag_as_a_house_fee() public {
        uint256 before = address(bag).balance;
        (address token,) = _launch(_toCreator());
        assertEq(address(bag).balance - before, LAUNCH_FEE);
        assertEq(bag.totalIn(address(0), BagSource.House), LAUNCH_FEE, "booked as a house fee");
        MockBag.Take memory take = bag.lastTake();
        assertEq(take.token, token, "against the launch that paid it");
        assertEq(take.from, address(factory));
        assertEq(treasury.balance, 0, "the treasury is not paid directly any more");
    }

    /// @dev A curve pins its Bag for life. Launched before one is named, it could never claim a fee
    ///      or finalize, so the launch is refused instead of printing a token that cannot graduate.
    function test_a_launch_needs_the_bag() public {
        HoodFactory bare = new HoodFactory(owner, treasury, makeAddr("deployer"));
        vm.startPrank(owner);
        bare.setModules(address(router), address(staking), address(graduator));
        bare.setLaunchFee(LAUNCH_FEE);
        bare.addConfig(_config());
        vm.stopPrank();

        vm.prank(creator);
        vm.expectRevert(HoodFactory.NoBag.selector);
        bare.launch{value: LAUNCH_FEE}(_params(_toCreator()));

        // named once, and only once
        vm.prank(owner);
        bare.setBag(address(bag));
        assertEq(bare.bag(), address(bag));
        vm.prank(owner);
        vm.expectRevert(HoodFactory.ModulesAlreadySet.selector);
        bare.setBag(makeAddr("another bag"));
    }

    function test_the_launch_fee_is_capped() public {
        assertEq(factory.MAX_LAUNCH_FEE(), 0.01 ether);
        vm.prank(owner);
        vm.expectRevert(HoodFactory.BadFee.selector);
        factory.setLaunchFee(0.01 ether + 1);
        vm.prank(owner);
        factory.setLaunchFee(0.01 ether);
        assertEq(factory.launchFee(), 0.01 ether);
    }

    // ---------------------------------------------------------------- the pot

    function test_a_launch_prints_a_pot_and_names_it_on_the_token() public {
        (address token, HoodCurve curve) = _launch(_toCreator());
        Launch memory l = factory.getLaunch(token);
        assertTrue(l.pot != address(0), "every curve launch gets a pot");
        assertEq(HoodToken(token).pot(), l.pot, "the token knows it");
        assertEq(IHoodPot(l.pot).token(), token);
        assertEq(IHoodPot(l.pot).asset(), address(0), "paid in the launch's quote");
        assertEq(curve.bag(), address(bag), "and the curve pins the bag");

        // named once, by the factory alone
        vm.prank(bob);
        vm.expectRevert(HoodToken.NotFactory.selector);
        HoodToken(token).setPot(bob);
        vm.prank(address(factory));
        vm.expectRevert(HoodToken.PotAlreadySet.selector);
        HoodToken(token).setPot(bob);
    }

    function test_a_dollar_launch_gets_a_dollar_pot() public {
        CurveConfig memory c = _config();
        c.pairToken = address(usd);
        c.startCap = 5_000e6;
        c.graduationCap = 50_000e6;
        vm.prank(owner);
        uint256 usdConfig = factory.addConfig(c);
        LaunchParams memory p = _params(_toCreator());
        p.pairToken = address(usd);
        p.configId = usdConfig;
        p.symbol = "USDPOT";
        (address token,) = _launch(_toCreator(), p, LAUNCH_FEE);
        assertEq(IHoodPot(factory.getLaunch(token).pot).asset(), address(usd));
    }

    /// @dev The token's side of the wire, on its own: every balance move reaches the pot with the
    ///      balances after the move, the mint before the pot is named reaches nobody.
    function test_the_token_tells_its_pot_about_every_balance_move() public {
        HoodToken t = new HoodToken("Wire", "WIRE", "", "", 1_000e18, alice, address(this));
        MockPot mock = new MockPot(address(t), address(0));
        assertEq(t.factory(), address(this));
        assertEq(t.pot(), address(0));
        assertEq(mock.syncCount(), 0, "the mint happened before there was a pot");

        vm.prank(bob);
        vm.expectRevert(HoodToken.NotFactory.selector);
        t.setPot(address(mock));
        vm.expectRevert(HoodToken.ZeroAddress.selector);
        t.setPot(address(0));
        t.setPot(address(mock));

        vm.prank(alice);
        t.transfer(bob, 400e18);
        MockPot.Sync memory s = mock.lastSync();
        assertEq(mock.syncCount(), 1);
        assertEq(s.from, alice);
        assertEq(s.to, bob);
        assertEq(s.fromBalance, 600e18, "alice's balance after the move");
        assertEq(s.toBalance, 400e18, "bob's balance after the move");

        vm.prank(bob);
        t.burn(100e18);
        s = mock.lastSync();
        assertEq(s.from, bob);
        assertEq(s.to, address(0));
        assertEq(s.fromBalance, 300e18);
        assertEq(s.toBalance, 0, "a burn has no receiver");

        vm.expectRevert(HoodToken.PotAlreadySet.selector);
        t.setPot(address(mock));
    }

    function test_a_direct_launch_records_its_splitter_as_its_pot() public {
        address direct = makeAddr("directToken");
        address splitter = makeAddr("splitter");
        vm.prank(owner);
        factory.setPortal(address(this));
        factory.registerDirectLaunch(direct, creator, address(0), makeAddr("hook"), splitter, makeAddr("locker"), "DIR", "");
        assertEq(factory.getLaunch(direct).pot, splitter);
    }

    // ---------------------------------------------------------------- the opening tax

    function test_the_launcher_the_fee_recipient_and_the_named_wallets_pay_no_opening_tax() public {
        address team = makeAddr("team");
        LaunchParams memory p = _params(_toCreator());
        p.creatorFeeRecipient = bob;
        p.exempt = new address[](1);
        p.exempt[0] = team;
        (, HoodCurve curve) = _launch(_toCreator(), p, LAUNCH_FEE);

        assertTrue(curve.snipeExempt(creator), "the launcher");
        assertTrue(curve.snipeExempt(bob), "the fee recipient");
        assertTrue(curve.snipeExempt(team), "the named wallet");
        assertFalse(curve.snipeExempt(alice));
        vm.warp(curve.launchedAt());
        assertEq(curve.currentSnipeTaxBps(team), 0);
        assertEq(curve.currentSnipeTaxBps(alice), 9_900, "the launch's own second");
    }

    function test_an_exempt_list_past_the_cap_is_refused_and_the_cap_itself_is_not() public {
        LaunchParams memory p = _params(_toCreator());
        p.exempt = new address[](33);
        for (uint256 i; i < 33; ++i) {
            p.exempt[i] = address(uint160(0x1000 + i));
        }
        vm.prank(creator);
        vm.expectRevert(HoodFactory.ExemptionListTooLong.selector);
        factory.launch{value: LAUNCH_FEE}(p);

        address[] memory full = new address[](32);
        for (uint256 i; i < 32; ++i) {
            full[i] = address(uint160(0x1000 + i));
        }
        p.exempt = full;
        (, HoodCurve curve) = _launch(_toCreator(), p, LAUNCH_FEE);
        assertTrue(curve.snipeExempt(address(0x101f)));
    }

    /// @dev The refund after a creator's first buy is what the curve handed back, not whatever the
    ///      factory happens to hold: it has a `receive`, so strays accumulate, and sweeping the
    ///      balance would pay them out to whoever launches next.
    function test_a_first_buy_refunds_its_own_change_and_not_the_factorys_balance() public {
        vm.deal(address(this), 5 ether);
        (bool ok,) = address(factory).call{value: 5 ether}("");
        assertTrue(ok, "a stray donation lands in the factory");

        LaunchParams memory p = _params(_toCreator());
        uint256 before = creator.balance;
        vm.prank(creator);
        factory.launch{value: LAUNCH_FEE + 1 ether}(p);

        // the creator paid the fee and one ether of first buy, and got back only the curve's change
        assertGe(before - creator.balance, LAUNCH_FEE, "the launch fee was paid");
        assertLe(before - creator.balance, LAUNCH_FEE + 1 ether, "and never more than what was sent");
        assertEq(address(factory).balance, 5 ether, "the stray is still sitting there, untouched");
    }

    function test_launch_needs_the_fee() public {
        LaunchParams memory p = _params(_toCreator());
        vm.prank(creator);
        vm.expectRevert(HoodFactory.BadFee.selector);
        factory.launch{value: LAUNCH_FEE - 1}(p);
    }

    function test_the_creator_can_take_the_first_buy_in_the_same_transaction() public {
        LaunchParams memory p = _params(_toCreator());
        uint256 before = creator.balance;

        vm.prank(creator);
        (address token,, uint256 bought) = factory.launch{value: LAUNCH_FEE + 1 ether}(p);

        assertGt(bought, 0);
        assertEq(IERC20(token).balanceOf(creator), bought);
        assertEq(before - creator.balance, LAUNCH_FEE + 1 ether);
        assertEq(address(factory).balance, 0);
    }

    /// @dev The first buy is the one parcel of tokens nobody else could have bought yet. Locked,
    ///      it belongs to the creator, it earns from minute one, and it cannot be sold into the
    ///      people who buy next. It is held by the locker and earns nothing: locking for money is
    ///      the house coin's job, and a creator's own token has no room in that vault.
    function test_a_creator_can_lock_their_own_first_buy() public {
        LaunchParams memory p = _params(_toBuyback());
        p.firstBuyLock = 30 days;

        vm.prank(creator);
        (address token,, uint256 bought) = factory.launch{value: LAUNCH_FEE + 1 ether}(p);

        assertGt(bought, 0);
        assertEq(IERC20(token).balanceOf(creator), 0, "nothing lands in the creator's wallet");

        (address lockToken, address lockOwner, uint128 amount, uint64 unlockAt) = locker.locks(1);
        assertEq(lockToken, token);
        assertEq(lockOwner, creator, "the lock is the creator's, not the factory's");
        assertEq(amount, bought);
        assertEq(unlockAt, uint64(block.timestamp) + 30 days);
        assertEq(IERC20(token).balanceOf(address(locker)), bought, "and the tokens are really there");

        Launch memory l = factory.getLaunch(token);
        assertEq(l.firstBuyLocked, bought, "and the row says so, without reading a log");
        assertEq(l.firstBuyUnlockAt, unlockAt);

        vm.prank(creator);
        vm.expectRevert(HoodTokenLock.StillLocked.selector);
        locker.withdraw(1);

        vm.warp(block.timestamp + 30 days);
        vm.prank(creator);
        locker.withdraw(1);
        assertEq(IERC20(token).balanceOf(creator), bought, "and then it is theirs to do as they like");
    }

    /// @dev A locked first buy is a statement, not a yield: the tokens sit still and earn nothing.
    ///      What the launch's stakers leg pays goes to whoever locked the house coin, which is a
    ///      different room and, usually, different people.
    function test_a_locked_first_buy_earns_nothing_itself() public {
        uint256 housePosition = _lockHouse(alice, 1 ether, 30 days);

        LaunchParams memory p = _params(_toStakers());
        p.firstBuyLock = 7 days;
        p.symbol = "LOCKED";
        p.salt = bytes32(uint256(31));

        vm.prank(creator);
        (address token, address curveAddr,) = factory.launch{value: LAUNCH_FEE + 1 ether}(p);

        _buy(HoodCurve(payable(curveAddr)), bob, 1 ether);
        router.flush(token);

        assertEq(IERC20(token).balanceOf(address(staking)), 0, "the launch's token never enters the vault");
        assertGt(staking.pending(housePosition, address(0)), 0, "the house coin's room is paid instead");
    }

    /// @dev A lock is one of the locker's lengths or it is nothing, so the app, the factory and the
    ///      locker cannot each mean something different by the same number of seconds.
    function test_a_lock_that_is_not_a_tier_is_refused() public {
        LaunchParams memory p = _params(_toBuyback());
        p.firstBuyLock = 10 days;
        vm.prank(creator);
        vm.expectRevert(HoodFactory.BadLock.selector);
        factory.launch{value: LAUNCH_FEE + 1 ether}(p);
    }

    /// @dev A preset's caps are numbers without a unit until the preset names one. Launching the
    ///      dollar preset against ETH would open at five thousandths of an ETH rather than at five
    ///      thousand dollars, and every screen on the way would have looked right.
    function test_a_preset_cannot_be_launched_against_another_pair() public {
        CurveConfig memory c = _config();
        c.pairToken = address(usd);
        c.startCap = 5_000e6;
        c.graduationCap = 50_000e6;
        vm.prank(owner);
        uint256 usdConfig = factory.addConfig(c);

        LaunchParams memory p = _params(_toBuyback());
        p.configId = usdConfig;
        p.pairToken = address(0); // the preset is the dollar's
        p.symbol = "MIX";
        vm.prank(creator);
        vm.expectRevert(HoodFactory.PairMismatch.selector);
        factory.launch{value: LAUNCH_FEE}(p);
    }

    /// @dev And a preset for an asset the pad does not take could never be launched at all.
    function test_a_preset_for_an_unknown_pair_is_refused() public {
        CurveConfig memory c = _config();
        c.pairToken = makeAddr("some other token");
        vm.prank(owner);
        vm.expectRevert(HoodFactory.PairNotAllowed.selector);
        factory.addConfig(c);
    }

    /// @dev Otherwise a creator walks away believing their first buy is locked when there was none.
    function test_a_lock_with_no_first_buy_is_refused() public {
        LaunchParams memory p = _params(_toBuyback());
        p.firstBuyLock = 30 days;
        vm.prank(creator);
        vm.expectRevert(HoodFactory.NoFirstBuy.selector);
        factory.launch{value: LAUNCH_FEE}(p);
    }

    function test_a_dollar_first_buy_locks_the_same_way() public {
        CurveConfig memory c = _config();
        // A preset carries the asset its caps are written in, so a dollar preset says so.
        c.pairToken = address(usd);
        c.startCap = 5_000e6;
        c.graduationCap = 50_000e6;
        vm.prank(owner);
        uint256 usdConfig = factory.addConfig(c);

        LaunchParams memory p = _params(_toBuyback());
        p.pairToken = address(usd);
        p.configId = usdConfig;
        p.symbol = "USDLOCK";
        p.image = "ipfs://lock";
        p.firstBuy = 10_000e6;
        p.firstBuyLock = 90 days;

        usd.mint(creator, 10_000e6);
        vm.startPrank(creator);
        usd.approve(address(factory), 10_000e6);
        (address token,, uint256 bought) = factory.launch{value: LAUNCH_FEE}(p);
        vm.stopPrank();

        assertGt(bought, 0);
        assertEq(IERC20(token).balanceOf(creator), 0);
        (, address lockOwner, uint128 amount, uint64 unlockAt) = locker.locks(1);
        assertEq(lockOwner, creator);
        assertEq(amount, bought);
        assertEq(unlockAt, uint64(block.timestamp) + 90 days);
    }

    function test_an_oversized_first_buy_comes_back_to_the_creator() public {
        LaunchParams memory p = _params(_toCreator());
        uint256 before = creator.balance;

        vm.prank(creator);
        (, address curve,) = factory.launch{value: LAUNCH_FEE + 100 ether}(p);

        assertEq(uint8(HoodCurve(payable(curve)).phase()), 1); // sold out in one go
        // about 4.4 ETH of raise plus fee left the creator's pocket, not 100
        assertGt(creator.balance, before - 6 ether);
        assertEq(address(factory).balance, 0);
    }

    function test_an_oversized_erc20_first_buy_refunds_only_its_own_change() public {
        CurveConfig memory c = _config();
        c.pairToken = address(usd);
        c.startCap = 5_000e6;
        c.graduationCap = 50_000e6;
        vm.prank(owner);
        uint256 usdConfig = factory.addConfig(c);

        LaunchParams memory p = _params(_toCreator());
        p.pairToken = address(usd);
        p.configId = usdConfig;
        p.symbol = "USDREFUND";
        p.firstBuy = 100_000e6;

        usd.mint(creator, p.firstBuy);
        usd.mint(address(factory), 77e6); // a prior stray must not go to this creator
        vm.startPrank(creator);
        usd.approve(address(factory), p.firstBuy);
        (, address curve,) = factory.launch{value: LAUNCH_FEE}(p);
        vm.stopPrank();

        assertEq(uint8(HoodCurve(payable(curve)).phase()), 1, "the curve sold out");
        assertGt(usd.balanceOf(creator), 70_000e6, "unused quote returned to creator");
        assertEq(usd.balanceOf(address(factory)), 77e6, "stray balance preserved");
    }

    function test_economics_are_pinned_by_the_creator() public {
        LaunchParams memory p = _params(_toCreator());
        p.econ = factory.previewLaunchEconomics(configId, address(0));

        // the launchpad moves its fee between the quote and the signature
        vm.prank(owner);
        factory.setLaunchFee(0.005 ether);

        vm.prank(creator);
        vm.expectRevert(HoodFactory.BadEconomics.selector);
        factory.launch{value: 0.005 ether}(p);
    }

    function test_a_disabled_preset_cannot_be_used_but_live_tokens_keep_trading() public {
        (, HoodCurve curve) = _launch(_toCreator());
        vm.prank(owner);
        factory.setConfigEnabled(configId, false);

        LaunchParams memory p = _params(_toCreator());
        p.salt = bytes32(uint256(99));
        vm.prank(bob);
        vm.expectRevert(HoodFactory.ConfigDisabled.selector);
        factory.launch{value: LAUNCH_FEE}(p);

        // the token that already launched is untouched
        assertGt(_buy(curve, alice, 1 ether), 0);
    }

    function test_a_preset_must_leave_the_liquidity_in_the_pool() public {
        CurveConfig memory c = _config();
        c.liquidityBps = 5000; // half the raise walking out at graduation
        vm.prank(owner);
        vm.expectRevert(HoodFactory.BadConfig.selector);
        factory.addConfig(c);
    }

    function test_a_preset_cannot_charge_more_than_five_percent() public {
        CurveConfig memory c = _config();
        c.creatorFeeBps = 600;
        vm.prank(owner);
        vm.expectRevert(HoodFactory.BadFee.selector);
        factory.addConfig(c);
    }

    function test_only_an_allowed_pair_can_be_launched_against() public {
        LaunchParams memory p = _params(_toCreator());
        p.pairToken = address(0xdead);
        vm.prank(creator);
        vm.expectRevert(HoodFactory.PairNotAllowed.selector);
        factory.launch{value: LAUNCH_FEE}(p);
    }

    function test_a_working_ticker_locks_out_the_copycats() public {
        vm.prank(owner);
        factory.setPair(address(0), true, 1 ether);

        (address token, HoodCurve curve) = _launch(_toCreator());
        assertTrue(factory.isSymbolAvailable("FAM"));

        _buy(curve, alice, 2 ether); // crosses the 24h volume threshold

        assertFalse(factory.isSymbolAvailable("FAM"));
        assertFalse(factory.isSymbolAvailable("fam"), "case does not get you around it");
        assertEq(factory.symbolLockOwner(factory.symbolHash("FAM")), token);

        LaunchParams memory p = _params(_toCreator());
        p.salt = bytes32(uint256(2));
        vm.prank(bob);
        vm.expectRevert(HoodFactory.TickerLockedError.selector);
        factory.launch{value: LAUNCH_FEE}(p);

        // same artwork, different ticker, still blocked
        p.symbol = "FAM2";
        vm.prank(bob);
        vm.expectRevert(HoodFactory.ImageLockedError.selector);
        factory.launch{value: LAUNCH_FEE}(p);

        // and the lock lets go once the volume is history
        vm.warp(block.timestamp + 48 hours + 1);
        assertTrue(factory.isSymbolAvailable("FAM"));
        vm.prank(bob);
        factory.launch{value: LAUNCH_FEE}(p);
    }

    function test_a_quiet_token_never_locks_its_ticker() public {
        vm.prank(owner);
        factory.setPair(address(0), true, 1 ether);
        (, HoodCurve curve) = _launch(_toCreator());
        _buy(curve, alice, 0.1 ether);
        assertTrue(factory.isSymbolAvailable("FAM"));
    }

    function test_only_the_current_recipient_moves_the_fee_stream() public {
        (address token,) = _launch(_toCreator());
        vm.prank(bob);
        vm.expectRevert(HoodFactory.NotRecipient.selector);
        factory.transferCreatorFeeRecipient(token, bob);

        vm.prank(creator);
        factory.transferCreatorFeeRecipient(token, bob);
        assertEq(factory.creatorFeeRecipient(token), bob);

        vm.prank(creator);
        vm.expectRevert(HoodFactory.NotRecipient.selector);
        factory.transferCreatorFeeRecipient(token, creator);
    }

    function test_volume_is_only_recorded_by_the_curve_that_owns_the_token() public {
        (address token,) = _launch(_toCreator());
        vm.expectRevert(HoodFactory.NotACurve.selector);
        factory.recordVolume(token, 1 ether);
    }

    function test_modules_are_wired_once_and_the_handler_only_changes_for_new_launches() public {
        (, HoodCurve curve) = _launch(_toCreator());
        address pinned = curve.graduationHandler();

        vm.prank(owner);
        vm.expectRevert(HoodFactory.ModulesAlreadySet.selector);
        factory.setModules(address(router), address(staking), address(graduator));

        vm.prank(owner);
        factory.setGraduationHandler(address(0xBEEF));
        assertEq(curve.graduationHandler(), pinned, "a live curve keeps the handler it was born with");
    }

    function test_a_launch_against_an_erc20_pair_trades_and_graduates() public {
        CurveConfig memory c = _config();
        // A preset carries the asset its caps are written in, so a dollar preset says so.
        c.pairToken = address(usd);
        c.startCap = 5_000e6; // dollars, six decimals
        c.graduationCap = 50_000e6;
        vm.prank(owner);
        uint256 usdConfig = factory.addConfig(c);

        LaunchParams memory p = _params(_toCreator());
        p.pairToken = address(usd);
        p.configId = usdConfig;
        p.symbol = "USDFAM";
        p.image = "ipfs://other";

        vm.prank(creator);
        (address token, address curveAddr,) = factory.launch{value: LAUNCH_FEE}(p);
        HoodCurve curve = HoodCurve(payable(curveAddr));

        usd.mint(alice, 100_000e6);
        vm.startPrank(alice);
        usd.approve(address(curve), type(uint256).max);
        uint256 out = curve.buy(10_000e6, 0, alice);
        vm.stopPrank();

        assertGt(out, 0);
        assertEq(IERC20(token).balanceOf(alice), out);
        assertEq(usd.balanceOf(address(curve)), curve.reserve() + curve.protocolClaimable());
        uint256 booked = curve.protocolClaimable();
        assertGt(booked, 0);
        curve.claimProtocol();
        assertEq(usd.balanceOf(address(bag)), booked, "the bag pulls the dollars it was approved for");
        assertEq(bag.totalIn(address(usd), BagSource.Trade), booked);
        assertGt(router.accrued(token), 0);

        // sell back
        vm.startPrank(alice);
        IERC20(token).approve(address(curve), out);
        uint256 back = curve.sell(out, 0, alice);
        vm.stopPrank();
        assertGt(back, 0);
        assertLt(back, 10_000e6);

        // and the creator's fee stream pays out in dollars
        uint256 creatorBefore = usd.balanceOf(creator);
        router.flush(token);
        assertGt(usd.balanceOf(creator) - creatorBefore, 0);
    }
}
