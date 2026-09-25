// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Permit.sol";

/// @dev The one call the token makes into its pot. Kept local rather than on IHoodPot because the
///      pot's public surface is for payers and holders; this is the accountant's private line.
interface IHoodPotSync {
    function syncBalances(address from, address to, uint256 fromBalance, uint256 toBalance) external;
}

/// @title HoodToken
/// @notice The token a launch prints. Fixed supply, no owner, no mint function, ever.
/// @dev Omnichain expansion is deliberately NOT a mint role on this contract. A mint role is a
///      supply backdoor: whoever holds the bridge can print. Instead the token travels through a
///      LayerZero OFT lock-box adapter deployed later next to it: the canonical supply is locked
///      on this chain and the remote OFT mints against it. Nothing here has to change for that,
///      and nothing here can inflate the supply in the meantime.
///
///      The pot. Holders are paid out of a per-share accumulator (the launch's HoodPot) that has
///      to know when balances move, so `_update` tells it. The token and the pot need each other's
///      address and neither can be predicted from the other (the pot's constructor takes the token,
///      and a token that took the pot would be a circle), so the factory prints the token, prints
///      the pot, and names the pot here once, before the supply has moved anywhere. The call out is
///      bookkeeping in a contract with no owner; it is never skipped once the pot is set.
contract HoodToken is ERC20, ERC20Permit {
    /// @notice The launchpad that printed this token.
    address public immutable factory;
    /// @notice The launch's pot, set once by the factory right after the mint. Zero until then.
    address public pot;
    /// @notice Artwork uri, as published at launch.
    string public image;
    /// @notice Free-text description, as published at launch.
    string public description;

    event PotSet(address indexed pot);

    error NotFactory();
    error PotAlreadySet();
    error ZeroAddress();

    constructor(
        string memory name_,
        string memory symbol_,
        string memory image_,
        string memory description_,
        uint256 supply,
        address mintTo,
        address factory_
    ) ERC20(name_, symbol_) ERC20Permit(name_) {
        factory = factory_;
        image = image_;
        description = description_;
        _mint(mintTo, supply);
    }

    /// @notice Names the pot. Once, factory only, and the factory does it in the launch
    ///         transaction before the supply leaves its hands, so the pot sees every balance.
    function setPot(address pot_) external {
        if (msg.sender != factory) revert NotFactory();
        if (pot != address(0)) revert PotAlreadySet();
        if (pot_ == address(0)) revert ZeroAddress();
        pot = pot_;
        emit PotSet(pot_);
    }

    /// @notice Destroys `amount` from the caller. Used by the buyback leg of a fee split.
    function burn(uint256 amount) external {
        _burn(msg.sender, amount);
    }

    function _update(address from, address to, uint256 value) internal override {
        super._update(from, to, value);
        address p = pot;
        if (p != address(0)) {
            IHoodPotSync(p).syncBalances(
                from, to, from == address(0) ? 0 : balanceOf(from), to == address(0) ? 0 : balanceOf(to)
            );
        }
    }
}
