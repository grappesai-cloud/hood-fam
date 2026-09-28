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
