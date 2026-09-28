// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";

import {HoodLaunchToken} from "../src/direct/HoodLaunchToken.sol";
import {HoodRevenueSplitter} from "../src/direct/HoodRevenueSplitter.sol";
import {Allocations, Socials} from "../src/direct/DirectTypes.sol";

/// @notice The token itself: metadata, the zero address, and the open that it does not gate.
contract DirectTokenTest is Test {
    HoodLaunchToken internal token;
    address internal portal = address(this);
    address internal creator = makeAddr("creator");
    address internal pool = makeAddr("poolManager");
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");

    uint256 internal constant SUPPLY = 1_000_000_000e18;

    function setUp() public {
        HoodLaunchToken implementation = new HoodLaunchToken();
        token = HoodLaunchToken(Clones.clone(address(implementation)));
        token.initialize(
            "Hood Fam", "FAM", "ipfs://logo", "the fam",
            Socials("@hoodfam", "t.me/hoodfam", "discord.gg/hoodfam", "https://hood.fam", "hoodfam.eth"),
            SUPPLY, creator
        );
        token.setLaunchAddresses(pool, address(0));
        // the pool holds the supply, the way it does after a launch
        token.transfer(pool, SUPPLY);
    }

    function test_metadata_is_on_chain_where_an_explorer_can_read_it() public view {
        assertEq(token.name(), "Hood Fam");
        assertEq(token.symbol(), "FAM");
        assertEq(token.logo(), "ipfs://logo");
        assertEq(token.description(), "the fam");
        Socials memory s = token.socials();
        assertEq(s.twitter, "@hoodfam");
        assertEq(s.discord, "discord.gg/hoodfam");
        assertEq(s.farcaster, "hoodfam.eth");
        assertEq(token.liquidityPool(), pool);
        assertEq(token.totalSupply(), SUPPLY);
    }

    /// @dev OpenZeppelin refuses a transfer to the zero address, and so does this: without the
    ///      check it is a silent burn, since `_update` is also the burn path. `burn` is still there
    ///      for anybody who means it.
    function test_a_transfer_to_the_zero_address_is_refused_not_burned() public {
        vm.prank(pool);
        token.transfer(alice, 1e18);

        uint256 supply = token.totalSupply();
        vm.startPrank(alice);
        vm.expectRevert(abi.encodeWithSignature("ERC20InvalidReceiver(address)", address(0)));
        token.transfer(address(0), 1e18);
        vm.expectRevert(abi.encodeWithSignature("ERC20InvalidSpender(address)", address(0)));
        token.approve(address(0), 1e18);
        token.burn(1e18);
        vm.stopPrank();

        assertEq(token.totalSupply(), supply - 1e18, "burning still works when it is asked for");
    }

    /// @dev The open is priced by the hook's opening tax (SnipeSchedule), not gated here: in the
    ///      launch block itself anybody may take any amount out of the pool and hold it.
    function test_the_token_gates_nothing_at_the_open() public {
        vm.startPrank(pool);
        token.transfer(alice, SUPPLY / 2);
        token.transfer(bob, SUPPLY / 4);
        vm.stopPrank();
        assertEq(token.balanceOf(alice), SUPPLY / 2);
        vm.prank(alice);
        token.transfer(bob, SUPPLY / 2);
        assertEq(token.balanceOf(bob), (SUPPLY * 3) / 4);
    }

    function test_launch_addresses_are_set_once_by_the_portal() public {
        vm.expectRevert(HoodLaunchToken.AlreadyInitialized.selector);
        token.setLaunchAddresses(pool, address(0));
        vm.prank(alice);
        vm.expectRevert(HoodLaunchToken.NotPortal.selector);
        token.setLaunchAddresses(pool, address(0));
    }
}

contract CreatorSlashTest is Test {
    HoodLaunchToken internal token;
    HoodRevenueSplitter internal splitter;
    address internal creator = makeAddr("creator");
    address internal recipient = makeAddr("feeRecipient");
    address internal pool = makeAddr("poolManager");
    address internal alice = makeAddr("alice");

    uint256 internal constant SUPPLY = 1_000_000_000e18;

    function setUp() public {
        token = HoodLaunchToken(Clones.clone(address(new HoodLaunchToken())));
        token.initialize("T", "T", "", "", Socials("", "", "", "", ""), SUPPLY, creator);
        // the fee recipient is a different wallet than the one that launched
        splitter = new HoodRevenueSplitter(address(this), makeAddr("treasury"), makeAddr("buyback"), address(token), address(0));
        splitter.initialize(recipient, makeAddr("locker"), Allocations(5_000, 0, 5_000, 0));
        splitter.exclude(pool);
        token.setLaunchAddresses(pool, address(splitter));
        token.transfer(pool, SUPPLY);
        vm.startPrank(pool);
        token.transfer(alice, SUPPLY / 4);
        token.transfer(creator, SUPPLY / 8);
        token.transfer(recipient, SUPPLY / 8);
        vm.stopPrank();
        vm.deal(address(splitter), 10 ether);
        splitter.sweep();
        assertEq(splitter.creatorClaimable(), 5 ether);
    }

    function test_the_launcher_selling_slashes_the_unclaimed_fees_to_the_holders() public {
        uint256 before = splitter.pending(alice);
        vm.prank(creator);
        token.transfer(pool, 1e18);
        assertEq(splitter.creatorClaimable(), 0);
        assertApproxEqAbs(splitter.pending(alice) - before, 2.5 ether, 2, "half the supply in play is alice's");
        assertEq(token.balanceOf(creator), SUPPLY / 8 - 1e18, "the sell went through");
    }

    function test_the_fee_recipient_selling_slashes_too() public {
        vm.prank(recipient);
        token.transfer(pool, 1e18);
        assertEq(splitter.creatorClaimable(), 0);
    }

    function test_a_holders_sell_and_a_creators_plain_transfer_do_not_slash() public {
        vm.prank(alice);
        token.transfer(pool, 1e18);
        vm.prank(creator);
        token.transfer(alice, 1e18);
        assertEq(splitter.creatorClaimable(), 5 ether);
    }

    function test_unswept_tax_is_slashed_as_well() public {
        vm.deal(address(splitter), 20 ether); // ten more, unswept
        vm.prank(creator);
        token.transfer(pool, 1e18);
        assertEq(splitter.creatorClaimable(), 0, "the sweep ran first, so the sell's own tax went too");
        assertEq(splitter.totalDeposited(), 20 ether);
    }
}
