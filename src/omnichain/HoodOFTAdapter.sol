// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {OFTAdapter} from "@layerzerolabs/oft-evm/contracts/OFTAdapter.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

/// @title HoodOFTAdapter
/// @notice The lock box that lets a hood.fam token travel. It lives on 4663, next to the token.
/// @dev The token itself has no mint function and never will: a bridge that can mint is a supply
///      backdoor, and the first thing that goes wrong with one is that it prints. Instead the
///      canonical supply is LOCKED in this contract when it leaves, and released when it comes
///      back. On every remote chain a `HoodOFTRemote` mints against what is locked here, so the
///      total across all chains is always the supply printed at launch, whatever happens to a
///      remote deployment.
///
///      Exactly one adapter may exist per token. Two would each believe they hold the canonical
///      supply, and the mesh would be able to print. `HoodBridgeFactory` enforces the one.
contract HoodOFTAdapter is OFTAdapter {
    constructor(address token_, address lzEndpoint, address owner_)
        OFTAdapter(token_, lzEndpoint, owner_)
        Ownable(owner_)
    {}
}
