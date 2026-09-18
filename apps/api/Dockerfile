# The indexer and the read API. One image, two switches: INDEXER=0 or API=0.
FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json* ./
COPY packages/sdk/package.json packages/sdk/
COPY apps/api/package.json apps/api/
# ci, not install: the lockfile is the build, and a lockfile that does not match the
# manifest should fail here rather than quietly resolve to something nobody tested.
RUN npm ci --omit=optional --no-audit --no-fund
COPY packages/sdk packages/sdk
COPY apps/api apps/api
RUN npx tsc -p packages/sdk/tsconfig.json && npx tsc -p apps/api/tsconfig.json
# What compiled it does not travel with it: this drops typescript and, from the root,
# the Solidity toolchain (LayerZero, Uniswap, ethers v5 under them) that the runtime
# never executes a line of.
RUN npm prune --omit=dev

FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/node_modules node_modules
COPY --from=build /app/packages/sdk packages/sdk
COPY --from=build /app/apps/api apps/api
COPY package.json README.md FEATURES.md ./
# the support assistant reads the public documents at boot
COPY docs docs
USER node
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "apps/api/dist/index.js"]
