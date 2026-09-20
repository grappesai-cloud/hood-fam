// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Permit.sol";

/// @title HoodToken
/// @notice The token a launch prints. Fixed supply, no owner, no mint function, ever.
/// @dev Omnichain expansion is deliberately NOT a mint role on this contract. A mint role is a
///      supply backdoor: whoever holds the bridge can print. Instead the token travels through a
///      LayerZero OFT lock-box adapter deployed later next to it: the canonical supply is locked
///      on this chain and the remote OFT mints against it. Nothing here has to change for that,
///      and nothing here can inflate the supply in the meantime.
contract HoodToken is ERC20, ERC20Permit {
    /// @notice The launchpad that printed this token.
    address public immutable factory;
    /// @notice Artwork uri, as published at launch.
    string public image;
    /// @notice Free-text description, as published at launch.
    string public description;

    constructor(
        string memory name_,
        string memory symbol_,
        string memory image_,
        string memory description_,
        uint256 supply,
        address mintTo
    ) ERC20(name_, symbol_) ERC20Permit(name_) {
        factory = msg.sender;
        image = image_;
        description = description_;
        _mint(mintTo, supply);
    }

    /// @notice Destroys `amount` from the caller. Used by the buyback leg of a fee split.
    function burn(uint256 amount) external {
        _burn(msg.sender, amount);
    }
}
