import { SITE } from "@/lib/site";

/// The Safe App manifest. Safe{Wallet} reads this from its own origin before it will list or open
/// hood.fam inside a Safe, which is why the route sends the CORS header (next.config.mjs) and why
/// it is a route rather than a static file: the icon and the name follow the deployment's own host.
export const dynamic = "force-static";

export function GET() {
  return Response.json({
    name: "hood.fam",
    description: "Launch a token on Robinhood Chain, trade it, and take a share of what the protocol earns.",
    iconPath: "icon.svg",
    // Web app manifest fields, for a browser that reads the same file.
    short_name: "hood.fam",
    start_url: SITE,
    display: "standalone",
    background_color: "#090909",
    theme_color: "#B8FF3C",
    icons: [{ src: "/icon.svg", sizes: "any", type: "image/svg+xml" }],
  });
}
