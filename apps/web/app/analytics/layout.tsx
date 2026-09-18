import type { Metadata } from "next";

/// The page itself is a client component, so its share card and its title live here.
export const metadata: Metadata = {
  title: "analytics · hood.fam",
  description: "Launches, graduations, volume, trades and the season pool, counted by our own indexer.",
  openGraph: {
    title: "analytics · hood.fam",
    description: "Launches, graduations, volume, trades and the season pool, counted by our own indexer.",
    type: "website",
  },
};

export default function AnalyticsLayout({ children }: { children: React.ReactNode }) {
  return children;
}
