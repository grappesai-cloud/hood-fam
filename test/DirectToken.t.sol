// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";

import {HoodLaunchToken} from "../src/direct/HoodLaunchToken.sol";
import {Socials} from "../src/direct/DirectTypes.sol";

/// @notice The opening window: the rules that decide who gets in first, and when they stop applying.
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
            SUPPLY, creator, 30, 500, 550
        );
        token.setLaunchAddresses(pool, address(0), makeAddr("locker"), makeAddr("hook"), makeAddr("buybackModule"));
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
        vm.roll(block.number + 1); // past the launch block, which belongs to the creator
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

    function test_the_launch_block_belongs_to_the_creator() public {
        vm.prank(pool);
        vm.expectRevert(HoodLaunchToken.LaunchBlockIsTheCreators.selector);
        token.transfer(alice, 1e18);

        // the creator may take theirs in the same block
        vm.prank(pool);
        token.transfer(creator, 1_000e18);
        assertEq(token.balanceOf(creator), 1_000e18);
    }

    function test_after_the_launch_block_anybody_may_buy_up_to_the_cap() public {
        vm.roll(block.number + 1);
        uint256 cap = (SUPPLY * 500) / 10_000;

        vm.prank(pool);
        token.transfer(alice, cap);
        assertEq(token.balanceOf(alice), cap);

        vm.prank(pool);
        vm.expectRevert(HoodLaunchToken.HoldsTooMuch.selector);
        token.transfer(alice, 1);
    }

    /// @dev The two caps do different jobs. Holding is capped at 5%, so a wallet cannot end up with
    ///      more than that. Buying is capped at 5.5% cumulatively, so a wallet cannot buy to the
    ///      hold cap, move the tokens to a second wallet, and come back for more.
    function test_selling_does_not_refill_a_wallets_buy_allowance() public {
        vm.roll(block.number + 1);
        uint256 holdCap = (SUPPLY * 500) / 10_000; // 5%

        vm.prank(pool);
        token.transfer(alice, holdCap); // bought 5.0%, holding 5.0%

        vm.prank(alice);
        token.transfer(bob, (SUPPLY * 100) / 10_000); // moves 1% out, holding 4%

        // 0.4% more is fine: 5.4% bought in total
        vm.prank(pool);
        token.transfer(alice, (SUPPLY * 40) / 10_000);

        // another 0.2% would be 5.6% bought, past the buy cap, even though the hold cap is clear
        vm.prank(pool);
        vm.expectRevert(HoodLaunchToken.BuysTooMuch.selector);
        token.transfer(alice, (SUPPLY * 20) / 10_000);
    }

    function test_selling_and_plain_transfers_are_never_restricted() public {
        vm.roll(block.number + 1);
        vm.prank(pool);
        token.transfer(alice, 1_000e18);

        vm.prank(alice);
        token.transfer(pool, 1_000e18); // selling back
        assertEq(token.balanceOf(alice), 0);
    }

    function test_every_limit_expires_on_its_own() public {
        vm.roll(block.number + 31);
        uint256 huge = (SUPPLY * 40) / 100;

        vm.prank(pool);
        token.transfer(alice, huge);
        assertEq(token.balanceOf(alice), huge);
    }

    function test_zero_blocks_means_no_window_at_all() public {
        HoodLaunchToken free = HoodLaunchToken(Clones.clone(address(new HoodLaunchToken())));
        free.initialize(
            "Free", "FREE", "", "", Socials("", "", "", "", ""), SUPPLY, creator, 0, 100, 100
        );
        free.setLaunchAddresses(pool, address(0), makeAddr("locker2"), makeAddr("hook2"), makeAddr("buybackModule"));
        free.transfer(pool, SUPPLY);

        vm.prank(pool);
        free.transfer(alice, SUPPLY / 2);
        assertEq(free.balanceOf(alice), SUPPLY / 2);
    }

    /// @dev The launch block is the creator's alone; the cap is everyone's, the creator included.
    ///      First dibs, not the whole open.
    function test_the_creator_gets_the_launch_block_not_an_exemption_from_the_cap() public {
        uint256 cap = (SUPPLY * 500) / 10_000;
        vm.prank(pool);
        token.transfer(creator, cap);
        assertEq(token.balanceOf(creator), cap);

        vm.prank(pool);
        vm.expectRevert(HoodLaunchToken.HoldsTooMuch.selector);
        token.transfer(creator, 1);
    }
}
