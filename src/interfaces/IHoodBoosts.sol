// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @notice Hourly boost slots on the board, bought in native currency. All of it goes to the
///         house through the Bag. A slot is an (hour, index) pair; first come, first served; a
///         token can hold one slot per hour; the current hour and the next one are on sale.
interface IHoodBoosts {
    function SLOTS() external view returns (uint8);
    function slotPrice() external view returns (uint256);
    function epoch() external view returns (uint64);

    /// @notice Pays `slotPrice` for `slot` of `hourEpoch` for a registered launch.
    function buy(address token, uint64 hourEpoch, uint8 slot) external payable;

    /// @notice The tokens in every slot of an hour, address(0) where the slot is empty.
    function boosted(uint64 hourEpoch) external view returns (address[] memory);
    function slotOf(uint64 hourEpoch, uint8 slot) external view returns (address token, address buyer);

    event BoostBought(address indexed token, address indexed buyer, uint64 indexed hourEpoch, uint8 slot, uint256 paid);
    event SlotPriceSet(uint256 price);
}
