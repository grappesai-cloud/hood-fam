#!/usr/bin/env node
// Which brand the web app builds as.
//
//   npm run brand -- ox          (the bags.fam default committed in this project)
//   npm run brand -- <id>        any directory under apps/web/brands
//
// It writes two one-line files, `brands/current.ts` and `app/brand.css`, so the build carries one
// brand's components and one brand's stylesheet and decides nothing at runtime. The Dockerfile runs
// it from its BRAND build argument, which is how five subdomains come out of one image.

import { existsSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const WEB = fileURLToPath(new URL("../apps/web/", import.meta.url));
const id = process.argv[2];
const brands = readdirSync(join(WEB, "brands"), { withFileTypes: true })
  .filter((e) => e.isDirectory())
  .map((e) => e.name);

if (!id || !brands.includes(id)) {
  console.error(`usage: npm run brand -- <${brands.join("|")}>`);
  process.exit(1);
}
if (!existsSync(join(WEB, "brands", id, "theme.css"))) {
  console.error(`brands/${id} has no theme.css`);
  process.exit(1);
}

writeFileSync(join(WEB, "brands/current.ts"), `/// Which brand this build is. Written by \`npm run brand -- <id>\`; committed as bags.fam so a plain
/// \`next build\` with no flags is the ox launchpad. See \`brands/types.ts\`.
export { brand } from "./${id}";
`);
writeFileSync(join(WEB, "app/brand.css"), `/* The stylesheet of the brand this build is, and only that one. Written by \`npm run brand -- <id>\`
   next to \`brands/current.ts\`, so a build never carries another brand's CSS. */
@import "../brands/${id}/theme.css";
`);
console.log(`building as ${id}`);
