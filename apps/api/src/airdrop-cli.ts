import { readFileSync, writeFileSync } from "node:fs";

import { migrate, pool } from "./db.js";
import { buildDrop, parseAmount, parseWei, saveDrop, verifyDrop, type DropFile } from "./merkle.js";
import { SeasonError } from "./seasons.js";

/// The drop from a shell, for an operator with database access and no admin token handy. Same
/// functions as the admin route, so the two can never disagree about a root.
///
///   node apps/api/dist/airdrop-cli.js build <season> --pool <amount> [--asset 0x…]
///                                      [--decimals 18] [--min <wei>] [--out file.json]
///   node apps/api/dist/airdrop-cli.js verify <file.json>
///
/// `--pool` is in the asset's own units (`--pool 1` is one ETH). Raw wei is `--pool-wei`, because
/// a pool that is out by a factor of 1e18 should fail loudly at the flag, not quietly in the tree.
/// board that is still moving is a drop somebody can earn their way into after publication.
/// `build` writes the tree to the database as well as to `--out`; `verify` touches neither.

const USAGE =
  "usage: airdrop-cli build <season> (--pool <units> | --pool-wei <wei>) [--asset 0x…] [--decimals 18] [--min <wei>] [--out file.json]\n" +
  "       airdrop-cli verify <file.json>";

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

/// Positionals and --flag value pairs, nothing more. An unknown flag is a typo, so it fails.
function parseArgs(argv: string[], allowed: string[]): { positional: string[]; flags: Record<string, string> } {
  const positional: string[] = [];
  const flags: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith("--")) {
      const key = a.slice(2);
      if (!allowed.includes(key)) fail(`unknown option --${key}\n${USAGE}`);
      const value = argv[i + 1];
      if (value === undefined || value.startsWith("--")) fail(`--${key} needs a value`);
      flags[key] = value;
      i++;
    } else {
      positional.push(a);
    }
  }
  return { positional, flags };
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  if (!command || command === "help" || command === "--help") fail(USAGE);

  switch (command) {
    case "build": {
      if (!process.env.DATABASE_URL) fail("DATABASE_URL is not set");
      const { positional, flags } = parseArgs(rest, ["pool", "asset", "decimals", "out", "min"]);
      const season = positional[0];
      if (!season) fail(`build needs a season\n${USAGE}`);
      if (!flags.pool && !flags["pool-wei"]) fail(`build needs --pool or --pool-wei\n${USAGE}`);
      const decimals = flags.decimals === undefined ? 18 : Number(flags.decimals);
      if (!Number.isInteger(decimals) || decimals < 0 || decimals > 36) fail("--decimals must be 0 to 36");
      if (flags.asset && !/^0x[0-9a-fA-F]{40}$/.test(flags.asset)) fail("--asset must be an address");

      // The schema is idempotent and the server runs it at boot too, so the CLI works against a
      // database the new server has not restarted on yet.
      await migrate();

      const { file, stats } = await buildDrop({
        season,
        poolWei: flags["pool-wei"] ? parseWei(flags["pool-wei"], "--pool-wei") : parseAmount(flags.pool!, decimals, "--pool"),
        asset: flags.asset,
        minWei: flags.min === undefined ? 0n : parseAmount(flags.min, 0, "--min"),
      });
      verifyDrop(file);
      await saveDrop(file, { ...stats, decimals, pool: flags.pool, builtBy: "airdrop-cli" });
      if (flags.out) {
        writeFileSync(flags.out, JSON.stringify(file, null, 2));
        console.log(`wrote ${flags.out}`);
      }
      console.log(`season   ${file.season}`);
      console.log(`asset    ${file.asset}`);
      console.log(`root     ${file.root}`);
      console.log(`total    ${file.total}`);
      console.log(`wallets  ${stats.included} on the list, ${stats.belowFloor} under the floor of ${stats.minWei} wei`);
      console.log(`floor    ${stats.belowFloorWei} wei left unallocated by the floor`);
      console.log(`remain   ${stats.remainderWei} wei (floor plus rounding) went to the largest holder`);
      break;
    }
    case "verify": {
      const { positional } = parseArgs(rest, []);
      const path = positional[0];
      if (!path) fail(`verify needs a file\n${USAGE}`);
      let file: DropFile;
      try {
        file = JSON.parse(readFileSync(path, "utf8")) as DropFile;
      } catch (e) {
        fail(`cannot read ${path}: ${(e as Error).message}`);
      }
      const { claims, total } = verifyDrop(file);
      console.log(`season   ${file.season}`);
      console.log(`root     ${file.root}`);
      console.log(`${claims} proofs verify against the root and sum to ${total}`);
      break;
    }
    default:
      fail(`unknown command ${command}\n${USAGE}`);
  }
}

try {
  await main();
  await pool.end();
} catch (e) {
  await pool.end().catch(() => undefined);
  if (e instanceof SeasonError) fail(e.message);
  fail(((e as Error).message ?? String(e)).split("\n")[0]!);
}
