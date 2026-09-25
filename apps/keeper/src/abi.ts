import { parseAbi } from "viem";

/// The Bag v3 contracts, declared here from the frozen interfaces in src/interfaces and
/// src/bag/BagTypes.sol. The SDK's generated ABIs are regenerated later by another worker; until
/// then these fragments are the keeper's view of the new contracts. Keep every signature byte for
/// byte with the .sol file it names.

/// src/interfaces/IHoodPayday.sol
export const paydayAbi = parseAbi([
  "function epoch() view returns (uint64)",
  "function keeper() view returns (address)",
  "function fund(address asset, uint256 amount) payable",
  "function pay(uint64 epoch_, address asset, address[] wallets, uint256[] amounts, address[] pots, uint256[] potAmounts)",
  "function funded(uint64 epoch_, address asset) view returns (uint256)",
  "function paid(uint64 epoch_, address asset) view returns (uint256)",
  "function carried(address asset) view returns (uint256)",
  "event Funded(uint64 indexed epoch, address indexed asset, uint256 amount)",
  "event Paid(uint64 indexed epoch, address indexed asset, address indexed wallet, uint256 amount)",
  "event LaunchSlice(uint64 indexed epoch, address indexed asset, address indexed pot, uint256 amount)",
  "event EpochPaid(uint64 indexed epoch, address indexed asset, uint256 toWallets, uint256 toLaunches, uint256 carried)",
  "event KeeperSet(address keeper)",
]);

/// src/interfaces/IHoodBurnClock.sol
export const burnClockAbi = parseAbi([
  "function houseCoin() view returns (address)",
  "function keeper() view returns (address)",
  "function fund(address asset, uint256 amount) payable",
  "function burn(address asset, uint256 maxSpend, uint256 minOut) returns (uint256 spent, uint256 burned)",
  "function balanceOf(address asset) view returns (uint256)",
  "function totalSpent(address asset) view returns (uint256)",
  "function totalBurned() view returns (uint256)",
  "event Funded(address indexed asset, uint256 amount)",
  "event Burned(address indexed asset, uint256 spent, uint256 coinBurned, uint64 indexed epoch)",
  "event HouseCoinSet(address coin)",
  "event KeeperSet(address keeper)",
]);

/// src/interfaces/IHoodPot.sol. A curve launch's pot and a direct launch's splitter both answer it.
export const potAbi = parseAbi([
  "function token() view returns (address)",
  "function asset() view returns (address)",
  "function depositForHolders(uint256 amount, bytes32 reason, address payer) payable",
  "function pending(address account) view returns (uint256)",
  "function claim(address account) returns (uint256 amount)",
  "function pushMany(address[] accounts, uint256 floor) returns (uint256 paid, uint256 count)",
  "function totalDeposited() view returns (uint256)",
  "function totalPaid() view returns (uint256)",
  "event HoldersPaid(bytes32 indexed reason, address indexed payer, uint256 amount, uint256 eligibleSupply)",
  "event Pushed(address indexed account, uint256 amount)",
]);

/// src/interfaces/IHoodBoosts.sol. The keeper only reads it (the board's hour), users buy slots.
export const boostsAbi = parseAbi([
  "function SLOTS() view returns (uint8)",
  "function slotPrice() view returns (uint256)",
  "function epoch() view returns (uint64)",
  "function buy(address token, uint64 hourEpoch, uint8 slot) payable",
  "function boosted(uint64 hourEpoch) view returns (address[])",
  "function slotOf(uint64 hourEpoch, uint8 slot) view returns (address token, address buyer)",
  "event BoostBought(address indexed token, address indexed buyer, uint64 indexed hourEpoch, uint8 slot, uint256 paid)",
  "event SlotPriceSet(uint256 price)",
]);

/// src/interfaces/IHoodBag.sol. BagSource and BagOutlet are uint8 on the wire.
export const bagAbi = parseAbi([
  "function releaseHeld(address asset)",
  "function house() view returns (address)",
  "function vault() view returns (address)",
  "function payday() view returns (address)",
  "function burnClock() view returns (address)",
  "function totalIn(address asset, uint8 source) view returns (uint256)",
  "function totalOut(address asset, uint8 outlet) view returns (uint256)",
  "function heldForVault(address asset) view returns (uint256)",
  "function heldForBurn(address asset) view returns (uint256)",
  "event BagIn(uint8 indexed source, address indexed asset, uint256 amount, address indexed token)",
  "event BagOut(uint8 indexed outlet, address indexed asset, uint256 amount, address indexed to)",
  "event Held(uint8 indexed outlet, address indexed asset, uint256 amount)",
]);

/// King of the hill, on the direct machine's revenue splitter: src/direct/HoodRevenueSplitter.sol.
/// `kingEndsAt` is a unix timestamp; past it, with a pot, `settleKing` pays the king.
export const kingAbi = parseAbi([
  "function king() view returns (address)",
  "function kingPot() view returns (uint256)",
  "function kingEndsAt() view returns (uint64)",
  "function KING_TIMER() view returns (uint64)",
  "function settleKing() returns (uint256 amount)",
  "event KingCrowned(address indexed king, uint256 pot, uint64 endsAt)",
  "event KingWon(address indexed king, uint256 amount)",
  "event KingPotFed(uint256 amount, uint256 pot)",
  "event CreatorSlashed(address indexed creator, uint256 amount)",
]);

/// The shared opening auction, keyed by token: src/direct/HoodOpeningAuction.sol. The keeper only
/// settles; `auctionOf` is the book it can check a stale list against.
export const openingAuctionAbi = parseAbi([
  "function settle(address token)",
  "function auctionOf(address token) view returns ((address quote, address splitter, address locker, uint64 endBlock, uint256 minBid, address bidder, uint256 amount, bool settled))",
  "event Registered(address indexed token, uint64 endBlock, uint256 minBid)",
  "event Bid(address indexed token, address indexed bidder, uint256 amount, uint64 endBlock)",
  "event Settled(address indexed token, address indexed winner, uint256 amount, uint256 toHolders, uint256 toLiquidity)",
  "event RefundBooked(address indexed asset, address indexed bidder, uint256 amount)",
  "event RefundClaimed(address indexed asset, address indexed bidder, uint256 amount)",
]);

/// The direct machine's per-launch hook asks for a buyback out loud (worker C3).
export const launchHookBagAbi = parseAbi([
  "event Penalty(bytes32 indexed reason, address indexed payer, uint256 amount, uint256 toHolders, uint256 toBag, bool isBuy)",
  "event BuybackTriggered(uint256 spent, uint256 burned)",
  "event BuybackWanted(address token)",
]);
