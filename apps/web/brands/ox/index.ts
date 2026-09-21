import type { Brand } from "../types";
import { Shell } from "./Shell";
import { Explore } from "./Explore";
import { Wordmark } from "./Wordmark";

export const brand: Brand = {
  id: "ox",
  name: "ox.family",
  host: "ox.family",
  tagline: "Launch. Trade. Share the fees.",
  description:
    "Launch and trade tokens on Robinhood Chain. Eligible activity earns season points toward a share of collected fees; creators choose where their fee share goes.",
  Wordmark,
  nav: [
    { href: "/", label: "Discover" },
    { href: "/launch", label: "Create token" },
    { href: "/portfolio", label: "Portfolio" },
    { href: "/leaderboard", label: "Leaderboard" },
    { href: "/lock", label: "Lock" },
    { href: "/airdrop", label: "Season drop" },
    { href: "/bridge", label: "Bridge" },
      { href: "/quests", label: "Quests" },
    { href: "/refer", label: "Refer" },
    { href: "/following", label: "Following" },
],
  copy: {
    create: "Create token",
    heroAction: "Launch a token on Robinhood Chain",
    board: "Discover",
    drop: "Season drop",
    footnote: "ox.family never takes custody of your funds.",
  },
  Shell,
  Explore,
};
