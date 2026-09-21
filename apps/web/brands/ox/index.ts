import type { Brand } from "../types";
import { Shell } from "./Shell";
import { Explore } from "./Explore";
import { Wordmark } from "./Wordmark";

export const brand: Brand = {
  id: "ox",
  name: "ox.family",
  host: "ox.family",
  tagline: "Launch on the curve. Graduate to the market.",
  description:
    "Create and trade community tokens on Robinhood Chain. Fair curves, automatic graduation and permanently locked liquidity.",
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
