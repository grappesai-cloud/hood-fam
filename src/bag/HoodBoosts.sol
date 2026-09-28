// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Launch} from "../HoodTypes.sol";
import {IHoodBoosts} from "../interfaces/IHoodBoosts.sol";
import {IHoodBag} from "../interfaces/IHoodBag.sol";
import {IHoodFactory} from "../interfaces/IHoodFactory.sol";

/// @title HoodBoosts
/// @notice Hourly boost slots on the board. A creator pays `slotPrice` in native currency for one
///         of SLOTS slots in the current or the next hour; all of it goes, through the Bag, to the
///         Payday of that same hour: the traders who show up while the coin is boosted are the
///         ones paid for it. First come, first served; one slot per token per hour.
/// @dev No privileged writer. The factory owner sets the price under a hard cap.
contract HoodBoosts is IHoodBoosts {
    struct Slot {
        address token;
        address buyer;
    }

    uint8 public constant SLOTS = 4;
    uint256 public constant MAX_SLOT_PRICE = 0.05 ether;

    address public immutable factory;
    IHoodBag public immutable bag;
    uint256 public slotPrice = 0.005 ether;

    mapping(uint64 hourEpoch => mapping(uint8 slot => Slot)) internal _slots;
    /// @notice Whether a token already holds a slot in an hour.
    mapping(uint64 hourEpoch => mapping(address token => bool)) public holdsSlot;

    error NotOwner();
    error PriceTooHigh();
    error WrongPrice();
    error UnknownToken();
    error BadHour();
    error BadSlot();
    error SlotTaken();
    error AlreadyBoosted();

    constructor(address factory_, address bag_) {
        factory = factory_;
        bag = IHoodBag(bag_);
    }

    /// @inheritdoc IHoodBoosts
    function epoch() public view returns (uint64) {
        return uint64(block.timestamp / 1 hours);
    }

    function setSlotPrice(uint256 price) external {
        if (msg.sender != IHoodFactory(factory).owner()) revert NotOwner();
        if (price > MAX_SLOT_PRICE) revert PriceTooHigh();
        slotPrice = price;
        emit SlotPriceSet(price);
    }

    /// @inheritdoc IHoodBoosts
    function buy(address token, uint64 hourEpoch, uint8 slot) external payable {
        if (msg.value != slotPrice) revert WrongPrice();
        Launch memory l = IHoodFactory(factory).getLaunch(token);
        if (!l.exists) revert UnknownToken();
        uint64 now_ = epoch();
        if (hourEpoch != now_ && hourEpoch != now_ + 1) revert BadHour();
        if (slot >= SLOTS) revert BadSlot();
        if (_slots[hourEpoch][slot].token != address(0)) revert SlotTaken();
        if (holdsSlot[hourEpoch][token]) revert AlreadyBoosted();

        _slots[hourEpoch][slot] = Slot({token: token, buyer: msg.sender});
        holdsSlot[hourEpoch][token] = true;
        bag.takeBoost{value: msg.value}(address(0), msg.value, token, hourEpoch);
        emit BoostBought(token, msg.sender, hourEpoch, slot, msg.value);
    }

    /// @inheritdoc IHoodBoosts
    function boosted(uint64 hourEpoch) external view returns (address[] memory tokens) {
        tokens = new address[](SLOTS);
        for (uint8 i; i < SLOTS; ++i) {
            tokens[i] = _slots[hourEpoch][i].token;
        }
    }

    /// @inheritdoc IHoodBoosts
    function slotOf(uint64 hourEpoch, uint8 slot) external view returns (address token, address buyer) {
        Slot memory s = _slots[hourEpoch][slot];
        return (s.token, s.buyer);
    }
}
