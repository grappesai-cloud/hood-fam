// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {ERC20Upgradeable} from "./lib/ERC20Upgradeable.sol";
import {Socials} from "./DirectTypes.sol";

interface IDividends {
    function syncBalances(address from, address to, uint256 fromBalance, uint256 toBalance) external;
}

/// @title HoodLaunchToken
/// @notice The token a direct launch prints: fixed supply, no owner, no mint, no transfer tax.
/// @dev Deployed as an EIP-1167 clone, so printing one costs a fraction of deploying one.
///
///      Two things live in `_update` and nothing else does:
///
///      1. The opening window. In the launch block only the creator may receive tokens out of the
///         pool, and for `restrictionsEndBlock` after it no wallet may end up holding more than
///         `maxHoldBps` of supply or buy more than `maxBuyBps` of it out of the pool. The hold cap
///         applies to plain transfers too, or a bot would buy from ten wallets and consolidate;
///         selling is never restricted, and every limit expires on its own. This is the shape
///         Pons uses, and it is the only thing standing between a fair open and one bot.
///
///      2. Dividend accounting. Holders are paid from a per-share accumulator, which has to know
///         when balances move. The call out cannot revert a transfer: it is a plain bookkeeping
///         write in a contract with no owner.
contract HoodLaunchToken is ERC20Upgradeable {
    address public portal;
    address public creator;
    address public pool;
    address public dividends;

    string public logo;
    string public description;
    Socials internal _socials;

    uint64 public launchBlock;
    uint64 public restrictionsEndBlock;
    uint128 public maxHold;
    uint128 public maxBuy;

    mapping(address => uint256) public boughtDuringWindow;
    mapping(address => bool) public exempt;

    error AlreadyInitialized();
    error NotPortal();

    /// @dev The implementation behind the clones must never be initializable itself.
    constructor() {
        portal = address(1);
    }
    error LaunchBlockIsTheCreators();
    error HoldsTooMuch();
    error BuysTooMuch();

    function initialize(
        string calldata name_,
        string calldata symbol_,
        string calldata logo_,
        string calldata description_,
        Socials calldata socials_,
        uint256 supply,
        address creator_,
        uint64 restrictionBlocks,
        uint16 maxHoldBps,
        uint16 maxBuyBps
    ) external {
        if (portal != address(0)) revert AlreadyInitialized();
        portal = msg.sender;
        creator = creator_;
        logo = logo_;
        description = description_;
        _socials = socials_;
        launchBlock = uint64(block.number);
        restrictionsEndBlock = uint64(block.number) + restrictionBlocks;
        maxHold = uint128((supply * maxHoldBps) / 10_000);
        maxBuy = uint128((supply * maxBuyBps) / 10_000);
        // The portal holds the supply for the length of the launch transaction. The creator is
        // NOT exempt: the launch block is theirs alone, and after that they hold what anyone may.
        exempt[msg.sender] = true;

        __ERC20_init(name_, symbol_);
        _mint(msg.sender, supply);
    }

    /// @notice Called once by the portal, after the pool and the splitter exist.
    function setLaunchAddresses(address pool_, address dividends_, address locker, address hook, address buybackModule)
        external
    {
        if (msg.sender != portal) revert NotPortal();
        if (pool != address(0)) revert AlreadyInitialized();
        pool = pool_;
        dividends = dividends_;
        exempt[pool_] = true;
        exempt[dividends_] = true;
        exempt[locker] = true;
        exempt[hook] = true;
        // holds tokens for the length of one instruction, on their way to being burned
        exempt[buybackModule] = true;
    }

    function socials() external view returns (Socials memory) {
        return _socials;
    }

    function liquidityPool() external view returns (address) {
        return pool;
    }

    function burn(uint256 amount) external {
        _burn(msg.sender, amount);
    }

    function _update(address from, address to, uint256 value) internal override {
        _enforceOpeningWindow(from, to, value);
        super._update(from, to, value);

        address d = dividends;
        if (d != address(0)) {
            IDividends(d).syncBalances(from, to, from == address(0) ? 0 : balanceOf(from), to == address(0) ? 0 : balanceOf(to));
        }
    }

    function _enforceOpeningWindow(address from, address to, uint256 value) internal {
        // Zero blocks means the creator asked for no opening window at all, launch block included.
        if (restrictionsEndBlock == launchBlock) return;
        if (block.number > restrictionsEndBlock) return;
        if (to == address(0) || exempt[to]) return;

        bool fromPool = from == pool && pool != address(0);
        if (fromPool && block.number == launchBlock && to != creator) revert LaunchBlockIsTheCreators();

        if (balanceOf(to) + value > maxHold) revert HoldsTooMuch();

        if (fromPool) {
            uint256 bought = boughtDuringWindow[to] + value;
            if (bought > maxBuy) revert BuysTooMuch();
            boughtDuringWindow[to] = bought;
        }
    }
}
