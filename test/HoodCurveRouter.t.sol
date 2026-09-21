// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {BaseTest} from "./Base.t.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {HoodCurveRouter} from "../src/HoodCurveRouter.sol";
import {HoodCurve} from "../src/HoodCurve.sol";
import {CurveConfig, LaunchParams} from "../src/HoodTypes.sol";
import {MockQuote} from "./mocks/Mocks.sol";

contract MockUniversalRouter {
    MockQuote public immutable quote;
    uint256 public quoteOut;

    constructor(MockQuote quote_) {
        quote = quote_;
    }

    function setQuoteOut(uint256 amount) external {
        quoteOut = amount;
    }

    function execute(bytes calldata, bytes[] calldata, uint256) external payable {
        quote.mint(msg.sender, quoteOut);
    }

    fallback() external payable {
        quote.mint(msg.sender, quoteOut);
    }
}

contract HoodCurveRouterTest is BaseTest {
    function _customCurve(MockQuote quote) internal returns (address token, address curve) {
        CurveConfig memory c = _config();
        c.pairToken = address(quote);
        c.startCap = 5_000e9;
        c.graduationCap = 50_000e9;
        LaunchParams memory p = _params(_toCreator());
        p.pairToken = address(quote);
        p.symbol = "ROUTED";
        p.salt = bytes32(uint256(188));
        vm.prank(creator);
        (token, curve,) = factory.launchCustom{value: LAUNCH_FEE}(p, c);
    }

    function test_native_swap_and_curve_buy_are_atomic() public {
        MockQuote quote = new MockQuote("OG", 9);
        (address token, address curve) = _customCurve(quote);
        MockUniversalRouter swapper = new MockUniversalRouter(quote);
        HoodCurveRouter curveRouter = new HoodCurveRouter(address(factory), address(swapper));
        swapper.setQuoteOut(1_000e9);

        bytes[] memory inputs = new bytes[](0);
        uint256 ethBefore = alice.balance;
        vm.prank(alice);
        (uint256 bought, uint256 quoteIn) =
            curveRouter.buyWithNative{value: 1 ether}(curve, 999e9, 1, alice, bytes(""), inputs, block.timestamp);

        assertEq(quoteIn, 1_000e9);
        assertGt(bought, 0);
        assertEq(IERC20(token).balanceOf(alice), bought);
        assertGt(HoodCurve(payable(curve)).reserve(), 0);
        assertEq(alice.balance, ethBefore - 1 ether, "the swap consumed exactly the native input");
        assertEq(quote.balanceOf(address(curveRouter)), 0, "no quote is left for a later route");
    }

    function test_router_refuses_a_curve_outside_the_factory() public {
        MockQuote quote = new MockQuote("OG", 9);
        MockUniversalRouter swapper = new MockUniversalRouter(quote);
        HoodCurveRouter curveRouter = new HoodCurveRouter(address(factory), address(swapper));
        bytes[] memory inputs = new bytes[](0);
        vm.expectRevert(HoodCurveRouter.UnknownCurve.selector);
        curveRouter.buyWithNative(address(0x1234), 0, 0, alice, bytes(""), inputs, block.timestamp);
    }

    function test_complete_router_calldata_is_supported() public {
        MockQuote quote = new MockQuote("OG", 9);
        (address token, address curve) = _customCurve(quote);
        MockUniversalRouter swapper = new MockUniversalRouter(quote);
        HoodCurveRouter curveRouter = new HoodCurveRouter(address(factory), address(swapper));
        swapper.setQuoteOut(500e9);

        vm.prank(alice);
        (uint256 bought, uint256 quoteIn) =
            curveRouter.buyWithNativeCalldata{value: 0.2 ether}(curve, 490e9, 1, alice, hex"12345678");

        assertEq(quoteIn, 500e9);
        assertEq(IERC20(token).balanceOf(alice), bought);
        assertEq(quote.balanceOf(address(curveRouter)), 0);
    }
}
