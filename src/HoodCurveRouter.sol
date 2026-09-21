// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import {IHoodCurve} from "./interfaces/IHoodCurve.sol";
import {IUniversalRouter} from "./interfaces/IExternal.sol";

interface ICurveRegistry {
    function tokenOfCurve(address curve) external view returns (address);
}

/// @title HoodCurveRouter
/// @notice One click from native ETH into any ERC-20 quoted bonding curve.
/// @dev The caller supplies a UniversalRouter route. This contract does not trust its quoted output:
///      it measures the quote token received, enforces a floor, then spends that exact amount on the
///      curve. A route can therefore be one hop or many without this contract knowing the DEX path.
contract HoodCurveRouter is ReentrancyGuard {
    using SafeERC20 for IERC20;

    ICurveRegistry public immutable factory;
    IUniversalRouter public immutable universalRouter;

    event BoughtWithNative(
        address indexed buyer,
        address indexed curve,
        address indexed quoteToken,
        uint256 nativeIn,
        uint256 quoteIn,
        uint256 tokensOut
    );

    error UnknownCurve();
    error NativeCurve();
    error NoQuoteReceived();
    error TooLittleQuote();
    error ZeroAddress();
    error NativeRefundFailed();
    error RouterCallFailed();

    constructor(address factory_, address universalRouter_) {
        if (factory_ == address(0) || universalRouter_ == address(0)) revert ZeroAddress();
        factory = ICurveRegistry(factory_);
        universalRouter = IUniversalRouter(universalRouter_);
    }

    receive() external payable {}

    function buyWithNative(
        address curve,
        uint256 minQuoteOut,
        uint256 minTokensOut,
        address to,
        bytes calldata commands,
        bytes[] calldata inputs,
        uint256 deadline
    ) external payable nonReentrant returns (uint256 tokensOut, uint256 quoteIn) {
        (address quote, uint256 quoteBefore, uint256 nativeBefore) = _beforeSwap(curve, to);
        universalRouter.execute{value: msg.value}(commands, inputs, deadline);
        return _buyReceivedQuote(curve, quote, quoteBefore, nativeBefore, minQuoteOut, minTokensOut, to);
    }

    /// @notice Same atomic operation, accepting the complete calldata produced by a route service.
    /// @dev The route must name this contract as its swapper/recipient. Keeping the DEX calldata
    ///      opaque lets the service select V2, V3, V4, or a multi-hop path without redeploying us.
    function buyWithNativeCalldata(
        address curve,
        uint256 minQuoteOut,
        uint256 minTokensOut,
        address to,
        bytes calldata routerCalldata
    ) external payable nonReentrant returns (uint256 tokensOut, uint256 quoteIn) {
        (address quote, uint256 quoteBefore, uint256 nativeBefore) = _beforeSwap(curve, to);
        (bool ok, bytes memory reason) = address(universalRouter).call{value: msg.value}(routerCalldata);
        if (!ok) {
            if (reason.length == 0) revert RouterCallFailed();
            assembly ("memory-safe") {
                revert(add(reason, 0x20), mload(reason))
            }
        }
        return _buyReceivedQuote(curve, quote, quoteBefore, nativeBefore, minQuoteOut, minTokensOut, to);
    }

    function _beforeSwap(address curve, address to)
        private
        view
        returns (address quote, uint256 quoteBefore, uint256 nativeBefore)
    {
        if (factory.tokenOfCurve(curve) == address(0)) revert UnknownCurve();
        quote = IHoodCurve(curve).pairToken();
        if (quote == address(0)) revert NativeCurve();
        if (to == address(0)) revert ZeroAddress();
        nativeBefore = address(this).balance - msg.value;
        quoteBefore = IERC20(quote).balanceOf(address(this));
    }

    function _buyReceivedQuote(
        address curve,
        address quote,
        uint256 quoteBefore,
        uint256 nativeBefore,
        uint256 minQuoteOut,
        uint256 minTokensOut,
        address to
    ) private returns (uint256 tokensOut, uint256 quoteIn) {
        quoteIn = IERC20(quote).balanceOf(address(this)) - quoteBefore;
        if (quoteIn == 0) revert NoQuoteReceived();
        if (quoteIn < minQuoteOut) revert TooLittleQuote();

        IERC20(quote).forceApprove(curve, quoteIn);
        tokensOut = IHoodCurve(curve).buy(quoteIn, minTokensOut, to);
        IERC20(quote).forceApprove(curve, 0);

        // A sold-out curve can return part of the quote. It goes back to the buyer, never stays in
        // this router where a later arbitrary DEX route could see it.
        uint256 quoteLeft = IERC20(quote).balanceOf(address(this)) - quoteBefore;
        if (quoteLeft != 0) IERC20(quote).safeTransfer(msg.sender, quoteLeft);

        uint256 nativeLeft = address(this).balance - nativeBefore;
        if (nativeLeft != 0) {
            (bool ok,) = msg.sender.call{value: nativeLeft}("");
            if (!ok) revert NativeRefundFailed();
        }

        emit BoughtWithNative(msg.sender, curve, quote, msg.value, quoteIn - quoteLeft, tokensOut);
    }
}
