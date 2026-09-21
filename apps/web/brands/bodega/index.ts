import type { Brand } from "../types";
import { Shell } from "./Shell";
import { Explore } from "./Explore";
import { Wordmark } from "./Wordmark";

/// The second face: the corner shop. Same chain, same contracts, none of the terminal. A narrow
/// column, serif headings, and every launch explained in a sentence instead of drawn as a gauge,
/// for the reader who does not read charts and should not have to start.
///
/// The routes are the same seven as hood.fam, because they are the same product; only the words on
/// them change, which is the whole argument of `brands/types.ts`.
export const brand: Brand = {
  id: "bodega",
  name: "Bodega",
  host: "bodega.grappes.dev",
  tagline: "The corner shop for new coins.",
  description:
    "A shop for new coins on Robinhood Chain. Everything on the shelf is explained in one plain sentence, so you can tell what a thing is without reading a chart.",
  Wordmark,
  nav: [
    { href: "/", label: "The shop" },
    { href: "/launch", label: "Open a coin" },
    { href: "/portfolio", label: "Your shelf" },
    { href: "/creator", label: "Your counter" },
    { href: "/leaderboard", label: "Selling best" },
    { href: "/lock", label: "The safe" },
    { href: "/airdrop", label: "The share out" },
      { href: "/quests", label: "Errands" },
    { href: "/refer", label: "Tell a friend" },
    { href: "/following", label: "Regulars" },
],
  copy: {
    create: "Open a coin",
    heroAction: "Open a coin and put it on the shelf.",
    board: "The shop",
    drop: "The share out",
    footnote: "Bodega holds none of your money and tells nobody what to buy.",
  },
  Shell,
  Explore,
};
