import { migrate } from "./db.js";
import { runIndexer } from "./indexer.js";
import { buildServer } from "./server.js";

/// One process, two jobs: it follows the chain and it answers the app. Splitting them is a
/// deployment decision (INDEXER=0 or API=0), not a rewrite.
const port = Number(process.env.PORT ?? 8080);

await migrate();

if (process.env.INDEXER !== "0") {
  runIndexer().catch((e) => {
    console.error("indexer died:", e);
    process.exit(1);
  });
}

if (process.env.API !== "0") {
  const app = await buildServer();
  await app.listen({ port, host: "0.0.0.0" });
  console.log(`api listening on ${port}`);
}
