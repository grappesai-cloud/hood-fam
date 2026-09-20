// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Vm} from "forge-std/Vm.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {BaseTest} from "./Base.t.sol";
import {SafeRig} from "./helpers/SafeRig.sol";
import {ISafe, SafeDeployments, SafeLib} from "../script/safe/Safe.sol";

import {HoodFactory} from "../src/HoodFactory.sol";
import {HoodCurve} from "../src/HoodCurve.sol";
import {HoodStaking} from "../src/HoodStaking.sol";
import {HoodSeasonDrop} from "../src/HoodSeasonDrop.sol";
import {LaunchParams} from "../src/HoodTypes.sol";

/// @notice hood.fam with a real Safe v1.4.1 in both of the places one belongs: as the protocol's
///         owner and treasury, and as an ordinary user of it (a team launching, trading, staking,
///         taking a fee stream and claiming a drop).
contract SafeTest is BaseTest, SafeRig {
    /// The protocol's own Safe: owner of the switches and treasury, two of three.
    ISafe internal ops;
    uint256[] internal opsKeys;

    function setUp() public override {
        super.setUp();
        _installSafe();
        (ops, opsKeys) = _newSafe("ops", 3, 2);
    }

    // ------------------------------------------------------------------ the Safe itself

    function test_theSafeIsTwoOfThreeWithTheCompatibilityHandler() public view {
        assertEq(ops.getThreshold(), 2);
        assertEq(ops.getOwners().length, 3);
        assertEq(ops.VERSION(), "1.4.1");
        // Safe keeps its fallback handler in this slot. Without the compatibility handler the Safe
        // could not answer EIP-1271 or take an ERC-721.
        bytes32 slot = 0x6c9a6c4a39284e37ed1cf53d337577d14212a4870fb976a4366c693b939918d5;
        assertEq(address(uint160(uint256(vm.load(address(ops), slot)))), SafeDeployments.FALLBACK_HANDLER);
    }

    // ------------------------------------------------------------------ the Safe as the owner

    function test_ownershipMovesToTheSafeInOneBatch() public {
        HoodSeasonDrop drop = new HoodSeasonDrop(owner, treasury);
        vm.startPrank(owner);
        factory.transferOwnership(address(ops));
        drop.transferOwnership(address(ops));
        vm.stopPrank();
        // Ownable2Step: nothing has moved until the Safe accepts.
        assertEq(factory.owner(), owner);

        SafeLib.Call[] memory calls = new SafeLib.Call[](2);
        calls[0] = SafeLib.Call(address(factory), 0, abi.encodeWithSignature("acceptOwnership()"));
        calls[1] = SafeLib.Call(address(drop), 0, abi.encodeWithSignature("acceptOwnership()"));
        _batch(ops, calls, _first(opsKeys, 2));

        assertEq(factory.owner(), address(ops));
        assertEq(drop.owner(), address(ops));
    }

    function test_oneSignerCannotMoveTheProtocol() public {
        _handOver();
        bytes memory data = abi.encodeCall(HoodFactory.setLaunchFee, (1 ether));

        // One signature out of the two the Safe needs.
        bytes memory one = _signatures(ops, address(factory), 0, data, SafeDeployments.CALL, _first(opsKeys, 1));
        vm.expectRevert(bytes("GS020"));
        ops.execTransaction(address(factory), 0, data, 0, 0, 0, 0, address(0), payable(address(0)), one);

        // The same signature twice is still one signer.
        bytes memory twice = bytes.concat(one, one);
        vm.expectRevert(bytes("GS026"));
        ops.execTransaction(address(factory), 0, data, 0, 0, 0, 0, address(0), payable(address(0)), twice);

        // And a signer is nobody on their own: the factory only answers the Safe.
        address signer = vm.addr(opsKeys[0]);
        vm.prank(signer);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, signer));
        factory.setLaunchFee(1 ether);

        assertEq(factory.launchFee(), LAUNCH_FEE);
    }

    function test_anyTwoSignersRunTheSwitches() public {
        _handOver();
        _call(ops, address(factory), 0, abi.encodeCall(HoodFactory.setLaunchFee, (0.001 ether)), _first(opsKeys, 2));
        assertEq(factory.launchFee(), 0.001 ether);

        uint256[] memory lastTwo = new uint256[](2);
        (lastTwo[0], lastTwo[1]) = (opsKeys[1], opsKeys[2]);
        _call(ops, address(factory), 0, abi.encodeCall(HoodFactory.setConfigEnabled, (configId, false)), lastTwo);
        assertFalse(factory.getConfig(configId).enabled);
    }

    function test_aSignedTransactionCannotBeReplayed() public {
        _handOver();
        bytes memory data = abi.encodeCall(HoodFactory.setLaunchFee, (0.003 ether));
        bytes memory sigs = _signatures(ops, address(factory), 0, data, SafeDeployments.CALL, _first(opsKeys, 2));
        ops.execTransaction(address(factory), 0, data, 0, 0, 0, 0, address(0), payable(address(0)), sigs);
        // The nonce moved, so the same signatures now sign a different hash and recover strangers.
        vm.expectRevert(bytes("GS026"));
        ops.execTransaction(address(factory), 0, data, 0, 0, 0, 0, address(0), payable(address(0)), sigs);
    }

    // ------------------------------------------------------------------ the Safe as the treasury

    function test_theTreasurySafeTakesTheLaunchFeeAndTheProtocolLeg() public {
        _handOver();
        _call(ops, address(factory), 0, abi.encodeCall(HoodFactory.setTreasury, (address(ops))), _first(opsKeys, 2));

        uint256 before = address(ops).balance;
        (, HoodCurve curve) = _launch(_toCreator());
        // The launch fee is pushed in the launch transaction, into the Safe's receive.
        assertEq(address(ops).balance - before, LAUNCH_FEE);

        _buy(curve, alice, 1 ether);
        uint256 booked = curve.protocolClaimable();
        assertGt(booked, 0);
        before = address(ops).balance;
        vm.prank(makeAddr("keeper"));
        curve.claimProtocol();
        assertEq(address(ops).balance - before, booked);
    }

    /// @notice Why the Safe has to be the treasury from the first deploy: a curve pins the treasury it
    ///         was launched with, and a later move only reaches launches made after it.
    function test_aCurveKeepsTheTreasuryItLaunchedWith() public {
        (, HoodCurve early) = _launch(_toCreator());
        _handOver();
        _call(ops, address(factory), 0, abi.encodeCall(HoodFactory.setTreasury, (address(ops))), _first(opsKeys, 2));

        _buy(early, alice, 1 ether);
        uint256 booked = early.protocolClaimable();
        uint256 oldBefore = treasury.balance;
        uint256 safeBefore = address(ops).balance;
        early.claimProtocol();
        assertEq(treasury.balance - oldBefore, booked);
        assertEq(address(ops).balance, safeBefore);
    }

    // ------------------------------------------------------------------ a Safe as a user

    function test_aSafeLaunchesWithItsFirstBuyInTheSameTransaction() public {
        (ISafe team, uint256[] memory keys) = _newSafe("team", 2, 2);
        vm.deal(address(team), 10 ether);

        LaunchParams memory p = _params(_toCreator());
        p.creatorFeeRecipient = address(team);
        p.firstBuy = 0.5 ether;
        p.salt = bytes32(uint256(7));

        vm.recordLogs();
        _call(team, address(factory), LAUNCH_FEE + 0.5 ether, abi.encodeCall(HoodFactory.launch, (p)), keys);
        (address token, address curve, address creator) = _launched();

        assertEq(creator, address(team), "the Safe is the creator");
        assertGt(IERC20(token).balanceOf(address(team)), 0, "the first buy landed in the Safe");
        assertEq(factory.getLaunch(token).creatorFeeRecipient, address(team));
        assertGt(HoodCurve(payable(curve)).sold(), 0);
    }

    function test_aSafeSellsAndStakesWithOneSignatureRoundEach() public {
        (address token, HoodCurve curve) = _launch(_toStakers());
        (ISafe team, uint256[] memory keys) = _newSafe("team", 3, 2);
        uint256[] memory two = _first(keys, 2);
        vm.deal(address(team), 5 ether);

        _call(team, address(curve), 1 ether, abi.encodeCall(HoodCurve.buy, (1 ether, 0, address(team))), two);
        uint256 held = IERC20(token).balanceOf(address(team));
        assertGt(held, 0);

        // Approve and sell: one Safe transaction, not two proposals that each wait for signers.
        uint256 toSell = held / 4;
        SafeLib.Call[] memory sell = new SafeLib.Call[](2);
        sell[0] = SafeLib.Call(token, 0, abi.encodeCall(IERC20.approve, (address(curve), toSell)));
        sell[1] = SafeLib.Call(address(curve), 0, abi.encodeCall(HoodCurve.sell, (toSell, 0, address(team))));
        uint256 ethBefore = address(team).balance;
        _batch(team, sell, two);
        assertEq(IERC20(token).balanceOf(address(team)), held - toSell);
        assertGt(address(team).balance, ethBefore);

        // Approve and lock for 30 days, the same way.
        uint256 toStake = IERC20(token).balanceOf(address(team));
        uint256 id = staking.nextPositionId();
        SafeLib.Call[] memory lock = new SafeLib.Call[](2);
        lock[0] = SafeLib.Call(token, 0, abi.encodeCall(IERC20.approve, (address(staking), toStake)));
        lock[1] = SafeLib.Call(address(staking), 0, abi.encodeCall(HoodStaking.stake, (token, toStake, 30 days)));
        _batch(team, lock, two);
        assertEq(IERC20(token).balanceOf(address(team)), 0);

        // The fee stream reaches the Safe's position, and a stranger can push it to the Safe.
        _buy(curve, alice, 2 ether);
        router.flush(token);
        assertGt(staking.pending(id), 0);
        ethBefore = address(team).balance;
        vm.prank(makeAddr("keeper"));
        staking.claim(id);
        assertGt(address(team).balance, ethBefore, "rewards paid into the Safe");
    }

    function test_aBatchIsAllOrNothing() public {
        (address token, HoodCurve curve) = _launch(_toCreator());
        (ISafe team, uint256[] memory keys) = _newSafe("team", 2, 2);
        vm.deal(address(team), 5 ether);
        _call(team, address(curve), 1 ether, abi.encodeCall(HoodCurve.buy, (1 ether, 0, address(team))), keys);
        uint256 held = IERC20(token).balanceOf(address(team));

        // The sell asks for more than the curve can pay, so the approval in front of it must not
        // survive either.
        SafeLib.Call[] memory calls = new SafeLib.Call[](2);
        calls[0] = SafeLib.Call(token, 0, abi.encodeCall(IERC20.approve, (address(curve), held)));
        calls[1] = SafeLib.Call(address(curve), 0, abi.encodeCall(HoodCurve.sell, (held, 1_000 ether, address(team))));
        bytes memory data = SafeLib.multiSend(calls);
        bytes memory sigs =
            _signatures(team, SafeDeployments.MULTI_SEND_CALL_ONLY, 0, data, SafeDeployments.DELEGATECALL, keys);
        vm.expectRevert(bytes("GS013"));
        team.execTransaction(
            SafeDeployments.MULTI_SEND_CALL_ONLY, 0, data, SafeDeployments.DELEGATECALL, 0, 0, 0, address(0),
            payable(address(0)), sigs
        );
        assertEq(IERC20(token).allowance(address(team), address(curve)), 0);
        assertEq(IERC20(token).balanceOf(address(team)), held);
    }

    function test_aCreatorFeeStreamPaysIntoASafe() public {
        (ISafe team,) = _newSafe("team", 2, 2);
        LaunchParams memory p = _params(_toCreator());
        p.creatorFeeRecipient = address(team);
        (address token, HoodCurve curve) = _launch(_toCreator(), p, LAUNCH_FEE);

        _buy(curve, alice, 2 ether);
        uint256 before = address(team).balance;
        router.flush(token);
        assertGt(address(team).balance, before, "the creator leg reached the Safe");
    }

    function test_aSafeClaimsItsSeasonDrop() public {
        (ISafe team,) = _newSafe("team", 2, 2);
        HoodSeasonDrop drop = new HoodSeasonDrop(address(ops), address(ops));

        // One wallet on the list, so the root is its leaf and the proof is empty.
        uint256 amount = 0.4 ether;
        bytes32 root = drop.leafOf(1, address(team), amount);
        vm.deal(address(ops), 1 ether);
        _call(
            ops,
            address(drop),
            amount,
            abi.encodeCall(HoodSeasonDrop.openDrop, (1, root, address(0), amount, uint64(block.timestamp + 31 days))),
            _first(opsKeys, 2)
        );

        uint256 before = address(team).balance;
        vm.prank(makeAddr("keeper"));
        drop.claim(1, address(team), amount, new bytes32[](0));
        assertEq(address(team).balance - before, amount, "claimed into the Safe");
    }

    // ------------------------------------------------------------------ helpers

    function _handOver() internal {
        vm.prank(owner);
        factory.transferOwnership(address(ops));
        _call(ops, address(factory), 0, abi.encodeWithSignature("acceptOwnership()"), _first(opsKeys, 2));
        assertEq(factory.owner(), address(ops));
    }

    function _launched() internal view returns (address token, address curve, address creator) {
        Vm.Log[] memory logs = vm.getRecordedLogs();
        bytes32 topic = keccak256("Launched(address,address,address,uint256,address,(uint16,uint16,uint16,uint16))");
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter == address(factory) && logs[i].topics[0] == topic) {
                return (
                    address(uint160(uint256(logs[i].topics[1]))),
                    address(uint160(uint256(logs[i].topics[2]))),
                    address(uint160(uint256(logs[i].topics[3])))
                );
            }
        }
        revert("no Launched event");
    }
}
