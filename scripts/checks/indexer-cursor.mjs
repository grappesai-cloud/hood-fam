#!/usr/bin/env node
/// The indexer's cursor survives a restart.
///
/// The row holds the NEXT block to index and the hash of the LAST one indexed, because that is the
/// pair the loop reads back: it starts at `block`, and the reorg check compares the header at
/// `block - 1` against `block_hash`. Written the other way round (the last block with its own
/// hash), every restart re-counted a block and then compared the wrong header, which the indexer
/// reads as a reorg it must never heal on its own: it stopped and stayed stopped.
///
/// This walks the live row against the chain and says which way round it is.
///
///   HOOD_RPC=... DATABASE_URL=... node scripts/checks/indexer-cursor.mjs
///
/// It needs to reach the database, which on the production box is not published to the host. From
/// a laptop, tunnel it (`ssh -L 5433:127.0.0.1:5432 box` with the port published, or run this on
/// the box with the repo's node_modules present). The same answer by hand, when neither is handy:
///
///   docker exec hood-db psql -U hood -d hood -c "select block, block_hash from cursors"
///   cast block <block - 1> --rpc-url $HOOD_RPC   # its hash must equal block_hash

import pg from "pg";
import { createPublicClient, http } from "viem";

const RPC = process.env.HOOD_RPC ?? "https://rpc.mainnet.chain.robinhood.com";
const DB = process.env.DATABASE_URL;
if (!DB) { console.error("DATABASE_URL is not set"); process.exit(1); }

const client = createPublicClient({ transport: http(RPC) });
const pool = new pg.Pool({ connectionString: DB });
const { rows } = await pool.query("select block, block_hash from cursors where name = 'main'");
if (!rows[0]) { console.error("no cursor row: the indexer has never run"); process.exit(1); }

const block = BigInt(rows[0].block);
const stored = rows[0].block_hash;
const head = await client.getBlockNumber();
const behind = head - block;

let verdict = "no hash stored yet, so the reorg check is off";
let bad = 0;
if (stored) {
  const previous = await client.getBlock({ blockNumber: block - 1n }).catch(() => null);
  const atCursor = await client.getBlock({ blockNumber: block }).catch(() => null);
  if (previous?.hash === stored) verdict = "correct: the hash belongs to the block before the cursor";
  else if (atCursor?.hash === stored) { verdict = "OFF BY ONE: the hash is the cursor's own, which reads as a reorg on the next restart"; bad = 1; }
  else { verdict = "neither: the chain has moved under this cursor, or the row was set by hand"; bad = 1; }
}

console.log(`cursor   ${block}`);
console.log(`head     ${head}  (${behind} blocks ahead of the cursor)`);
console.log(`hash     ${stored ?? "none"}`);
console.log(`verdict  ${verdict}`);

const gaps = await pool.query("select kind, count(*) from indexer_gaps where healed_at is null group by kind");
for (const g of gaps.rows) { console.log(`open     ${g.count} ${g.kind}`); if (g.kind === "reorg") bad = 1; }

await pool.end();
process.exit(bad);
