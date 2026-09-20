import type { Brand } from "../types";
import { Shell } from "./Shell";
import { Wordmark } from "./Wordmark";
import Explore from "./Explore";

/// The second face: the trading pit. Same chain, same contracts, same numbers, said out loud.
///
/// Where hood.fam lights a room and lets the launches float in it, this one prints them. The words
/// below are the same seven destinations in the language of a floor, because the difference between
/// two products is what they call things, not which hex they are painted.
export const brand: Brand = {
  id: "pit",
  name: "PIT",
  host: "pit.grappes.dev",
  tagline: "Every ticker on one floor, out loud.",
  description: "A launchpad on Robinhood Chain. Every ticker on one floor, out loud.",
  Wordmark,
  nav: [
    { href: "/", label: "Floor" },
    { href: "/launch", label: "Print" },
    { href: "/portfolio", label: "Book" },
    { href: "/creator", label: "Desk" },
    { href: "/leaderboard", label: "Standings" },
    { href: "/airdrop", label: "The cut" },
    { href: "/bridge", label: "Bridge" },
  ],
  copy: {
    create: "Print a ticker",
    heroAction: "Print a ticker. Let the floor fight over it.",
    board: "Floor",
    drop: "The cut",
    footnote: "PIT holds no funds and gives no financial advice.",
  },
  Shell,
  Explore,
};
