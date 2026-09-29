import type { Metadata } from "next";
import { API } from "@/lib/config";
import { brand } from "@/brands";

/// A launchpad's viral unit is the token page, not the home page: what gets pasted into a chat is
/// `/token/0x...`, and without this it unfurls as the site's own title with no picture. The page
/// itself is a client component, so the card lives in a server layout around it, reading the same
/// indexer the page does. An indexer that does not answer falls back to the generic card rather
/// than failing the render.
///
/// The picture is not set here. `opengraph-image.tsx` and `twitter-image.tsx` in this folder draw
/// one, so this only has to say the words that go beside it.
export async function generateMetadata({ params }: { params: Promise<{ address: string }> }): Promise<Metadata> {
  const { address } = await params;
  try {
    const res = await fetch(`${API}/tokens/${address}`, { next: { revalidate: 30 } });
    if (!res.ok) throw new Error(String(res.status));
    const t = (await res.json()) as {
      name?: string; symbol?: string; description?: string; image?: string;
      mode?: string; status?: string;
    };
    const title = t.symbol ? `${t.name} ($${t.symbol}) on ${brand.name}` : brand.name;
    const machine = t.mode === "direct" ? "the whole supply in the pool from block one" : "on the curve";
    const description = t.description?.trim()
      || `${t.name ?? "A token"} on Robinhood Chain, ${t.status === "graduated" ? "graduated into a locked pool" : machine}.`;
    return {
      title,
      description,
      openGraph: { title, description, type: "website" },
      // The drawn card is a wide one, so the card type has to say so: the root layout asks for a
      // `summary`, and X would letterbox a 1200x630 image into a thumbnail under it.
      twitter: { card: "summary_large_image", title, description },
    };
  } catch {
    return { title: brand.name, description: "A launchpad on Robinhood Chain." };
  }
}

export default function TokenLayout({ children }: { children: React.ReactNode }) {
  return children;
}
