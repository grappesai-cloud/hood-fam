// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Script, console} from "forge-std/Script.sol";

import {ISafe, ISafeProxyFactory, SafeDeployments, SafeLib} from "./safe/Safe.sol";

/// @notice Creates the Safe that owns hood.fam and receives its fees, on Robinhood Chain 4663.
/// @dev Run it BEFORE `Deploy.s.sol`, then deploy with OWNER and TREASURY both set to the address it
///      prints. A curve launch pins its treasury at launch, so a treasury moved later only reaches
///      launches made after the move; the Safe has to be there from the first block.
///
///      Idempotent: the address is known before anything is sent, so a second run with the same
///      owners, threshold and salt finds the Safe already there, checks it, and sends nothing.
///
///      SAFE_OWNERS=0xA,0xB,0xC SAFE_THRESHOLD=2 [SAFE_SALT=0] \
///      forge script script/DeploySafe.s.sol --rpc-url robinhood --broadcast
///
///      Refuses a threshold under 2 (SAFE_ALLOW_SINGLE_SIGNER=true overrides, for a rehearsal), and
///      refuses a deployer key that is also an owner: the deployer is a hot key used once, and a
///      signer of the protocol's Safe is neither.
contract DeploySafe is Script {
    function run() external returns (address safe) {
        uint256 pk = vm.envUint("PRIVATE_KEY");
        address[] memory owners = vm.envAddress("SAFE_OWNERS", ",");
        uint256 threshold = vm.envUint("SAFE_THRESHOLD");
        uint256 saltNonce = vm.envOr("SAFE_SALT", uint256(0));
        bool allowSingle = vm.envOr("SAFE_ALLOW_SINGLE_SIGNER", false);
        address deployer = vm.addr(pk);

        _check(owners, threshold, deployer, allowSingle);
        // The Safe contracts are not ours, so this refuses to build on anything that is not exactly
        // them: the code hashes of Safe v1.4.1 as deployed on 4663 and on Base.
        require(SafeDeployments.canonical(), "the Safe contracts at the canonical addresses are not v1.4.1");

        safe = SafeLib.predict(owners, threshold, saltNonce);
        if (safe.code.length == 0) {
            vm.startBroadcast(pk);
            address created = ISafeProxyFactory(SafeDeployments.PROXY_FACTORY).createProxyWithNonce(
                SafeDeployments.SAFE_L2, SafeLib.initializer(owners, threshold), saltNonce
            );
            vm.stopBroadcast();
            require(created == safe, "created somewhere other than predicted");
            console.log("created   ", safe);
        } else {
            console.log("exists    ", safe);
        }

        // Whatever is at the address has to be the Safe asked for, whether it was just created or
        // found: the same owners in any order, the same threshold.
        ISafe s = ISafe(safe);
        require(s.getThreshold() == threshold, "threshold on chain differs");
        address[] memory onChain = s.getOwners();
        require(onChain.length == owners.length, "owner count on chain differs");
        for (uint256 i; i < owners.length; ++i) {
            require(s.isOwner(owners[i]), "an owner is missing on chain");
        }

        console.log("threshold ", threshold, "of", owners.length);
        console.log("version   ", s.VERSION());
        console.log("next: deploy with OWNER=TREASURY=this address, then accept ownership from the Safe");
        console.log("open      ", string.concat("https://app.safe.global/home?safe=robinhood:", vm.toString(safe)));
    }

    function _check(address[] memory owners, uint256 threshold, address deployer, bool allowSingle) internal pure {
        require(owners.length > 0, "SAFE_OWNERS is empty");
        require(threshold > 0 && threshold <= owners.length, "SAFE_THRESHOLD must be between 1 and the owner count");
        require(threshold >= 2 || allowSingle, "a 1-of-N Safe is one key with extra steps; set SAFE_ALLOW_SINGLE_SIGNER=true to mean it");
        for (uint256 i; i < owners.length; ++i) {
            require(owners[i] != address(0), "zero address in SAFE_OWNERS");
            require(owners[i] != deployer, "the deployer key must not be a signer of the protocol Safe");
            for (uint256 j = i + 1; j < owners.length; ++j) {
                require(owners[i] != owners[j], "duplicate owner in SAFE_OWNERS");
            }
        }
    }
}
