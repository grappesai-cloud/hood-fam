// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {StdInvariant} from "forge-std/StdInvariant.sol";

import {HoodRevenueSplitter} from "../../src/direct/HoodRevenueSplitter.sol";
import {Allocations} from "../../src/direct/DirectTypes.sol";

/// @notice Drives one native-quoted splitter through everything that moves its money: tax arriving,
///         sweeps, holder balances shifting (which the token would report), and every claim road.
///         The handler is at once the portal, the token and the buyback module, so it can exercise
///         each gated entry point; that is a test rig, never the real wiring.
contract SplitterHandler is Test {
    HoodRevenueSplitter public splitter;
    address public constant TOKEN = address(0x7016E0);

    address[] public holders;
    mapping(address => uint256) public ledger; // the balance the token would report for each holder
    uint256 public totalArrived; // native sent in as "tax", ever
    uint256 public totalOut; // native paid out of every road, ever

    function setUp(HoodRevenueSplitter s) external {
        splitter = s;
        for (uint256 i; i < 4; ++i) holders.push(address(uint160(0xD0E + i)));
    }

    receive() external payable {}

    // the buyback module receives here
    fallback() external payable {}

    function _holder(uint256 s) internal view returns (address) {
        return holders[s % holders.length];
    }

    /// Tax lands: a plain native transfer, exactly how a swap tax or a harvest arrives.
    function arrive(uint256 amount) public {
        amount = bound(amount, 0, 100 ether);
        if (amount == 0) return;
        vm.deal(address(this), amount);
        (bool ok,) = address(splitter).call{value: amount}("");
        if (ok) totalArrived += amount;
    }

    function sweep() public {
        splitter.sweep();
    }

    /// A holder balance moves, and the token tells the splitter. The ledger the handler keeps is the
    /// truth the token would report; eligibleSupply must track it.
    function moveShare(uint256 fromSeed, uint256 toSeed, uint256 amount) public {
        address from = _holder(fromSeed);
        address to = _holder(toSeed);
        if (from == to) return;
        amount = bound(amount, 0, ledger[from] == 0 ? 1e24 : ledger[from]);
        if (amount == 0) {
            // model a mint to `to` when nobody holds anything yet, so shares can come into being
            amount = bound(amount, 1, 1e24);
            ledger[to] += amount;
            vm.prank(TOKEN);
            splitter.syncBalances(address(0), to, 0, ledger[to]);
            return;
        }
        ledger[from] -= amount;
        ledger[to] += amount;
        vm.prank(TOKEN);
        splitter.syncBalances(from, to, ledger[from], ledger[to]);
    }

    function claimCreator() public {
        try splitter.claim(address(this)) returns (uint256 a) { totalOut += a; } catch {}
    }

    function releaseBuyback() public {
        try splitter.releaseBuyback() returns (uint256 a) { totalOut += a; } catch {}
    }

    function pushLiquidity() public {
        try splitter.pushLiquidity() returns (uint256 a) { totalOut += a; } catch {}
    }

    function claimProtocol() public {
        try splitter.claimProtocol() returns (uint256 a) { totalOut += a; } catch {}
    }

    function claimDividends(uint256 holderSeed) public {
        address h = _holder(holderSeed);
        try splitter.claimDividends(h) returns (uint256 a) { totalOut += a; } catch {}
    }

    function holderCount() external view returns (uint256) {
        return holders.length;
    }

    function holderAt(uint256 i) external view returns (address) {
        return holders[i];
    }
}

contract SplitterSolvencyInvariant is StdInvariant, Test {
    HoodRevenueSplitter internal splitter;
    SplitterHandler internal handler;

    address internal treasury = makeAddr("treasury");
    address internal locker = makeAddr("locker");

    function setUp() public {
        handler = new SplitterHandler();
        // portal = buybackModule = the handler, so it can drive every gated call; token is the
        // handler's fixed TOKEN address; quote is native.
        splitter = new HoodRevenueSplitter(
            address(handler), treasury, address(handler), handler.TOKEN(), address(0)
        );
        // portal wires it
        vm.prank(address(handler));
        splitter.initialize(address(handler), locker, Allocations(2_500, 2_500, 4_000, 1_000));
        handler.setUp(splitter);

        targetContract(address(handler));
        bytes4[] memory sel = new bytes4[](8);
        sel[0] = SplitterHandler.arrive.selector;
        sel[1] = SplitterHandler.sweep.selector;
        sel[2] = SplitterHandler.moveShare.selector;
        sel[3] = SplitterHandler.claimCreator.selector;
        sel[4] = SplitterHandler.releaseBuyback.selector;
        sel[5] = SplitterHandler.pushLiquidity.selector;
        sel[6] = SplitterHandler.claimProtocol.selector;
        sel[7] = SplitterHandler.claimDividends.selector;
        targetSelector(FuzzSelector({addr: address(handler), selectors: sel}));
    }

    function _owed() internal view returns (uint256) {
        return splitter.creatorClaimable() + splitter.buybackPot() + splitter.liquidityPot()
            + splitter.protocolClaimable() + splitter.dividendsHeld();
    }

    /// @notice The splitter is never insolvent: the native it holds always covers every road's
    ///         booked balance at once. Everyone could claim in any order and be paid.
    function invariant_balanceCoversEveryRoad() public view {
        assertGe(address(splitter).balance, _owed(), "splitter cannot cover what it owes");
    }

    /// @notice `accounted` is exactly the sum of the five roads. This is the books balancing: money
    ///         is booked into exactly one road and leaves from exactly one, so the ledger and the
    ///         buckets can never drift.
    function invariant_accountedEqualsRoads() public view {
        assertEq(splitter.accounted(), _owed(), "accounted drifted from the sum of the roads");
    }

    /// @notice The dividend base tracks the holders exactly: eligibleSupply is the sum of the
    ///         balances the token has reported, never more, never less. A drift here would pay
    ///         dividends on shares that do not exist or starve shares that do.
    function invariant_eligibleSupplyTracksHolders() public view {
        uint256 sum;
        uint256 n = handler.holderCount();
        for (uint256 i; i < n; ++i) {
            sum += splitter.trackedBalance(handler.holderAt(i));
        }
        assertEq(splitter.eligibleSupply(), sum, "eligibleSupply drifted from tracked holders");
    }

    /// @notice Nothing arrives and vanishes: every wei the splitter ever received is either still
    ///         held for a road or has been paid out. (Native accounting is exact, so this is to the
    ///         wei.)
    function invariant_nothingLeaks() public view {
        assertEq(handler.totalArrived(), address(splitter).balance + handler.totalOut(), "wei leaked");
    }
}
