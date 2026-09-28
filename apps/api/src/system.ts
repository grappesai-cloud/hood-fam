import { zeroAddress } from "viem";

/// Our own contracts trade, and they must never score.
///
/// The factory buys for a creator inside the launch, the fee router buys on a buyback, the
/// graduator swaps into the pool, the portal opens one. A wallet on this list is a piece of the
/// machine, not a person, and every points path filters against it: the indexer for trades, the
/// stake accrual for positions the machine holds on somebody's behalf.
export const SYSTEM = new Set(
  [
    process.env.HOOD_FACTORY, process.env.HOOD_STAKING, process.env.HOOD_FEE_ROUTER,
    process.env.HOOD_GRADUATOR, process.env.HOOD_PORTAL, process.env.HOOD_BUYBACK_MODULE,
    // The Bag and its outlets: the burn clock buys the house coin, Payday and the pots pay wallets,
    // the auction takes bids. None of them is a person.
    process.env.HOOD_BAG, process.env.HOOD_PAYDAY, process.env.HOOD_BURN_CLOCK, process.env.HOOD_BOOSTS,
    process.env.HOOD_GRADUATION_HOOK, process.env.HOOD_OPENING_AUCTION,
    // The block-zero periphery buys for team wallets inside a launch; the wallets are people, it is not.
    process.env.HOOD_BLOCK_ZERO,
    "0x8366a39cc670b4001a1121b8f6a443a643e40951", // the PoolManager
    "0x8876789976decbfcbbbe364623c63652db8c0904", // the UniversalRouter
    zeroAddress,
  ]
    .filter(Boolean)
    .map((a) => (a as string).toLowerCase()),
);

export const isSystem = (address: string) => SYSTEM.has(address.toLowerCase());
