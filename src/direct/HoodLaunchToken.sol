// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {ERC20Upgradeable} from "./lib/ERC20Upgradeable.sol";
import {Socials} from "./DirectTypes.sol";

interface IDividends {
    function syncBalances(address from, address to, uint256 fromBalance, uint256 toBalance) external;
    function slashCreator() external;
    function creator() external view returns (address);
}

interface IOpeningAuctionGate {
    function mayReceive(address token, address to) external view returns (bool);
}

/// @title HoodLaunchToken
/// @notice The token a direct launch prints: fixed supply, no owner, no mint, no transfer tax.
/// @dev Deployed as an EIP-1167 clone, so printing one costs a fraction of deploying one.
///
///      Four things live in `_update` and nothing else does:
///
///      1. The opening window. In the launch block only the creator may receive tokens out of the
///         pool, and for `restrictionsEndBlock` after it no wallet may end up holding more than
///         `maxHoldBps` of supply or buy more than `maxBuyBps` of it out of the pool. The hold cap
///         applies to plain transfers too, or a bot would buy from ten wallets and consolidate;
///         selling is never restricted, and every limit expires on its own. This is the shape
///         Pons uses, and it is the only thing standing between a fair open and one bot.
///
///      2. The sniper auction, when the launch chose one instead of the fair open. After the
///         creator's block the pool stays shut while the first slot is auctioned, then only the
///         winner may buy for twenty blocks, then it opens. The auction contract holds the state;
///         this contract only asks it who may receive, and only while the gate can still be shut.
///
///      3. The creator cannot rug their fees. A transfer from the creator, or from whoever is the
///         current fee recipient, into the pool is a sell, and it moves whatever they had not
///         claimed from the splitter to the holders before the transfer proceeds. The call cannot
///         revert the transfer: a token that can be frozen by its own accountant is not a token.
///
///      4. Dividend accounting. Holders are paid from a per-share accumulator, which has to know
///         when balances move. Same rule: a plain bookkeeping write, never a veto.
contract HoodLaunchToken is ERC20Upgradeable {
    address public portal;
    address public creator;
    address public pool;
    address public dividends;
    /// @notice The shared opening auction, when this launch chose one, and the last block in which
    ///         it can still shut the pool (the auction's end block plus the winner's slot).
    address public auction;
    uint64 public auctionGateEndBlock;

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
    error PoolClosedByAuction();

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

    /// @notice Called once by the portal when the launch chose the sniper auction. `endBlock` is
    ///         the auction's last block; the gate stays live for the winner's slot after it.
    function setOpeningAuction(address auction_, uint64 endBlock, uint64 slotBlocks) external {
        if (msg.sender != portal) revert NotPortal();
        if (auction != address(0)) revert AlreadyInitialized();
        auction = auction_;
        auctionGateEndBlock = endBlock + slotBlocks;
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
        address d = dividends;
        if (d != address(0)) {
            if (to == pool && from != address(0)) _slashIfCreator(from, d);
            super._update(from, to, value);
            IDividends(d).syncBalances(from, to, from == address(0) ? 0 : balanceOf(from), to == address(0) ? 0 : balanceOf(to));
        } else {
            super._update(from, to, value);
        }
    }

    /// @dev A sell by the creator or by the current fee recipient. Both are asked because the
    ///      recipient can be a different wallet than the one that launched.
    function _slashIfCreator(address from, address d) internal {
        bool isCreator = from == creator;
        if (!isCreator) {
            try IDividends(d).creator() returns (address recipient) {
                isCreator = from == recipient;
            } catch {}
        }
        if (isCreator) {
            try IDividends(d).slashCreator() {} catch {}
        }
    }

    function _enforceOpeningWindow(address from, address to, uint256 value) internal {
        if (to == address(0) || exempt[to]) return;
        bool fromPool = from == pool && pool != address(0);

        if (fromPool && block.number <= auctionGateEndBlock) _enforceAuction(to);

        // Zero blocks means the creator asked for no opening window at all, launch block included.
        if (restrictionsEndBlock == launchBlock) return;
        if (block.number > restrictionsEndBlock) return;

        if (fromPool && block.number == launchBlock && to != creator) revert LaunchBlockIsTheCreators();

        if (balanceOf(to) + value > maxHold) revert HoldsTooMuch();

        if (fromPool) {
            uint256 bought = boughtDuringWindow[to] + value;
            if (bought > maxBuy) revert BuysTooMuch();
            boughtDuringWindow[to] = bought;
        }
    }

    /// @dev With an auction the launch block is the creator's whatever the window says, and after
    ///      it the auction decides who may buy until the gate expires on its own.
    function _enforceAuction(address to) internal view {
        if (block.number == launchBlock) {
            if (to != creator) revert LaunchBlockIsTheCreators();
            return;
        }
        if (!IOpeningAuctionGate(auction).mayReceive(address(this), to)) revert PoolClosedByAuction();
    }
}
