import type { Brand } from "../types";
import { Shell } from "./Shell";
import { Wordmark } from "./Wordmark";

/// The first face: lit glass, a market tape, a coin on the front page.
export const brand: Brand = {
  id: "hood",
  name: "hood.fam",
  host: "hood.grappes.dev",
  tagline: "What the house takes, the fam gets back.",
  description: "A launchpad on Robinhood Chain. What the house takes, the fam gets back.",
  Wordmark,
  nav: [
    { href: "/", label: "Explore" },
    { href: "/launch", label: "Create" },
    { href: "/portfolio", label: "Portfolio" },
    { href: "/creator", label: "Creator" },
    { href: "/leaderboard", label: "Leaderboard" },
    { href: "/airdrop", label: "The drop" },
    { href: "/bridge", label: "Bridge" },
  ],
  copy: {
    create: "Create token",
    heroAction: "Print a coin. Let the fam trade it.",
    board: "Explore",
    drop: "The drop",
    footnote: "hood.fam holds no funds and gives no financial advice.",
  },
  Shell,
};
