// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/// @title DirectPay
/// @notice Pays a contract that follows the Bag's convention: native goes as `msg.value`, an
///         ERC-20 is approved and the receiver pulls it inside the same call.
library DirectPay {
    using SafeERC20 for IERC20;

    /// @dev Reverts with the receiver's own reason, so a failing Bag or pot says why.
    function payWithCall(address asset, address to, uint256 amount, bytes memory data) internal {
        if (amount == 0) return;
        bool ok;
        bytes memory ret;
        if (asset == address(0)) {
            (ok, ret) = to.call{value: amount}(data);
        } else {
            IERC20(asset).forceApprove(to, amount);
            (ok, ret) = to.call(data);
        }
        if (!ok) {
            assembly {
                revert(add(ret, 0x20), mload(ret))
            }
        }
    }
}
