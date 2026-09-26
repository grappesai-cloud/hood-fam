import type { ComponentType, ReactNode } from "react";

/// One launchpad, several faces.
///
/// The chain, the contracts, the indexer and the API are one system; what sits on top of them can be
/// more than one product. A brand here is a whole front: its own name, its own wordmark, its own
/// chrome, its own way of laying a market out, its own voice. What it is NOT is a colour swap. The
/// palette is the same across all of them by decision (near black, one accent); the differences are
/// structure, type and language, because that is what makes two sites feel like different places.
///
/// Everything underneath stays shared and is never copied into a brand: `lib/api` (the indexer),
/// `lib/config` (wallets and addresses), `lib/safe` (Safes), the trade boxes, the launch forms, the
/// admin desk. A brand that needed its own copy of those would be a fork, not a face.
///
/// Which brand a build is comes from `brands/current.ts`, written by `npm run brand -- <id>`, so a
/// build carries exactly one brand's code and one brand's stylesheet. Nothing is decided at runtime.

export interface BrandNavItem {
  href: string;
  label: string;
}

export interface Brand {
  /// Lowercase, no spaces: the build flag, the `data-brand` attribute and the stylesheet's scope.
  id: string;
  /// What it calls itself, in running text and in the tab.
  name: string;
  /// The subdomain it is served from, for share cards and the Safe App manifest.
  host: string;
  /// One line under the name, and the description a share card carries.
  tagline: string;
  description: string;
  /// The mark. An SVG or styled text; it appears in the chrome and on the share card.
  Wordmark: ComponentType<{ className?: string }>;
  /// The pages this brand offers, in its own order and its own words.
  nav: BrandNavItem[];
  /// The words that differ between brands: the same action, said the way this one says it.
  copy: {
    /// What "launch a token" is called here.
    create: string;
    /// The call to action on the front page.
    heroAction: string;
    /// What the board of live launches is called.
    board: string;
    /// What the season revenue share is called.
    drop: string;
    /// The drop page's own title, when a brand names it. Without one the page says "The drop".
    dropTitle?: string;
    /// The line in the footer, after the risk warning.
    footnote: string;
  };
  /// The chrome: header, footer, background. It wraps every page.
  Shell: ComponentType<{ children: ReactNode }>;
  /// The front page. A brand that does not bring one gets the default board.
  Explore?: ComponentType;
}
