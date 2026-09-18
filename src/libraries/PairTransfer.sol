// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/// @title PairTransfer
/// @notice One code path for both kinds of pair asset: native (`address(0)`) and ERC-20.
library PairTransfer {
    using SafeERC20 for IERC20;

    error WrongValue();
    error FeeOnTransferPair();
    error NativeTransferFailed();

    /// @notice Takes `amount` of the pair asset from `from` into this contract.
    function pull(address pair, address from, uint256 amount, uint256 value) internal {
        if (pair == address(0)) {
            if (value != amount) revert WrongValue();
        } else {
            if (value != 0) revert WrongValue();
            uint256 before = IERC20(pair).balanceOf(address(this));
            IERC20(pair).safeTransferFrom(from, address(this), amount);
            // A pair asset that skims transfers would break the reserve accounting silently.
            if (IERC20(pair).balanceOf(address(this)) - before != amount) revert FeeOnTransferPair();
        }
    }

    /// @notice Sends `amount` of the pair asset to `to`.
    function push(address pair, address to, uint256 amount) internal {
        if (amount == 0) return;
        if (pair == address(0)) {
            (bool ok,) = to.call{value: amount}("");
            if (!ok) revert NativeTransferFailed();
        } else {
            IERC20(pair).safeTransfer(to, amount);
        }
    }

    /// @notice Sends `amount` to a contract that books it in the same call.
    /// @dev Native goes as value, ERC-20 goes as a transfer before the call, which is why every
    ///      receiver in this system takes the amount as an argument as well.
    function pushAndCall(address pair, address to, uint256 amount, bytes memory data) internal {
        if (pair == address(0)) {
            (bool ok,) = to.call{value: amount}(data);
            if (!ok) revert NativeTransferFailed();
        } else {
            IERC20(pair).safeTransfer(to, amount);
            (bool ok, bytes memory ret) = to.call(data);
            if (!ok) {
                assembly {
                    revert(add(ret, 0x20), mload(ret))
                }
            }
        }
    }

    function balance(address pair, address who) internal view returns (uint256) {
        return pair == address(0) ? who.balance : IERC20(pair).balanceOf(who);
    }
}
