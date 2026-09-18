# The announcer. Reads the same public API everybody else reads and says what it saw.
FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json* ./
COPY apps/announcer/package.json apps/announcer/
# ci, not install: the lockfile is the build, and a lockfile that does not match the
# manifest should fail here rather than quietly resolve to something nobody tested.
RUN npm ci --omit=optional --no-audit --no-fund
COPY apps/announcer apps/announcer
RUN npx tsc -p apps/announcer/tsconfig.json
# What compiled it does not travel with it: this drops typescript and, from the root,
# the Solidity toolchain (LayerZero, Uniswap, ethers v5 under them) that the runtime
# never executes a line of.
RUN npm prune --omit=dev

FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/node_modules node_modules
COPY --from=build /app/apps/announcer apps/announcer
COPY package.json ./
USER node
CMD ["node", "apps/announcer/dist/index.js"]
