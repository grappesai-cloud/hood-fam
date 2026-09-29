# The app. Next.js in standalone mode so the runtime image carries no build tooling.
FROM node:22-slim AS build
WORKDIR /app
# wagmi's WebSocket transport pulls native modules (bufferutil) that compile at install time
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
# Which face this image is (apps/web/brands). One image build per subdomain; everything under the
# brand, from the indexer to the Safe handling, is the same code.
ARG BRAND=ox
ARG NEXT_PUBLIC_API_URL
ARG NEXT_PUBLIC_RPC
ARG NEXT_PUBLIC_FACTORY
ARG NEXT_PUBLIC_FEE_ROUTER
ARG NEXT_PUBLIC_STAKING
ARG NEXT_PUBLIC_GRADUATOR
ARG NEXT_PUBLIC_CURVE_ROUTER
ARG NEXT_PUBLIC_BRIDGE_FACTORY
ARG NEXT_PUBLIC_PORTAL
ARG NEXT_PUBLIC_DIRECT_DEPLOYER
ARG NEXT_PUBLIC_BUYBACK_MODULE
ARG NEXT_PUBLIC_SEASON_DROP
ARG NEXT_PUBLIC_BAG
ARG NEXT_PUBLIC_PAYDAY
ARG NEXT_PUBLIC_BURN_CLOCK
ARG NEXT_PUBLIC_BOOSTS
ARG NEXT_PUBLIC_GRADUATION_HOOK
ARG NEXT_PUBLIC_BLOCK_ZERO
# the funder wallets the team console opens to (comma separated); empty closes it
ARG NEXT_PUBLIC_TEAM_WALLETS
ARG NEXT_PUBLIC_HOUSE_COIN
ARG NEXT_PUBLIC_SITE_URL
ARG NEXT_PUBLIC_DEMO
ARG NEXT_PUBLIC_DEMO_WALLET
ARG NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID
ENV NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL NEXT_PUBLIC_RPC=$NEXT_PUBLIC_RPC \
    NEXT_PUBLIC_FACTORY=$NEXT_PUBLIC_FACTORY NEXT_PUBLIC_FEE_ROUTER=$NEXT_PUBLIC_FEE_ROUTER \
    NEXT_PUBLIC_STAKING=$NEXT_PUBLIC_STAKING NEXT_PUBLIC_GRADUATOR=$NEXT_PUBLIC_GRADUATOR \
    NEXT_PUBLIC_CURVE_ROUTER=$NEXT_PUBLIC_CURVE_ROUTER \
    NEXT_PUBLIC_BRIDGE_FACTORY=$NEXT_PUBLIC_BRIDGE_FACTORY \
    NEXT_PUBLIC_PORTAL=$NEXT_PUBLIC_PORTAL NEXT_PUBLIC_DIRECT_DEPLOYER=$NEXT_PUBLIC_DIRECT_DEPLOYER \
    NEXT_PUBLIC_BUYBACK_MODULE=$NEXT_PUBLIC_BUYBACK_MODULE \
    NEXT_PUBLIC_SEASON_DROP=$NEXT_PUBLIC_SEASON_DROP \
    NEXT_PUBLIC_BAG=$NEXT_PUBLIC_BAG NEXT_PUBLIC_PAYDAY=$NEXT_PUBLIC_PAYDAY \
    NEXT_PUBLIC_BURN_CLOCK=$NEXT_PUBLIC_BURN_CLOCK NEXT_PUBLIC_BOOSTS=$NEXT_PUBLIC_BOOSTS \
    NEXT_PUBLIC_GRADUATION_HOOK=$NEXT_PUBLIC_GRADUATION_HOOK \
    NEXT_PUBLIC_BLOCK_ZERO=$NEXT_PUBLIC_BLOCK_ZERO \
    NEXT_PUBLIC_TEAM_WALLETS=$NEXT_PUBLIC_TEAM_WALLETS \
    NEXT_PUBLIC_HOUSE_COIN=$NEXT_PUBLIC_HOUSE_COIN \
    NEXT_PUBLIC_SITE_URL=$NEXT_PUBLIC_SITE_URL \
    NEXT_PUBLIC_DEMO=$NEXT_PUBLIC_DEMO NEXT_PUBLIC_DEMO_WALLET=$NEXT_PUBLIC_DEMO_WALLET \
    NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID=$NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID
COPY package.json package-lock.json* ./
COPY packages/sdk/package.json packages/sdk/
COPY apps/web/package.json apps/web/
# not --omit=optional: Tailwind's lightningcss and Next's swc ship as optional platform
# binaries. Dev dependencies ARE needed here, because the build is what needs them.
RUN npm ci --no-audit --no-fund
COPY packages/sdk packages/sdk
COPY apps/web apps/web
# The brand switch, and only it: the rest of scripts/ is harnesses and deploy tooling that has no
# business in a build context. Without this the BRAND argument below has nothing to run.
COPY scripts/brand.mjs scripts/brand.mjs
RUN npx tsc -p packages/sdk/tsconfig.json && node scripts/brand.mjs "$BRAND" && cd apps/web && npx next build
# and once the build is done, what built it does not travel with it
RUN npm prune --omit=dev

FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production PORT=4665
COPY --from=build /app/node_modules node_modules
COPY --from=build /app/packages/sdk packages/sdk
COPY --from=build /app/apps/web apps/web
COPY package.json ./
EXPOSE 4665
# not `npx --yes`: that reaches for the registry when the package is not where it expects
# it, which is a download at container start and a supply chain nobody reviewed.
USER node
CMD ["node", "node_modules/next/dist/bin/next", "start", "apps/web", "-p", "4665"]
