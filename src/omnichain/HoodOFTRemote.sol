// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {OFT} from "@layerzerolabs/oft-evm/contracts/OFT.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

/// @title HoodOFTRemote
/// @notice The far end of a hood.fam token on another chain. Mints on arrival, burns on departure.
/// @dev Deployed on every chain the token travels to, never on 4663. Its supply is a mirror of what
///      the adapter has locked on 4663, so it is not new supply: it cannot exist unless the
///      canonical token is sitting in the lock box back home.
contract HoodOFTRemote is OFT {
    constructor(string memory name_, string memory symbol_, address lzEndpoint, address owner_)
        OFT(name_, symbol_, lzEndpoint, owner_)
        Ownable(owner_)
    {}
}
