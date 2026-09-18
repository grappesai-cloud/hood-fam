import { migrate, pool } from "./db.js";
import { closeSeason, listSeasons, openSeason, SeasonError, snapshotSeason } from "./seasons.js";

/// The seasons from a shell, for an operator with database access and no admin token handy.
/// Same DATABASE_URL as the server, same functions as the admin routes, so the two never disagree.
///
///   node apps/api/dist/seasons-cli.js list
///   node apps/api/dist/seasons-cli.js open <name> [--starts ISO] [--ends ISO]
///   node apps/api/dist/seasons-cli.js close [id] [--ends ISO]
///   node apps/api/dist/seasons-cli.js snapshot [id]
///
/// `close` and `snapshot` default to the current season.

const USAGE = "usage: seasons-cli list | open <name> [--starts ISO] [--ends ISO] | close [id] [--ends ISO] | snapshot [id]";

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

const fmt = (d: Date | null) => (d ? d.toISOString() : "open");

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  if (!process.env.DATABASE_URL) fail("DATABASE_URL is not set");
  if (!command || command === "help" || command === "--help") fail(USAGE);

  // The schema is idempotent and the server runs it at boot too; running it here means the CLI
  // works on a database the new server has not restarted against yet.
  await migrate();

  switch (command) {
    case "list": {
      parseArgs(rest, []);
      const { seasons, current } = await listSeasons();
      for (const s of seasons) {
        const marks = [s.id === current ? "current" : "", s.snapshot ? "snapshot" : ""].filter(Boolean).join(", ");
        console.log(`${String(s.id).padStart(3)}  ${s.name.padEnd(NAME_WIDTH)}  ${fmt(s.starts)}  ->  ${fmt(s.ends)}${marks ? "  [" + marks + "]" : ""}`);
      }
      break;
    }
    case "open": {
      const { positional, flags } = parseArgs(rest, ["starts", "ends"]);
      const name = positional.join(" ");
      if (!name) fail(`open needs a name\n${USAGE}`);
      const s = await openSeason({ name, starts: flags.starts, ends: flags.ends });
      console.log(`opened season ${s.id} "${s.name}" ${fmt(s.starts)} -> ${fmt(s.ends)}`);
      break;
    }
    case "close": {
      const { positional, flags } = parseArgs(rest, ["ends"]);
      const id = positional[0] ?? (await listSeasons()).current;
      const s = await closeSeason(id, flags.ends);
      console.log(`closed season ${s.id} "${s.name}" at ${fmt(s.ends)}`);
      break;
    }
    case "snapshot": {
      const { positional } = parseArgs(rest, []);
      const id = positional[0] ?? (await listSeasons()).current;
      const n = await snapshotSeason(id);
      console.log(`snapshot of season ${id}: ${n} rows frozen`);
      break;
    }
    default:
      fail(`unknown command ${command}\n${USAGE}`);
  }
}

const NAME_WIDTH = 24;

try {
  await main();
  await pool.end();
} catch (e) {
  await pool.end().catch(() => undefined);
  if (e instanceof SeasonError) fail(e.message);
  fail(((e as Error).message ?? String(e)).split("\n")[0]!);
}
