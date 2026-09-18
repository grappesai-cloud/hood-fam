import { migrate, pool } from "./db.js";
import { seedDemo, wipeDemo } from "./demo.js";

/// The demo world from a shell.
///
///   node apps/api/dist/demo-cli.js seed [--wipe] [--no-art] [--days 21] [--seed <string>]
///   node apps/api/dist/demo-cli.js wipe
///
/// Both refuse to run unless `--yes` is on the line, and both refuse outright on a deployment whose
/// indexer is following a chain: fabricated rows next to indexed ones are indistinguishable a week
/// later, and there is no version of that which ends well. `INDEXER=0 --yes` is the shape of a
/// deployment that is a preview, which is the only place this belongs.

const USAGE =
  "usage: demo-cli seed --yes [--wipe] [--no-art] [--days 21] [--seed <string>] | demo-cli wipe --yes";

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

function parseArgs(argv: string[], allowed: string[], switches: string[]) {
  const flags: Record<string, string> = {};
  const on = new Set<string>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (!a.startsWith("--")) fail(`unexpected argument "${a}"\n${USAGE}`);
    const key = a.slice(2);
    if (switches.includes(key)) { on.add(key); continue; }
    if (!allowed.includes(key)) fail(`unknown option --${key}\n${USAGE}`);
    const value = argv[i + 1];
    if (value === undefined || value.startsWith("--")) fail(`--${key} needs a value`);
    flags[key] = value;
    i++;
  }
  return { flags, on };
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  if (!process.env.DATABASE_URL) fail("DATABASE_URL is not set");
  if (!command || command === "help" || command === "--help") fail(USAGE);

  const { flags, on } = parseArgs(rest, ["days", "seed"], ["yes", "wipe", "no-art", "force"]);
  if (!on.has("yes")) fail("this writes fabricated rows into the database. Add --yes if you mean it.");
  if (process.env.INDEXER !== "0" && !on.has("force")) {
    fail(
      "INDEXER is not 0, so this database is following a real chain. Seeding a demo into it would " +
      "mix invented rows with indexed ones. Run it against a preview (INDEXER=0), or --force if you " +
      "are certain.",
    );
  }

  await migrate();

  switch (command) {
    case "seed": {
      const days = flags.days ? Number(flags.days) : undefined;
      if (days !== undefined && (!Number.isFinite(days) || days <= 0)) fail("--days must be a positive number");
      const s = await seedDemo({ wipe: on.has("wipe"), art: !on.has("no-art"), days, seed: flags.seed });
      console.log(`seeded ${s.launches} launches, ${s.trades} trades, ${s.stakes} locked positions, ${s.tickets} tickets`);
      console.log(`points rows: ${s.points}   wallets: ${s.wallets}   art: ${s.art}`);
      console.log(`history: ${s.from.toISOString()} -> ${s.to.toISOString()}`);
      console.log(`the wallet to look at: ${s.showcase}`);
      console.log(`  /portfolio?address=${s.showcase}`);
      break;
    }
    case "wipe": {
      await wipeDemo();
      console.log("demo tables emptied");
      break;
    }
    default:
      fail(USAGE);
  }
}

main()
  .then(() => pool.end())
  .catch(async (e) => {
    console.error(e instanceof Error ? e.message : e);
    await pool.end().catch(() => undefined);
    process.exit(1);
  });
