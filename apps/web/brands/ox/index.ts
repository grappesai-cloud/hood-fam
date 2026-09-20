import type { Brand } from "../types";
import { Shell } from "./Shell";
import { Explore } from "./Explore";
import { Wordmark } from "./Wordmark";

/// The second face: a market terminal that happens to be a launchpad.
///
/// Same chain, same contracts, same indexer. What this front assumes is a different reader: one who
/// already parses addresses, wants sixty launches on one screen rather than eight pictures, and
/// reaches for the keyboard before the mouse. So there is no hero, no artwork and no card. There is
/// a header line, a table, and a footer line.
///
/// The words are lower case on purpose. A terminal does not capitalise its own commands, and the
/// routes are written as paths because that is what this reader would have typed anyway.
export const brand: Brand = {
  id: "ox",
  name: "0x.fam",
  host: "0x.grappes.dev",
  tagline: "Addresses, not adjectives.",
  description:
    "Every launch on Robinhood Chain as one line of data: cap, volume, progress to the pool, age and address.",
  Wordmark,
  nav: [
    { href: "/", label: "/explore" },
    { href: "/launch", label: "/create" },
    { href: "/portfolio", label: "/portfolio" },
    { href: "/creator", label: "/creator" },
    { href: "/leaderboard", label: "/board" },
    { href: "/airdrop", label: "/drop" },
    { href: "/bridge", label: "/bridge" },
  ],
  copy: {
    create: "deploy token",
    heroAction: "Deploy a token. Read the tape.",
    board: "Tape",
    drop: "Season split",
    footnote: "0x.fam holds no funds and gives no financial advice.",
  },
  Shell,
  Explore,
};
