import type { MetadataRoute } from "next";
import { SITE } from "@/lib/site";

/// The API base is read straight from the environment here rather than from `lib/config`, because
/// that module builds the wagmi config at import time and a metadata route has no business pulling
/// a wallet stack into the build. The default matches `lib/config`; `SITE` comes from `lib/site`,
/// which is free of the same weight.
const API = process.env.NEXT_PUBLIC_API_URL ?? "http://127.0.0.1:8080";

/// Fifteen minutes is enough for a launchpad: a token that launched a minute ago is on the board
/// and in every share link long before a crawler asks for the sitemap again.
export const revalidate = 900;

const STATIC: { path: string; priority: number; changeFrequency: MetadataRoute.Sitemap[number]["changeFrequency"] }[] = [
  { path: "/", priority: 1, changeFrequency: "hourly" },
  { path: "/launch", priority: 0.9, changeFrequency: "weekly" },
  { path: "/portfolio", priority: 0.5, changeFrequency: "daily" },
  { path: "/creator", priority: 0.5, changeFrequency: "daily" },
  { path: "/leaderboard", priority: 0.7, changeFrequency: "hourly" },
  { path: "/airdrop", priority: 0.8, changeFrequency: "hourly" },
  { path: "/bridge", priority: 0.6, changeFrequency: "weekly" },
  { path: "/analytics", priority: 0.7, changeFrequency: "hourly" },
  { path: "/bag", priority: 0.7, changeFrequency: "hourly" },
  { path: "/terms", priority: 0.3, changeFrequency: "yearly" },
  { path: "/privacy", priority: 0.3, changeFrequency: "yearly" },
];

interface Listed {
  token: string;
  launched_at?: string | null;
  graduated_at?: string | null;
}

/// The token pages are the ones that get pasted into chats, so they belong in here. An indexer
/// that does not answer is not a reason to serve no sitemap at all: the static routes still go out.
async function tokens(): Promise<Listed[]> {
  try {
    const res = await fetch(`${API}/tokens?limit=100`, { next: { revalidate } });
    if (!res.ok) return [];
    const body = (await res.json()) as { tokens?: Listed[] };
    return Array.isArray(body.tokens) ? body.tokens : [];
  } catch {
    return [];
  }
}

function at(value: string | null | undefined, fallback: Date): Date {
  if (!value) return fallback;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? fallback : d;
}

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const now = new Date();
  const list = await tokens();

  return [
    ...STATIC.map((s) => ({
      url: `${SITE}${s.path}`,
      lastModified: now,
      changeFrequency: s.changeFrequency,
      priority: s.priority,
    })),
    ...list
      .filter((t) => typeof t.token === "string" && t.token.startsWith("0x"))
      .map((t) => ({
        url: `${SITE}/token/${t.token}`,
        lastModified: at(t.graduated_at ?? t.launched_at, now),
        changeFrequency: "hourly" as const,
        priority: 0.6,
      })),
  ];
}
