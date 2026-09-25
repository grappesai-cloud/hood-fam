import type { Brand } from "../types";
import { Shell } from "./Shell";
import { Wordmark } from "./Wordmark";
import Explore from "./Explore";

/// The second face: the trader's screen. Same chain, same contracts, same indexer; what changes is
/// that nothing here is sold to you. A launch is a row, the row is mostly numbers, and the only
/// colour on the page is the length of the ladder each launch has climbed.
export const brand: Brand = {
  id: "klimb",
  name: "Klimb",
  host: "klimb.grappes.dev",
  tagline: "Every launch is a row, and every row is climbing.",
  description:
    "A launchpad on Robinhood Chain read as a ladder: every launch is one row, with its price, its volume and how far it has climbed towards its pool.",
  Wordmark,
  nav: [
    { href: "/", label: "Market" },
    { href: "/launch", label: "New listing" },
    { href: "/portfolio", label: "Positions" },
    { href: "/creator", label: "Issuer desk" },
    { href: "/leaderboard", label: "Rankings" },
    { href: "/lock", label: "The vault" },
    { href: "/airdrop", label: "Season payout" },
      { href: "/quests", label: "Objectives" },
    { href: "/refer", label: "Introduce" },
    { href: "/following", label: "Watchlist" },
    { href: "/ledger", label: "Ledger" },
    { href: "/bag", label: "The Bag" },
],
  copy: {
    create: "List a token",
    heroAction: "Read the column. Trade the climb.",
    board: "Market",
    drop: "Season payout",
    footnote: "Klimb holds no funds and gives no financial advice.",
  },
  Shell,
  Explore,
};
