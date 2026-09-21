// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import {PairTransfer} from "./libraries/PairTransfer.sol";
import {IHoodFactory} from "./interfaces/IHoodFactory.sol";
import {IHoodStaking} from "./interfaces/IHoodStaking.sol";

/// @title HoodStaking
/// @notice One vault, one coin. Locking the house coin is what earns the stakers leg of the fee
///         on EVERY launch on this pad, not just one of them.
/// @dev This used to be a vault per launch: you locked token X and took the share of X's own fee
///      that X's creator had pointed at stakers. That made every launch its own little economy and
///      gave the pad itself nothing to hold. Now there is a single coin, set once by the owner, and
///      every launch that points fees at stakers points them here. A holder of the house coin earns
///      from the whole board; a launch pays the people who believe in the place it launched on.
///
///      What that costs, and how it is paid for: one vault takes rewards in more than one asset,
///      because launches pair against the chain's own currency and against the stablecoin. So the
///      accumulator is per asset rather than per token, and a position carries a debt per asset.
///      The asset list is bounded (`MAX_REWARD_ASSETS`) since every loop here walks it, and the
///      pair list is the owner's to begin with: only an approved pair can ever reach this contract.
///
///      Nothing here can be upgraded, no principal can be moved by anyone but its owner after the
///      lock, and the one owner-only switch (`setHouseToken`) can be thrown exactly once.
contract HoodStaking is IHoodStaking, ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint256 internal constant ACC_PRECISION = 1e27;
    uint256 internal constant BPS = 10_000;
    /// @notice How many different assets may ever pay this vault. Every claim walks this list.
    uint256 internal constant MAX_REWARD_ASSETS = 8;

    struct Position {
        address owner;
        uint128 amount;
        uint64 unlockAt;
        uint32 weightBps;
    }

    struct Tier {
        uint64 lock;
        uint32 weightBps;
    }

    IHoodFactory public immutable factory;

    /// @notice The only token this vault accepts. Zero until the owner names it, once.
    address public houseToken;

    /// @notice Lock lengths and what they are worth, longest first. Fixed at deployment.
    Tier[5] public tiers;

    mapping(uint256 id => Position) public positions;
    /// @dev What a position has already been credited with, per reward asset.
    mapping(uint256 id => mapping(address asset => uint256)) public rewardDebt;

    uint256 public totalWeight;
    uint256 public staked;

    mapping(address asset => uint256) public accRewardPerWeight;
    /// @notice Rewards that arrived while nobody was locked. Credited to the first staker.
    mapping(address asset => uint256) public orphanRewards;
    /// @dev Wei of each asset this contract knows it owes.
    mapping(address asset => uint256) public accounted;

    /// @notice Every asset that has ever paid this vault.
    address[] public rewardAssets;
    mapping(address asset => bool) public isRewardAsset;

    uint256 public nextPositionId = 1;

    event HouseTokenSet(address indexed token);
    event Staked(
        uint256 indexed id, address indexed token, address indexed owner, uint256 amount, uint64 unlockAt, uint32 weightBps
    );
    event Unstaked(uint256 indexed id, uint256 amount);
    event Claimed(uint256 indexed id, address indexed to, address indexed asset, uint256 amount);
    event Demoted(uint256 indexed id, uint32 weightBps);
    event RewardNotified(address indexed asset, uint256 amount);

    error FundsNotReceived();
    error ZeroAmount();
    error StillLocked();
    error NotOwner();
    error NoPosition();
    error LockTooLong();
    error AmountTooLarge();
    error NoHouseToken();
    error HouseTokenAlreadySet();
    error TooManyRewardAssets();

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

    // ---------------------------------------------------------------- the coin

    /// @notice Names the house coin. Once, by the factory's owner, and never again.
    /// @dev The pad's own coin is launched on the pad, so its address cannot be known at deployment.
    ///      One shot: a vault whose coin can be swapped is a vault that can be emptied by decree.
    function setHouseToken(address token) external {
        if (msg.sender != factory.owner()) revert NotOwner();
        if (houseToken != address(0)) revert HouseTokenAlreadySet();
        if (token == address(0)) revert NoHouseToken();
        houseToken = token;
        emit HouseTokenSet(token);
    }

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

    function rewardAssetCount() external view returns (uint256) {
        return rewardAssets.length;
    }

    /// @notice What a position can claim right now, in one asset.
    function pending(uint256 id, address asset) public view returns (uint256) {
        Position memory p = positions[id];
        if (p.owner == address(0)) return 0;
        uint256 weight = Math.mulDiv(p.amount, p.weightBps, BPS);
        uint256 total = Math.mulDiv(weight, accRewardPerWeight[asset], ACC_PRECISION);
        uint256 debt = rewardDebt[id][asset];
        return total > debt ? total - debt : 0;
    }

    /// @notice What a position can claim right now, in every asset that has ever paid.
    function pendingAll(uint256 id) external view returns (address[] memory assets, uint256[] memory amounts) {
        assets = rewardAssets;
        amounts = new uint256[](assets.length);
        for (uint256 i; i < assets.length; ++i) {
            amounts[i] = pending(id, assets[i]);
        }
    }

    // ---------------------------------------------------------------- rewards in

    /// @inheritdoc IHoodStaking
    function notifyReward(address asset, uint256 amount) external payable {
        if (amount == 0) revert ZeroAmount();

        if (asset == address(0)) {
            if (msg.value != amount) revert FundsNotReceived();
        } else {
            if (msg.value != 0) revert FundsNotReceived();
            if (IERC20(asset).balanceOf(address(this)) < accounted[asset] + amount) revert FundsNotReceived();
        }
        accounted[asset] += amount;
        _register(asset);

        uint256 weight = totalWeight;
        if (weight == 0) {
            orphanRewards[asset] += amount;
        } else {
            accRewardPerWeight[asset] += Math.mulDiv(amount, ACC_PRECISION, weight);
        }
        emit RewardNotified(asset, amount);
    }

    function _register(address asset) internal {
        if (isRewardAsset[asset]) return;
        if (rewardAssets.length >= MAX_REWARD_ASSETS) revert TooManyRewardAssets();
        isRewardAsset[asset] = true;
        rewardAssets.push(asset);
    }

    // ---------------------------------------------------------------- staking

    /// @notice Locks `amount` of the house coin for `lockDuration` and earns every launch's stream.
    function stake(uint256 amount, uint64 lockDuration) external returns (uint256 id) {
        return _stake(msg.sender, amount, lockDuration);
    }

    /// @inheritdoc IHoodStaking
    function stakeFor(address beneficiary, uint256 amount, uint64 lockDuration) external returns (uint256 id) {
        if (beneficiary == address(0)) revert NotOwner();
        return _stake(beneficiary, amount, lockDuration);
    }

    function _stake(address owner, uint256 amount, uint64 lockDuration) internal nonReentrant returns (uint256 id) {
        address token = houseToken;
        if (token == address(0)) revert NoHouseToken();
        if (amount == 0) revert ZeroAmount();
        if (amount > type(uint128).max) revert AmountTooLarge();
        if (lockDuration > 365 days) revert LockTooLong();

        IERC20(token).safeTransferFrom(msg.sender, address(this), amount);

        uint32 weightBps = weightFor(lockDuration);
        uint256 weight = Math.mulDiv(amount, weightBps, BPS);

        id = nextPositionId++;
        positions[id] =
            Position({owner: owner, amount: uint128(amount), unlockAt: uint64(block.timestamp) + lockDuration, weightBps: weightBps});
        // The debt is fixed against every stream as it stands now, so a position never reaches back
        // into what was paid out before it existed.
        uint256 assets = rewardAssets.length;
        for (uint256 i; i < assets; ++i) {
            address asset = rewardAssets[i];
            rewardDebt[id][asset] = Math.mulDiv(weight, accRewardPerWeight[asset], ACC_PRECISION);
        }

        totalWeight += weight;
        staked += amount;

        // Anything that arrived while nobody was locked is credited AFTER this position's debt is
        // fixed, so the first staker to show up is the one who receives it.
        for (uint256 i; i < assets; ++i) {
            address asset = rewardAssets[i];
            uint256 orphan = orphanRewards[asset];
            if (orphan != 0) {
                orphanRewards[asset] = 0;
                accRewardPerWeight[asset] += Math.mulDiv(orphan, ACC_PRECISION, totalWeight);
            }
        }

        emit Staked(id, token, owner, amount, uint64(block.timestamp) + lockDuration, weightBps);
    }

    /// @notice Permissionless. Pays a position's rewards to its owner, in every asset it has earned.
    /// @dev Push, not pull: a keeper can pay every staker, and if the keeper stops, anybody can.
    function claim(uint256 id) public nonReentrant {
        Position storage p = positions[id];
        if (p.owner == address(0)) revert NoPosition();
        _settle(id, p);
    }

    /// @notice Returns the principal once the lock is over, with the rewards.
    function unstake(uint256 id) external nonReentrant returns (uint256 amount) {
        Position storage p = positions[id];
        if (p.owner != msg.sender) revert NotOwner();
        if (block.timestamp < p.unlockAt) revert StillLocked();

        _settle(id, p);
        amount = p.amount;
        address owner = p.owner;

        totalWeight -= Math.mulDiv(amount, p.weightBps, BPS);
        staked -= amount;
        delete positions[id];

        IERC20(houseToken).safeTransfer(owner, amount);
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
        totalWeight = totalWeight - oldWeight + newWeight;
        p.weightBps = base;
        for (uint256 i; i < rewardAssets.length; ++i) {
            address asset = rewardAssets[i];
            rewardDebt[id][asset] = Math.mulDiv(newWeight, accRewardPerWeight[asset], ACC_PRECISION);
        }
        emit Demoted(id, base);
    }

    function _settle(uint256 id, Position storage p) internal {
        uint256 weight = Math.mulDiv(p.amount, p.weightBps, BPS);
        uint256 assets = rewardAssets.length;
        for (uint256 i; i < assets; ++i) {
            address asset = rewardAssets[i];
            uint256 total = Math.mulDiv(weight, accRewardPerWeight[asset], ACC_PRECISION);
            uint256 debt = rewardDebt[id][asset];
            if (total <= debt) continue;
            uint256 amount = total - debt;
            rewardDebt[id][asset] = total;
            accounted[asset] -= amount;
            PairTransfer.push(asset, p.owner, amount);
            emit Claimed(id, p.owner, asset, amount);
        }
    }
}
