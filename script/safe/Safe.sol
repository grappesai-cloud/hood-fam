// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @notice The slice of Safe v1.4.1 hood.fam talks to, and where it lives on 4663.
/// @dev hood.fam does not ship a multisig. The protocol owner and the treasury are a Safe, built from
///      the canonical Safe v1.4.1 deployment that is already on Robinhood Chain: the same bytecode, at
///      the same addresses, as on every other chain Safe supports (checked byte for byte against
///      Base; the copies the tests run on are in `test/fixtures/safe-1.4.1/`). A multisig is the one
///      contract in this system that should be the most boring code on the chain, and a Safe is that.

interface ISafe {
    function setup(
        address[] calldata owners,
        uint256 threshold,
        address to,
        bytes calldata data,
        address fallbackHandler,
        address paymentToken,
        uint256 payment,
        address payable paymentReceiver
    ) external;

    function execTransaction(
        address to,
        uint256 value,
        bytes calldata data,
        uint8 operation,
        uint256 safeTxGas,
        uint256 baseGas,
        uint256 gasPrice,
        address gasToken,
        address payable refundReceiver,
        bytes memory signatures
    ) external payable returns (bool success);

    function getTransactionHash(
        address to,
        uint256 value,
        bytes calldata data,
        uint8 operation,
        uint256 safeTxGas,
        uint256 baseGas,
        uint256 gasPrice,
        address gasToken,
        address refundReceiver,
        uint256 nonce
    ) external view returns (bytes32);

    function nonce() external view returns (uint256);
    function getOwners() external view returns (address[] memory);
    function getThreshold() external view returns (uint256);
    function isOwner(address owner) external view returns (bool);
    function VERSION() external view returns (string memory);
}

interface ISafeProxyFactory {
    function createProxyWithNonce(address singleton, bytes memory initializer, uint256 saltNonce)
        external
        returns (address proxy);
    function proxyCreationCode() external view returns (bytes memory);
}

interface IMultiSendCallOnly {
    function multiSend(bytes memory transactions) external payable;
}

library SafeDeployments {
    /// @dev Safe v1.4.1, canonical addresses, all live on 4663. The L2 singleton emits an event per
    ///      execution, which is what Safe's transaction service indexes on an L2 like this one.
    address internal constant SAFE_L2 = 0x29fcB43b46531BcA003ddC8FCB67FFE91900C762;
    address internal constant PROXY_FACTORY = 0x4e1DCf7AD4e460CfD30791CCC4F9c8a4f820ec67;
    address internal constant FALLBACK_HANDLER = 0xfd0732Dc9E303f09fCEf3a7388Ad10A83459Ec99;
    address internal constant MULTI_SEND_CALL_ONLY = 0x9641d764fc13c8B624c04430C7356C1C7C8102e2;

    /// @dev Their code hashes, identical on 4663 and on Base. The Safe is not our code, so nothing
    ///      here builds on an address whose code is not exactly this.
    bytes32 internal constant SAFE_L2_CODEHASH = 0xb1f926978a0f44a2c0ec8fe822418ae969bd8c3f18d61e5103100339894f81ff;
    bytes32 internal constant PROXY_FACTORY_CODEHASH =
        0x50c3cdc4074750a7a974204a716c999edd37482f907608d960b2b025ee0b3317;
    bytes32 internal constant FALLBACK_HANDLER_CODEHASH =
        0x7c6007a5d711cea8dfd5d91f5940ec29c7f200fe511eb1fc1397b367af3c42f9;
    bytes32 internal constant MULTI_SEND_CALL_ONLY_CODEHASH =
        0xecd5bd14a08c5d2122379900b2f272bdf107a7e92423c10dd5fe3254386c9939;

    uint8 internal constant CALL = 0;
    uint8 internal constant DELEGATECALL = 1;

    /// @notice True when all four contracts are exactly the canonical v1.4.1 code.
    function canonical() internal view returns (bool) {
        return SAFE_L2.codehash == SAFE_L2_CODEHASH && PROXY_FACTORY.codehash == PROXY_FACTORY_CODEHASH
            && FALLBACK_HANDLER.codehash == FALLBACK_HANDLER_CODEHASH
            && MULTI_SEND_CALL_ONLY.codehash == MULTI_SEND_CALL_ONLY_CODEHASH;
    }
}

library SafeLib {
    struct Call {
        address to;
        uint256 value;
        bytes data;
    }

    /// @notice What `setup` is called with: owners, threshold, the compatibility fallback handler
    ///         (so the Safe can answer EIP-1271 and receive ERC-721/1155), and nothing else.
    function initializer(address[] memory owners, uint256 threshold) internal pure returns (bytes memory) {
        return abi.encodeCall(
            ISafe.setup,
            (owners, threshold, address(0), "", SafeDeployments.FALLBACK_HANDLER, address(0), 0, payable(address(0)))
        );
    }

    /// @notice The address `createProxyWithNonce` will give these owners, before anything is sent.
    /// @dev CREATE2 from the factory, salted with the initializer and the nonce. The same owners,
    ///      threshold and nonce give the same address on every chain with the canonical factory,
    ///      which is what lets the Safe be recreated at its own address somewhere else if ever needed.
    function predict(address[] memory owners, uint256 threshold, uint256 saltNonce) internal view returns (address) {
        bytes32 salt = keccak256(abi.encodePacked(keccak256(initializer(owners, threshold)), saltNonce));
        bytes memory code = abi.encodePacked(
            ISafeProxyFactory(SafeDeployments.PROXY_FACTORY).proxyCreationCode(),
            uint256(uint160(SafeDeployments.SAFE_L2))
        );
        return address(
            uint160(uint256(keccak256(abi.encodePacked(bytes1(0xff), SafeDeployments.PROXY_FACTORY, salt, keccak256(code)))))
        );
    }

    /// @notice Calldata for MultiSendCallOnly: several calls as ONE Safe transaction, one set of
    ///         signatures, all or nothing. The Safe must reach it by DELEGATECALL so the calls come
    ///         from the Safe itself.
    function multiSend(Call[] memory calls) internal pure returns (bytes memory) {
        bytes memory packed;
        for (uint256 i; i < calls.length; ++i) {
            packed = abi.encodePacked(
                packed, SafeDeployments.CALL, calls[i].to, calls[i].value, calls[i].data.length, calls[i].data
            );
        }
        return abi.encodeCall(IMultiSendCallOnly.multiSend, (packed));
    }

    /// @notice True when `who` answers like a Safe: code, a threshold, owners.
    function looksLikeSafe(address who) internal view returns (bool) {
        if (who.code.length == 0) return false;
        (bool ok, bytes memory ret) = who.staticcall(abi.encodeCall(ISafe.getThreshold, ()));
        return ok && ret.length == 32 && abi.decode(ret, (uint256)) > 0;
    }
}
