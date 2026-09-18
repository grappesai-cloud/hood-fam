# The keeper. Does only what anybody else could do, just sooner.
FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json* ./
COPY packages/sdk/package.json packages/sdk/
COPY apps/keeper/package.json apps/keeper/
# ci, not install: the lockfile is the build, and a lockfile that does not match the
# manifest should fail here rather than quietly resolve to something nobody tested.
RUN npm ci --omit=optional --no-audit --no-fund
COPY packages/sdk packages/sdk
COPY apps/keeper apps/keeper
RUN npx tsc -p packages/sdk/tsconfig.json && npx tsc -p apps/keeper/tsconfig.json
# What compiled it does not travel with it: this drops typescript and, from the root,
# the Solidity toolchain (LayerZero, Uniswap, ethers v5 under them) that the runtime
# never executes a line of.
RUN npm prune --omit=dev

FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/node_modules node_modules
COPY --from=build /app/packages/sdk packages/sdk
COPY --from=build /app/apps/keeper apps/keeper
COPY package.json ./
USER node
CMD ["node", "apps/keeper/dist/index.js"]
