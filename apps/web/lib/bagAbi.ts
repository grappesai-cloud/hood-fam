import { parseAbi } from "viem";

/// The Bag's contracts, as the web reads and writes them. Written by hand from the frozen
/// interfaces in src/interfaces and the direct machine's brief, because the SDK's generated ABIs
/// are regenerated after the contracts land and the pages cannot wait for that. Each fragment is
/// the exact signature the interface declares; a mismatch fails at the call, not silently.

/// IHoodBoosts: hourly slots on the board, bought in native currency.
export const hoodBoostsAbi = parseAbi([
  "function SLOTS() view returns (uint8)",
  "function slotPrice() view returns (uint256)",
  "function epoch() view returns (uint64)",
  "function buy(address token, uint64 hourEpoch, uint8 slot) payable",
  "function boosted(uint64 hourEpoch) view returns (address[])",
  "function slotOf(uint64 hourEpoch, uint8 slot) view returns (address token, address buyer)",
  "event BoostBought(address indexed token, address indexed buyer, uint64 indexed hourEpoch, uint8 slot, uint256 paid)",
  "event SlotPriceSet(uint256 price)",
]);

/// The king-of-the-hill surface on a direct launch's revenue splitter, as
/// src/direct/HoodRevenueSplitter.sol has it. The timer is `kingEndsAt`, a unix timestamp; when it
/// has passed and the pot is not empty, anybody can settle and the king is paid.
export const hoodKingAbi = parseAbi([
  "function king() view returns (address)",
  "function kingPot() view returns (uint256)",
  "function kingEndsAt() view returns (uint64)",
  "function KING_TIMER() view returns (uint64)",
  "function settleKing() returns (uint256 amount)",
  "event KingCrowned(address indexed king, uint256 pot, uint64 endsAt)",
  "event KingWon(address indexed king, uint256 amount)",
  "event KingPotFed(uint256 amount, uint256 pot)",
]);

/// The shared opening auction, keyed by token, as src/direct/HoodOpeningAuction.sol has it. A bid
/// is `amount` of the launch's quote: sent as value when the quote is native, pulled after an
/// approval otherwise. A refund that could not be delivered is booked under (asset, bidder).
export const hoodOpeningAuctionAbi = parseAbi([
  "function bid(address token, uint256 amount) payable",
  "function settle(address token)",
  "function claimRefund(address asset) returns (uint256 amount)",
  "function refunds(address asset, address bidder) view returns (uint256)",
  "function firstSlot(address token) view returns (address)",
  "function mayReceive(address token, address to) view returns (bool)",
  "function auctionOf(address token) view returns ((address quote, address splitter, address locker, uint64 endBlock, uint256 minBid, address bidder, uint256 amount, bool settled))",
  "function minimumBid(address token) view returns (uint256)",
  "function SLOT_BLOCKS() view returns (uint64)",
  "function MIN_RAISE_BPS() view returns (uint256)",
  "event Registered(address indexed token, uint64 endBlock, uint256 minBid)",
  "event Bid(address indexed token, address indexed bidder, uint256 amount, uint64 endBlock)",
  "event Settled(address indexed token, address indexed winner, uint256 amount, uint256 toHolders, uint256 toLiquidity)",
  "event RefundBooked(address indexed asset, address indexed bidder, uint256 amount)",
  "event RefundClaimed(address indexed asset, address indexed bidder, uint256 amount)",
]);

/// IHoodPot: what a holder can take right now, and the fallback claim. The keeper pushes payouts
/// every five minutes, so the claim is a door that exists rather than a button anybody needs.
export const hoodPotAbi = parseAbi([
  "function token() view returns (address)",
  "function asset() view returns (address)",
  "function pending(address account) view returns (uint256)",
  "function claim(address account) returns (uint256 amount)",
  "function totalDeposited() view returns (uint256)",
  "function totalPaid() view returns (uint256)",
  "event HoldersPaid(bytes32 indexed reason, address indexed payer, uint256 amount, uint256 eligibleSupply)",
  "event Pushed(address indexed account, uint256 amount)",
]);

/// The hour a boost slot is keyed by: `block.timestamp / 1 hours`, computed here from the wall
/// clock for a page that has no chain read to hand.
export function hourEpochNow(): number {
  return Math.floor(Date.now() / 3_600_000);
}
