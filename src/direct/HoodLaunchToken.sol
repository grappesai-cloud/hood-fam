// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {ERC20Upgradeable} from "./lib/ERC20Upgradeable.sol";
import {Socials} from "./DirectTypes.sol";

interface IDividends {
    function syncBalances(address from, address to, uint256 fromBalance, uint256 toBalance) external;
    function slashCreator() external;
    function creator() external view returns (address);
}

/// @title HoodLaunchToken
/// @notice The token a direct launch prints: fixed supply, no owner, no mint, no transfer tax.
/// @dev Deployed as an EIP-1167 clone, so printing one costs a fraction of deploying one.
///
///      Two things live in `_update` and nothing else does:
///
///      1. The creator cannot rug their fees. A transfer from the creator, or from whoever is the
///         current fee recipient, into the pool is a sell, and it moves whatever they had not
///         claimed from the splitter to the holders before the transfer proceeds. The call cannot
///         revert the transfer: a token that can be frozen by its own accountant is not a token.
///
///      2. Dividend accounting. Holders are paid from a per-share accumulator, which has to know
///         when balances move. Same rule: a plain bookkeeping write, never a veto.
///
///      There is no opening window here: the open is priced, not gated. The pool's hook charges
///      the opening tax every launch runs (SnipeSchedule), and anyone may buy and hold any amount.
contract HoodLaunchToken is ERC20Upgradeable {
    address public portal;
    address public creator;
    address public pool;
    address public dividends;

    string public logo;
    string public description;
    Socials internal _socials;

    uint64 public launchBlock;

    error AlreadyInitialized();
    error NotPortal();

    /// @dev The implementation behind the clones must never be initializable itself.
    constructor() {
        portal = address(1);
    }

    function initialize(
        string calldata name_,
        string calldata symbol_,
        string calldata logo_,
        string calldata description_,
        Socials calldata socials_,
        uint256 supply,
        address creator_
    ) external {
        if (portal != address(0)) revert AlreadyInitialized();
        portal = msg.sender;
        creator = creator_;
        logo = logo_;
        description = description_;
        _socials = socials_;
        launchBlock = uint64(block.number);

        __ERC20_init(name_, symbol_);
        _mint(msg.sender, supply);
    }

    /// @notice Called once by the portal, after the pool and the splitter exist.
    function setLaunchAddresses(address pool_, address dividends_) external {
        if (msg.sender != portal) revert NotPortal();
        if (pool != address(0)) revert AlreadyInitialized();
        pool = pool_;
        dividends = dividends_;
    }

    function socials() external view returns (Socials memory) {
        return _socials;
    }

    function liquidityPool() external view returns (address) {
        return pool;
    }

    function burn(uint256 amount) external {
        _burn(msg.sender, amount);
    }

    function _update(address from, address to, uint256 value) internal override {
        address d = dividends;
        if (d != address(0)) {
            if (to == pool && from != address(0)) _slashIfCreator(from, d);
            super._update(from, to, value);
            IDividends(d).syncBalances(from, to, from == address(0) ? 0 : balanceOf(from), to == address(0) ? 0 : balanceOf(to));
        } else {
            super._update(from, to, value);
        }
    }

    /// @dev A sell by the creator or by the current fee recipient. Both are asked because the
    ///      recipient can be a different wallet than the one that launched.
    function _slashIfCreator(address from, address d) internal {
        bool isCreator = from == creator;
        if (!isCreator) {
            try IDividends(d).creator() returns (address recipient) {
                isCreator = from == recipient;
            } catch {}
        }
        if (isCreator) {
            try IDividends(d).slashCreator() {} catch {}
        }
    }
}
