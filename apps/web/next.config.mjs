/// A Content-Security-Policy that fits a wallet dApp rather than fighting it.
/// - `frame-ancestors` is the point: the app has a Connect button and one-click trade, and a page
///   that can be framed can be clickjacked into either. Exactly one origin may frame it,
///   app.safe.global, because that is how a Safe uses hood.fam: Safe{Wallet} opens it as a Safe App
///   in an iframe and the wallet on the other side is the Safe itself. `X-Frame-Options` is gone
///   rather than set to DENY: it has no allow-list, and a browser that honours it would contradict
///   the CSP (browsers that support `frame-ancestors` ignore the header, but not all do).
/// - `img-src` has to be open: token artwork is a URL a stranger typed at launch, on any host, so
///   locking it down would break the board. `javascript:` never matches an img-src of hosts, so
///   an artwork field cannot smuggle script even here.
/// - `script-src 'self' 'unsafe-inline'`: Next's hydration bootstrap is inline. The inline allowance
///   is the weak link, but React already escapes every value the app renders, so CSP here is the
///   second line, and its real job on this app is frame-ancestors and object-src, not script-src.
/// - `connect-src` is wide because the wallet talks to whatever RPC and indexer a deployment sets,
///   and WalletConnect reaches its own relays; a fixed list would break a self-hosted deploy.
const CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https: http:",
  "font-src 'self' data:",
  "connect-src 'self' https: http: wss: ws:",
  // Plus whatever a self-hosted Safe{Wallet} is served from (NEXT_PUBLIC_SAFE_APP_ORIGINS).
  `frame-ancestors 'self' https://app.safe.global ${(process.env.NEXT_PUBLIC_SAFE_APP_ORIGINS ?? "").split(",").map((o) => o.trim()).filter(Boolean).join(" ")}`.trim(),
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
].join("; ");

const SECURITY_HEADERS = [
  { key: "Content-Security-Policy", value: CSP },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=()" },
  // HSTS is safe to always send: a browser only honours it over HTTPS, and every real deployment of
  // this is behind TLS. A year, with subdomains, is the usual floor.
  { key: "Strict-Transport-Security", value: "max-age=31536000; includeSubDomains" },
];

/** @type {import('next').NextConfig} */
export default {
  reactStrictMode: true,
  // Local design work can run beside a production build or the screenshot harness. Giving the
  // dev server its own dist directory prevents `next build` from replacing files underneath a
  // running `next dev` process (which otherwise surfaces as a missing routes-manifest and a 500).
  distDir: process.env.NEXT_DIST_DIR || ".next",
  // The app talks to its own indexer, which is deployed beside it. No third party in the data path.
  env: { NEXT_PUBLIC_BUILD: new Date().toISOString() },
  async headers() {
    return [
      { source: "/:path*", headers: SECURITY_HEADERS },
      // Versioned brand art is immutable. Public assets otherwise default to max-age=0, which made
      // the 3D hero arrive again on every navigation and look as if it were being painted in rows.
      { source: "/ox/:asset*.webp", headers: [{ key: "Cache-Control", value: "public, max-age=31536000, immutable" }] },
      // Safe{Wallet} fetches the Safe App manifest from its own origin before it will open the app.
      { source: "/manifest.json", headers: [{ key: "Access-Control-Allow-Origin", value: "*" }] },
    ];
  },
  webpack: (config) => {
    // wagmi's connector bundle reaches for Coinbase's optional x402 payment packages. The app only
    // offers injected wallets and WalletConnect, so stub them rather than pulling a payments SDK
    // into a launchpad.
    config.resolve.alias = {
      ...config.resolve.alias,
      "@x402/evm": false,
      "@x402/svm": false,
      "@x402/core": false,
      // MetaMask's SDK carries a react-native storage import that a web build never reaches.
      "@react-native-async-storage/async-storage": false,
    };
    // The share card is rasterised by `next/og`, which wants the font as bytes in memory. Left
    // alone, webpack turns a font import into a URL under /_next/static, and the renderer would
    // have to fetch the site to draw the site. This bakes the two card faces into the server
    // bundle at build time instead: no request, no path to resolve at runtime, nothing to go
    // missing in a Docker image. Scoped to the one folder so it can never catch a webfont.
    config.module.rules.push({
      test: /\.ttf$/,
      include: /[\\/]lib[\\/]og[\\/]/,
      type: "asset",
      // `asset`, not `asset/inline`: Next sets a filename for every asset module it builds, and
      // the inline type's own options do not allow one, so the two together fail the config
      // schema. An `asset` that always meets its inline condition is the same thing and merges.
      parser: { dataUrlCondition: () => true },
      generator: { dataUrl: (content) => content.toString("base64") },
    });
    return config;
  },
};
