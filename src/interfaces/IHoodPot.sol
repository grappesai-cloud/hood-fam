// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @notice A launch's pot: the per-share accumulator that pays that token's holders in the
///         token's quote. One per launch. Direct launches use their revenue splitter as the
///         pot; curve launches get a HoodPot from the factory.
/// @dev Same payment convention as the Bag: native when `asset() == address(0)` with
///      `msg.value == amount`, otherwise an approved ERC-20 that the pot pulls.
interface IHoodPot {
    function token() external view returns (address);
    function asset() external view returns (address);

    /// @notice Books `amount` for every eligible holder, pro rata to balance. `reason` is one of
    ///         BagReasons, `payer` is who the money came from (the sniper, the creator, the Bag).
    function depositForHolders(uint256 amount, bytes32 reason, address payer) external payable;

    /// @notice What `account` can take right now.
    function pending(address account) external view returns (uint256);
    /// @notice Permissionless, always pays `account` itself.
    function claim(address account) external returns (uint256 amount);
    /// @notice Pays every account whose pending amount is at least `floor`. Permissionless: it can
    ///         only ever pay the holders themselves. Returns what was paid and to how many.
    function pushMany(address[] calldata accounts, uint256 floor) external returns (uint256 paid, uint256 count);

    /// @notice Everything ever booked for holders, and everything ever paid out.
    function totalDeposited() external view returns (uint256);
    function totalPaid() external view returns (uint256);

    event HoldersPaid(bytes32 indexed reason, address indexed payer, uint256 amount, uint256 eligibleSupply);
    event Pushed(address indexed account, uint256 amount);
}
