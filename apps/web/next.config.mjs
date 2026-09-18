/** @type {import('next').NextConfig} */
export default {
  reactStrictMode: true,
  // The app talks to its own indexer, which is deployed beside it. No third party in the data path.
  env: { NEXT_PUBLIC_BUILD: new Date().toISOString() },
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
