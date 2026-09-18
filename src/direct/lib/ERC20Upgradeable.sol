// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";

/// @title ERC20Upgradeable
/// @notice The smallest ERC-20 that can live behind an EIP-1167 clone: name and symbol are set by
///         an initializer instead of a constructor, because a clone has no constructor.
/// @dev Same shape as OpenZeppelin v5, including the single `_update` hook that everything else
///      routes through, so a reader who knows that codebase knows this one.
abstract contract ERC20Upgradeable is IERC20, IERC20Metadata {
    mapping(address account => uint256) private _balances;
    mapping(address account => mapping(address spender => uint256)) private _allowances;
    uint256 private _totalSupply;
    string private _name;
    string private _symbol;

    error ERC20InsufficientBalance(address sender, uint256 balance, uint256 needed);
    error ERC20InsufficientAllowance(address spender, uint256 allowance, uint256 needed);
    error ERC20InvalidReceiver(address receiver);
    error ERC20InvalidSpender(address spender);

    function __ERC20_init(string memory name_, string memory symbol_) internal {
        _name = name_;
        _symbol = symbol_;
    }

    function name() public view returns (string memory) {
        return _name;
    }

    function symbol() public view returns (string memory) {
        return _symbol;
    }

    function decimals() public pure returns (uint8) {
        return 18;
    }

    function totalSupply() public view returns (uint256) {
        return _totalSupply;
    }

    function balanceOf(address account) public view returns (uint256) {
        return _balances[account];
    }

    function allowance(address owner, address spender) public view returns (uint256) {
        return _allowances[owner][spender];
    }

    function approve(address spender, uint256 value) public returns (bool) {
        if (spender == address(0)) revert ERC20InvalidSpender(spender);
        _allowances[msg.sender][spender] = value;
        emit Approval(msg.sender, spender, value);
        return true;
    }

    /// @dev The zero check lives here rather than in `_update`, which is also the burn path. Without
    ///      it a transfer to the zero address is a silent burn: the supply drops, the sender's
    ///      balance is gone and nothing says so. OpenZeppelin refuses it, so this does too.
    function transfer(address to, uint256 value) public returns (bool) {
        if (to == address(0)) revert ERC20InvalidReceiver(to);
        _update(msg.sender, to, value);
        return true;
    }

    function transferFrom(address from, address to, uint256 value) public returns (bool) {
        if (to == address(0)) revert ERC20InvalidReceiver(to);
        uint256 current = _allowances[from][msg.sender];
        if (current != type(uint256).max) {
            if (current < value) revert ERC20InsufficientAllowance(msg.sender, current, value);
            unchecked {
                _allowances[from][msg.sender] = current - value;
            }
        }
        _update(from, to, value);
        return true;
    }

    function _mint(address to, uint256 value) internal {
        if (to == address(0)) revert ERC20InvalidReceiver(to);
        _update(address(0), to, value);
    }

    function _burn(address from, uint256 value) internal {
        _update(from, address(0), value);
    }

    function _update(address from, address to, uint256 value) internal virtual {
        if (from == address(0)) {
            _totalSupply += value;
        } else {
            uint256 balance = _balances[from];
            if (balance < value) revert ERC20InsufficientBalance(from, balance, value);
            unchecked {
                _balances[from] = balance - value;
            }
        }

        if (to == address(0)) {
            unchecked {
                _totalSupply -= value;
            }
        } else {
            unchecked {
                _balances[to] += value;
            }
        }
        emit Transfer(from, to, value);
    }
}
