// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import {Launch, LaunchMode} from "./HoodTypes.sol";
import {PairTransfer} from "./libraries/PairTransfer.sol";
import {IHoodFactory} from "./interfaces/IHoodFactory.sol";
import {IHoodStaking} from "./interfaces/IHoodStaking.sol";

/// @title HoodStaking
/// @notice Proof of belief: holders lock a launched token and take the creator fee stream, weighted
///         by how much they locked and for how long.
/// @dev One contract serves every launch, keyed by token, so a launch costs no extra deployment.
///      Rewards are paid in that launch's pair asset. Nothing here has an owner, nothing expires
///      and no principal can be moved by anyone but the position holder after the lock.
contract HoodStaking is IHoodStaking, ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint256 internal constant ACC_PRECISION = 1e27;
    uint256 internal constant BPS = 10_000;

    struct Position {
        address token;
        address owner;
        uint128 amount;
        uint64 unlockAt;
        uint32 weightBps;
        uint256 rewardDebt;
    }

    struct Tier {
        uint64 lock;
        uint32 weightBps;
    }

    IHoodFactory public immutable factory;

    /// @notice Lock lengths and what they are worth, longest first. Fixed at deployment.
    Tier[5] public tiers;

    mapping(uint256 id => Position) public positions;
    mapping(address token => uint256) public totalWeight;
    mapping(address token => uint256) public accRewardPerWeight;
    /// @notice Rewards that arrived while nobody was staking. Credited to the first staker's peers.
    mapping(address token => uint256) public orphanRewards;
    mapping(address token => uint256) public staked;
    /// @dev Pair wei this contract knows about, per asset.
    mapping(address asset => uint256) public accounted;

    uint256 public nextPositionId = 1;

    event Staked(
        uint256 indexed id, address indexed token, address indexed owner, uint256 amount, uint64 unlockAt, uint32 weightBps
    );
    event Unstaked(uint256 indexed id, uint256 amount);
    event Claimed(uint256 indexed id, address indexed to, uint256 amount);
    event Demoted(uint256 indexed id, uint32 weightBps);
    event RewardNotified(address indexed token, uint256 amount);

    error UnknownToken();
    error FundsNotReceived();
    error ZeroAmount();
    error StillLocked();
    error NotOwner();
    error NoPosition();
    error LockTooLong();
    error AmountTooLarge();
    error NotACurveLaunch();

    constructor(address factory_) {
        factory = IHoodFactory(factory_);
        // 1x flexible, up to 2.5x for half a year.
        tiers[0] = Tier({lock: 180 days, weightBps: 25_000});
        tiers[1] = Tier({lock: 90 days, weightBps: 20_000});
        tiers[2] = Tier({lock: 30 days, weightBps: 15_000});
        tiers[3] = Tier({lock: 7 days, weightBps: 12_500});
        tiers[4] = Tier({lock: 0, weightBps: 10_000});
    }

    receive() external payable {}

    // ---------------------------------------------------------------- views

    /// @notice What a lock of `lockDuration` is worth, in bps of the amount staked.
    function weightFor(uint64 lockDuration) public view returns (uint32) {
        for (uint256 i; i < tiers.length; ++i) {
            if (lockDuration >= tiers[i].lock) return tiers[i].weightBps;
        }
        return tiers[tiers.length - 1].weightBps;
    }

    /// @notice Whether `lockDuration` is exactly one of the tiers, not merely long enough for one.
    /// @dev A caller that locks tokens in somebody else's name has to speak in tiers rather than in
    ///      arbitrary seconds, or an app and this vault would each round the same lock their own
    ///      way and show the holder two different unlock dates.
    function isTier(uint64 lockDuration) external view returns (bool) {
        for (uint256 i; i < tiers.length; ++i) {
            if (tiers[i].lock == lockDuration) return true;
        }
        return false;
    }

    /// @notice Rewards a position can claim right now.
    function pending(uint256 id) public view returns (uint256) {
        Position memory p = positions[id];
        if (p.owner == address(0)) return 0;
        uint256 weight = Math.mulDiv(p.amount, p.weightBps, BPS);
        uint256 total = Math.mulDiv(weight, accRewardPerWeight[p.token], ACC_PRECISION);
        return total > p.rewardDebt ? total - p.rewardDebt : 0;
    }

    function rewardAsset(address token) public view returns (address) {
        return factory.getLaunch(token).pairToken;
    }

    // ---------------------------------------------------------------- rewards in

    /// @inheritdoc IHoodStaking
    function notifyReward(address token, uint256 amount) external payable {
        Launch memory l = factory.getLaunch(token);
        if (!l.exists) revert UnknownToken();
        if (amount == 0) revert ZeroAmount();

        if (l.pairToken == address(0)) {
            if (msg.value != amount) revert FundsNotReceived();
        } else {
            if (msg.value != 0) revert FundsNotReceived();
            if (IERC20(l.pairToken).balanceOf(address(this)) < accounted[l.pairToken] + amount) {
                revert FundsNotReceived();
            }
        }
        accounted[l.pairToken] += amount;

        uint256 weight = totalWeight[token];
        if (weight == 0) {
            orphanRewards[token] += amount;
        } else {
            accRewardPerWeight[token] += Math.mulDiv(amount, ACC_PRECISION, weight);
        }
        emit RewardNotified(token, amount);
    }

    // ---------------------------------------------------------------- staking

    /// @notice Locks `amount` of `token` for `lockDuration` and earns the fee stream.
    function stake(address token, uint256 amount, uint64 lockDuration) external returns (uint256 id) {
        return _stake(token, msg.sender, amount, lockDuration);
    }

    /// @notice Send a stake: locks tokens on somebody else's behalf. They earn, they cannot sell
    ///         before the lock ends, and the sender keeps nothing.
    /// @dev This is how a launch pays a caller or a partner without handing them an exit.
    function stakeFor(address token, address beneficiary, uint256 amount, uint64 lockDuration)
        external
        returns (uint256 id)
    {
        if (beneficiary == address(0)) revert NotOwner();
        return _stake(token, beneficiary, amount, lockDuration);
    }

    function _stake(address token, address owner, uint256 amount, uint64 lockDuration)
        internal
        nonReentrant
        returns (uint256 id)
    {
        if (amount == 0) revert ZeroAmount();
        if (amount > type(uint128).max) revert AmountTooLarge();
        if (lockDuration > 365 days) revert LockTooLong();
        Launch memory l = factory.getLaunch(token);
        if (!l.exists) revert UnknownToken();
        // A direct launch pays its holders where they stand, out of the splitter, by balance. Tokens
        // locked here would stop being a holder as far as that accumulator is concerned: the share
        // would be booked to this contract, which has no way to pass it on and no way to return it.
        // Nothing routes a direct launch's fees here either, so the position would earn nothing and
        // cost its owner the dividends they already had.
        if (l.mode != LaunchMode.Curve) revert NotACurveLaunch();

        IERC20(token).safeTransferFrom(msg.sender, address(this), amount);

        uint32 weightBps = weightFor(lockDuration);
        uint256 weight = Math.mulDiv(amount, weightBps, BPS);

        id = nextPositionId++;
        positions[id] = Position({
            token: token,
            owner: owner,
            amount: uint128(amount),
            unlockAt: uint64(block.timestamp) + lockDuration,
            weightBps: weightBps,
            rewardDebt: Math.mulDiv(weight, accRewardPerWeight[token], ACC_PRECISION)
        });
        totalWeight[token] += weight;
        staked[token] += amount;

        // Anything that arrived while nobody was staking is credited AFTER this position's debt is
        // fixed, so the first staker to show up is the one who receives it.
        uint256 orphan = orphanRewards[token];
        if (orphan != 0) {
            orphanRewards[token] = 0;
            accRewardPerWeight[token] += Math.mulDiv(orphan, ACC_PRECISION, totalWeight[token]);
        }

        emit Staked(id, token, owner, amount, uint64(block.timestamp) + lockDuration, weightBps);
    }

    /// @notice Permissionless. Pays a position's rewards to its owner.
    /// @dev Push, not pull: a keeper can pay every staker, and if the keeper stops, anybody can.
    function claim(uint256 id) public nonReentrant returns (uint256 amount) {
        Position storage p = positions[id];
        if (p.owner == address(0)) revert NoPosition();
        amount = _settle(id, p);
    }

    /// @notice Returns the principal once the lock is over, with the rewards.
    function unstake(uint256 id) external nonReentrant returns (uint256 amount, uint256 rewards) {
        Position storage p = positions[id];
        if (p.owner != msg.sender) revert NotOwner();
        if (block.timestamp < p.unlockAt) revert StillLocked();

        rewards = _settle(id, p);
        amount = p.amount;
        address token = p.token;
        address owner = p.owner;

        totalWeight[token] -= Math.mulDiv(amount, p.weightBps, BPS);
        staked[token] -= amount;
        delete positions[id];

        IERC20(token).safeTransfer(owner, amount);
        emit Unstaked(id, amount);
    }

    /// @notice Permissionless. Once a lock has run out, its multiplier drops back to 1x.
    /// @dev Otherwise an expired lock would keep earning a long-lock share while being free to sell.
    function demote(uint256 id) external nonReentrant {
        Position storage p = positions[id];
        if (p.owner == address(0)) revert NoPosition();
        if (block.timestamp < p.unlockAt) revert StillLocked();
        uint32 base = tiers[tiers.length - 1].weightBps;
        if (p.weightBps == base) return;

        _settle(id, p);
        uint256 oldWeight = Math.mulDiv(p.amount, p.weightBps, BPS);
        uint256 newWeight = Math.mulDiv(p.amount, base, BPS);
        totalWeight[p.token] = totalWeight[p.token] - oldWeight + newWeight;
        p.weightBps = base;
        p.rewardDebt = Math.mulDiv(newWeight, accRewardPerWeight[p.token], ACC_PRECISION);
        emit Demoted(id, base);
    }

    function _settle(uint256 id, Position storage p) internal returns (uint256 amount) {
        uint256 weight = Math.mulDiv(p.amount, p.weightBps, BPS);
        uint256 total = Math.mulDiv(weight, accRewardPerWeight[p.token], ACC_PRECISION);
        amount = total > p.rewardDebt ? total - p.rewardDebt : 0;
        p.rewardDebt = total;
        if (amount != 0) {
            address asset = factory.getLaunch(p.token).pairToken;
            accounted[asset] -= amount;
            PairTransfer.push(asset, p.owner, amount);
            emit Claimed(id, p.owner, amount);
        }
    }
}
