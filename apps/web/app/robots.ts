import type { MetadataRoute } from "next";
import { CANONICAL, SITE } from "@/lib/site";

/// Everything on the real site is public except the operator screens. `/admin` is behind a token
/// anyway, so that line is about keeping it out of a search index, not about keeping it safe.
///
/// Anywhere else this build runs is a preview, and a preview asks to be left out of the index
/// entirely: it is the same site under a name that should never outrank the real one.
export default function robots(): MetadataRoute.Robots {
  if (!CANONICAL) return { rules: [{ userAgent: "*", disallow: "/" }] };
  return {
    rules: [{ userAgent: "*", allow: "/", disallow: "/admin" }],
    sitemap: `${SITE}/sitemap.xml`,
  };
}
