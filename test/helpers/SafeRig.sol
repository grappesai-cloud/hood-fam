// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";

import {ISafe, ISafeProxyFactory, SafeDeployments, SafeLib} from "../../script/safe/Safe.sol";

/// @notice A real Safe v1.4.1, without an RPC: the canonical runtime code, read from 4663 and pinned
///         in `test/fixtures/safe-1.4.1/`, etched at its canonical addresses. On a fork the real
///         contracts are already there and nothing is etched.
abstract contract SafeRig is Test {
    function _installSafe() internal {
        _etch(SafeDeployments.SAFE_L2, "SafeL2");
        _etch(SafeDeployments.PROXY_FACTORY, "SafeProxyFactory");
        _etch(SafeDeployments.FALLBACK_HANDLER, "CompatibilityFallbackHandler");
        _etch(SafeDeployments.MULTI_SEND_CALL_ONLY, "MultiSendCallOnly");
        assertTrue(SafeDeployments.canonical(), "fixtures drifted from the canonical Safe code");
    }

    function _etch(address at, string memory name) private {
        if (at.code.length != 0) return;
        vm.etch(at, vm.parseBytes(vm.readFile(string.concat("test/fixtures/safe-1.4.1/", name, ".hex"))));
    }

    /// @notice A Safe of `n` fresh signers needing `threshold` of them. Keys come back sorted by
    ///         signer address, which is the order Safe wants signatures in.
    function _newSafe(string memory label, uint256 n, uint256 threshold)
        internal
        returns (ISafe safe, uint256[] memory keys)
    {
        keys = new uint256[](n);
        address[] memory owners = new address[](n);
        for (uint256 i; i < n; ++i) {
            (owners[i], keys[i]) = makeAddrAndKey(string.concat(label, "-signer-", vm.toString(i)));
        }
        for (uint256 i = 1; i < n; ++i) {
            for (uint256 j = i; j > 0 && owners[j - 1] > owners[j]; --j) {
                (owners[j - 1], owners[j]) = (owners[j], owners[j - 1]);
                (keys[j - 1], keys[j]) = (keys[j], keys[j - 1]);
            }
        }
        address predicted = SafeLib.predict(owners, threshold, 0);
        safe = ISafe(
            ISafeProxyFactory(SafeDeployments.PROXY_FACTORY).createProxyWithNonce(
                SafeDeployments.SAFE_L2, SafeLib.initializer(owners, threshold), 0
            )
        );
        assertEq(address(safe), predicted, "Safe landed somewhere other than predicted");
        vm.label(address(safe), label);
    }

    /// @notice The first `count` of `keys`, still sorted.
    function _first(uint256[] memory keys, uint256 count) internal pure returns (uint256[] memory out) {
        out = new uint256[](count);
        for (uint256 i; i < count; ++i) out[i] = keys[i];
    }

    /// @notice Signs and executes one Safe transaction. Anybody may execute a transaction that carries
    ///         enough signatures, so the executor here is a stranger, never a signer.
    function _exec(ISafe safe, address to, uint256 value, bytes memory data, uint8 operation, uint256[] memory keys)
        internal
        returns (bool)
    {
        bytes memory signatures = _signatures(safe, to, value, data, operation, keys);
        vm.prank(makeAddr("executor"));
        return safe.execTransaction(to, value, data, operation, 0, 0, 0, address(0), payable(address(0)), signatures);
    }

    /// @notice Signatures from `keys` over the Safe transaction at the Safe's current nonce, with
    ///         no gas refund, which is what an owner signs in the Safe app.
    function _signatures(ISafe safe, address to, uint256 value, bytes memory data, uint8 operation, uint256[] memory keys)
        internal
        view
        returns (bytes memory signatures)
    {
        bytes32 h = safe.getTransactionHash(to, value, data, operation, 0, 0, 0, address(0), address(0), safe.nonce());
        for (uint256 i; i < keys.length; ++i) {
            (uint8 v, bytes32 r, bytes32 s) = vm.sign(keys[i], h);
            signatures = abi.encodePacked(signatures, r, s, v);
        }
    }

    function _call(ISafe safe, address to, uint256 value, bytes memory data, uint256[] memory keys) internal {
        assertTrue(_exec(safe, to, value, data, SafeDeployments.CALL, keys), "Safe call failed");
    }

    /// @notice Several calls as one Safe transaction, through MultiSendCallOnly. All or nothing.
    function _batch(ISafe safe, SafeLib.Call[] memory calls, uint256[] memory keys) internal {
        assertTrue(
            _exec(safe, SafeDeployments.MULTI_SEND_CALL_ONLY, 0, SafeLib.multiSend(calls), SafeDeployments.DELEGATECALL, keys),
            "Safe batch failed"
        );
    }
}
