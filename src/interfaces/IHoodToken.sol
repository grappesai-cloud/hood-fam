// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

interface IHoodToken is IERC20 {
    function burn(uint256 amount) external;

    /// @notice The launch's pot (IHoodPot); zero only between the mint and the factory naming it.
    function pot() external view returns (address);
    /// @notice Names the pot. Factory only, once.
    function setPot(address pot_) external;
}
