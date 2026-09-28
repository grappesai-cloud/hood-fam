// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import {CurveConfig, LaunchParams} from "./HoodTypes.sol";
import {ITeamEvents, TeamBuy} from "./TeamTypes.sol";
import {PairTransfer} from "./libraries/PairTransfer.sol";
import {IHoodCurve} from "./interfaces/IHoodCurve.sol";
import {IHoodTokenLock} from "./interfaces/IHoodTokenLock.sol";

/// @dev The two launch calls this contract makes into the factory, and the one module it reads.
interface IHoodFactoryLaunch {
    function launch(LaunchParams calldata p) external payable returns (address token, address curve, uint256 bought);
    function launchCustom(LaunchParams calldata p, CurveConfig calldata custom)
        external
        payable
        returns (address token, address curve, uint256 bought);
    function launchFee() external view returns (uint256);
    function firstBuyLocker() external view returns (address);
}

/// @title HoodBlockZero
/// @notice A team launch on the curve: the token is printed and every team wallet buys, in one
///         transaction, before anyone else can trade. Every wallet is written down here, by token,
///         with what it paid, what it got and when its lock opens.
/// @dev A periphery over the factory, not a change to it: the factory sees this contract as the
///      creator, and this contract remembers who actually called (`launcherOf`). No owner, no
///      settings, nothing held between calls. The curve treats this contract as the launch's
///      opener, so its buys INSIDE the launch transaction skip the opening surcharge and the
///      per-wallet cap; a follow-up one transaction later pays both like anyone.
///
///      The launcher pays for every leg. The legs are therefore linked on chain to the launcher
///      and to each other by construction, and this contract adds the registry on top so an app
///      can label them without reading traces.
contract HoodBlockZero is ITeamEvents, ReentrancyGuard {
    using SafeERC20 for IERC20;

    /// @notice What the registry keeps per leg.
    struct TeamWallet {
        address wallet;
        uint128 pairSpent;
        uint128 tokens;
        uint64 unlockAt; // 0 when the leg was not locked
        uint256 lockId; // the token lock's position id, 0 when not locked
    }

    /// @notice Enough for any team, low enough that a launch never runs out of gas half way.
    uint256 public constant MAX_LEGS = 40;

    IHoodFactoryLaunch public immutable factory;

    mapping(address token => address) public launcherOf;
    mapping(address token => address) public curveOf;
    mapping(address token => TeamWallet[]) internal _team;
    mapping(address token => mapping(address wallet => bool)) public isTeamWallet;
    /// @notice Sum of every leg's tokens, for the "team holds X% at launch" line and the guard.
    mapping(address token => uint256) public teamTokens;

    event FollowUp(address indexed token, address indexed launcher, uint256 outsideBought, uint256 legs);

    error ZeroAddress();
    error NoLegs();
    error TooManyLegs();
    error EmptyLeg();
    error DuplicateWallet();
    error UseLegs();
    error BadLock();
    error BadValue();
    error NotLauncher();
    error UnknownToken();
    /// @notice The follow-up's guard: more than `maxOutside` token wei were bought by wallets that
    ///         are not the team's since the launch, so the wave is not sent.
    error OutsidersAhead(uint256 outsideBought, uint256 maxOutside);

    constructor(address factory_) {
        if (factory_ == address(0)) revert ZeroAddress();
        factory = IHoodFactoryLaunch(factory_);
    }

    /// @dev The curve refunds whatever it could not absorb to its caller, which is this contract.
    receive() external payable {}

    // ---------------------------------------------------------------- views

    function teamOf(address token) external view returns (TeamWallet[] memory) {
        return _team[token];
    }

    function teamCount(address token) external view returns (uint256) {
        return _team[token].length;
    }

    /// @notice Token wei on the curve that went to wallets outside the team, net of what they
    ///         sold back. Counted as the curve's `sold` less the team's buys, so a team wallet that
    ///         sells makes this read low, never high.
    function outsideBought(address token) public view returns (uint256) {
        address curve = curveOf[token];
        if (curve == address(0)) revert UnknownToken();
        uint256 sold = IHoodCurve(curve).sold();
        uint256 team = teamTokens[token];
        return sold > team ? sold - team : 0;
    }

    /// @notice The salt the factory will see for `launcher`'s `salt`, so an app can predict the
    ///         token address the same way it does for a direct factory launch from this contract.
    function saltFor(address launcher, bytes32 salt) public pure returns (bytes32) {
        return keccak256(abi.encode(launcher, salt));
    }

    // ---------------------------------------------------------------- launching

    /// @notice Launches on a preset and runs every leg in the same transaction.
    /// @dev Native pair: send the launch fee, the sum of the legs and the sum of their gas. ERC-20
    ///      pair: send the launch fee and the gas, and approve this contract for the sum of the legs.
    function launch(LaunchParams calldata p, TeamBuy[] calldata legs)
        external
        payable
        nonReentrant
        returns (address token, address curve)
    {
        (LaunchParams memory lp, uint256 fee) = _prepare(p, legs);
        (token, curve,) = factory.launch{value: fee}(lp);
        _open(token, curve, p.pairToken, legs, fee);
    }

    /// @notice Same, on a custom curve (meme-to-meme or any ERC-20 quote the factory accepts).
    function launchCustom(LaunchParams calldata p, CurveConfig calldata custom, TeamBuy[] calldata legs)
        external
        payable
        nonReentrant
        returns (address token, address curve)
    {
        (LaunchParams memory lp, uint256 fee) = _prepare(p, legs);
        (token, curve,) = factory.launchCustom{value: fee}(lp, custom);
        _open(token, curve, p.pairToken, legs, fee);
    }

    /// @notice A second wave for a launch made here, sent only while the outside has bought no
    ///         more than `maxOutside` token wei. This is "complete early" read the other way: when
    ///         the room filled up with strangers, the team keeps its money and the call reverts.
    /// @dev Launcher only, and on the curve's normal terms: it is a later transaction, so it pays
    ///      the opening surcharge and the buy cap like anyone would.
    function followUp(address token, TeamBuy[] calldata legs, uint256 maxOutside) external payable nonReentrant {
        if (launcherOf[token] != msg.sender) revert NotLauncher();
        uint256 outside = outsideBought(token);
        if (outside > maxOutside) revert OutsidersAhead(outside, maxOutside);
        address curve = curveOf[token];
        address pair = IHoodCurve(curve).pairToken();
        uint256 total = _checkLegs(legs, _team[token].length);
        if (msg.value != (pair == address(0) ? total : 0) + _gasOf(legs)) revert BadValue();
        _runLegs(token, curve, pair, legs, msg.value);
        emit FollowUp(token, msg.sender, outside, legs.length);
    }

    /// @notice Sends native currency to team wallets, for the transactions they make later (a lock
    ///         withdrawal, a sale, a transfer). Anyone may call it; it only moves the caller's money.
    function fundGas(address token, address[] calldata wallets, uint256[] calldata amounts) external payable nonReentrant {
        if (wallets.length != amounts.length) revert BadValue();
        uint256 total;
        for (uint256 i; i < wallets.length; ++i) {
            total += amounts[i];
            PairTransfer.push(address(0), wallets[i], amounts[i]);
            emit TeamGas(token, wallets[i], amounts[i]);
        }
        if (total != msg.value) revert BadValue();
    }

    // ---------------------------------------------------------------- internals

    /// @dev The factory's own first buy is off: the legs are the first buy, and a second path to
    ///      the same thing would be a leg this registry never saw. The creator fee recipient
    ///      defaults to the launcher, because the factory would otherwise default it to this
    ///      contract, which has no way to claim.
    function _prepare(LaunchParams calldata p, TeamBuy[] calldata legs)
        internal
        view
        returns (LaunchParams memory lp, uint256 fee)
    {
        if (p.firstBuy != 0 || p.firstBuyLock != 0) revert UseLegs();
        uint256 total = _checkLegs(legs, 0);

        fee = factory.launchFee();
        if (msg.value != fee + (p.pairToken == address(0) ? total : 0) + _gasOf(legs)) revert BadValue();

        lp = p;
        lp.salt = saltFor(msg.sender, p.salt);
        if (lp.creatorFeeRecipient == address(0)) lp.creatorFeeRecipient = msg.sender;
    }

    /// @dev `existing` legs are already on the registry for this token (a follow-up), so the cap
    ///      counts them too. Duplicates against the registry are caught in `_leg`.
    function _checkLegs(TeamBuy[] calldata legs, uint256 existing) internal view returns (uint256 total) {
        uint256 n = legs.length;
        if (n == 0) revert NoLegs();
        if (existing + n > MAX_LEGS) revert TooManyLegs();
        address locker = factory.firstBuyLocker();
        for (uint256 i; i < n; ++i) {
            TeamBuy calldata l = legs[i];
            if (l.wallet == address(0)) revert ZeroAddress();
            if (l.pairIn == 0) revert EmptyLeg();
            if (l.lock != 0 && (locker == address(0) || !IHoodTokenLock(locker).isTier(l.lock))) revert BadLock();
            // One row per wallet, so "this wallet is the team's" has exactly one answer.
            for (uint256 j; j < i; ++j) {
                if (legs[j].wallet == l.wallet) revert DuplicateWallet();
            }
            total += l.pairIn;
        }
    }

    function _gasOf(TeamBuy[] calldata legs) internal pure returns (uint256 gas) {
        for (uint256 i; i < legs.length; ++i) {
            gas += legs[i].gas;
        }
    }

    function _open(address token, address curve, address pair, TeamBuy[] calldata legs, uint256 fee) internal {
        launcherOf[token] = msg.sender;
        curveOf[token] = curve;
        (uint256 spent, uint256 got) = _runLegs(token, curve, pair, legs, msg.value - fee);
        emit TeamLaunched(token, curve, msg.sender, legs.length, spent, got);
    }

    /// @dev `nativeIn` is what this call brought for the legs and their gas, the launch fee already
    ///      gone. Refunds and change are measured as balance deltas of this call, so a stray balance
    ///      sitting here is never handed to a launcher.
    function _runLegs(address token, address curve, address pair, TeamBuy[] calldata legs, uint256 nativeIn)
        internal
        returns (uint256 spentAll, uint256 gotAll)
    {
        uint256 before = PairTransfer.balance(pair, address(this));
        if (pair == address(0)) {
            before -= nativeIn;
        } else {
            uint256 total = 0;
            for (uint256 i; i < legs.length; ++i) {
                total += legs[i].pairIn;
            }
            PairTransfer.pull(pair, msg.sender, total, 0);
        }

        address locker = factory.firstBuyLocker();
        uint256 index = _team[token].length;
        for (uint256 i; i < legs.length; ++i) {
            (uint256 spent, uint256 got) = _leg(token, curve, pair, locker, legs[i], index + i);
            spentAll += spent;
            gotAll += got;
            if (legs[i].gas != 0) {
                PairTransfer.push(address(0), legs[i].wallet, legs[i].gas);
                emit TeamGas(token, legs[i].wallet, legs[i].gas);
            }
        }
        teamTokens[token] += gotAll;

        // Whatever the curve handed back (a leg that ran into the end of the curve) is the launcher's.
        PairTransfer.push(pair, msg.sender, PairTransfer.balance(pair, address(this)) - before);
    }

    function _leg(address token, address curve, address pair, address locker, TeamBuy calldata l, uint256 index)
        internal
        returns (uint256 spent, uint256 got)
    {
        if (isTeamWallet[token][l.wallet]) revert DuplicateWallet();
        uint256 pairBefore = PairTransfer.balance(pair, address(this));
        address to = l.lock == 0 ? l.wallet : address(this);
        if (pair == address(0)) {
            got = IHoodCurve(curve).buy{value: l.pairIn}(l.pairIn, l.minTokensOut, to);
        } else {
            IERC20(pair).forceApprove(curve, l.pairIn);
            got = IHoodCurve(curve).buy(l.pairIn, l.minTokensOut, to);
            IERC20(pair).forceApprove(curve, 0);
        }
        spent = pairBefore - PairTransfer.balance(pair, address(this));

        uint256 lockId = 0;
        uint64 unlockAt = 0;
        if (l.lock != 0) {
            IERC20(token).forceApprove(locker, got);
            lockId = IHoodTokenLock(locker).lockFor(token, l.wallet, got, l.lock);
            unlockAt = uint64(block.timestamp) + l.lock;
        }

        _team[token].push(
            TeamWallet({
                wallet: l.wallet,
                pairSpent: uint128(spent),
                tokens: uint128(got),
                unlockAt: unlockAt,
                lockId: lockId
            })
        );
        isTeamWallet[token][l.wallet] = true;
        emit TeamLeg(token, l.wallet, index, spent, got, lockId, unlockAt);
    }
}
