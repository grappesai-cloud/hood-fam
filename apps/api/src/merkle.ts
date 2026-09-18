import { StandardMerkleTree } from "@openzeppelin/merkle-tree";

import { pool } from "./db.js";
import { getSeason, SeasonError } from "./seasons.js";

/// The claim list for a season, and the tree the contract checks it against.
///
/// The leaf is HoodSeasonDrop's leaf: keccak256(bytes.concat(keccak256(abi.encode(season, account,
/// amount)))) over ["uint256","address","uint256"], which is exactly what StandardMerkleTree makes
/// with sorted-pair hashing. Nothing here hand-rolls a hash, because a tree that is one convention
/// away from the contract fails silently: every proof verifies locally and none of them on chain.
///
/// Who is on the list: everybody who earned a point in the season, taken from the `points` table
/// with the same aggregation the leaderboard uses and no limit. The frozen `season_snapshots` board
/// is only the public top 250, so it is used here as the signal that a season is settled, never as
/// the source of the amounts.

export const LEAF_ENCODING = ["uint256", "address", "uint256"] as const;

let ready: Promise<void> | null = null;

/// The two tables a drop lives in, created on first use the way db.ts creates the rest.
export function ensureAirdropTables(): Promise<void> {
  ready ??= pool
    .query(
      `create table if not exists airdrop_drops (
         season       int primary key,
         asset        text not null,
         total        numeric(78,0) not null,
         root         text not null,
         generated_at timestamptz not null default now(),
         source       jsonb not null default '{}'::jsonb
       );
       create table if not exists airdrop_claims (
         season  int not null,
         address text not null,
         amount  numeric(78,0) not null,
         proof   jsonb not null,
         primary key (season, address)
       );
       create index if not exists airdrop_claims_season on airdrop_claims (season);`,
    )
    .then(() => undefined)
    .catch((e) => { ready = null; throw e; });
  return ready;
}

export interface DropClaim { amount: string; proof: string[] }

export interface DropFile {
  season: number;
  asset: string;
  total: string;
  root: string;
  generatedAt: string;
  claims: Record<string, DropClaim>;
}

export interface DropStats {
  /// Wallets on the list.
  included: number;
  /// Wallets that earned points but whose share came out under the floor.
  belowFloor: number;
  /// What those wallets would have had. It is not lost: it rides along with the rounding remainder
  /// to the largest holder, so the tree still sums to the pool exactly.
  belowFloorWei: string;
  /// Rounding plus the line above, all of it given to the largest holder.
  remainderWei: string;
  minWei: string;
  totalPoints: string;
}

export interface BuiltDrop { file: DropFile; stats: DropStats }

export interface BuildInput {
  season: number | string;
  /// The pool, in the drop asset's smallest unit. The tree sums to this to the wei.
  poolWei: bigint;
  asset?: string;
  decimals?: number;
  /// Rows worth less than this are left off the list. Dust costs more in gas than it pays.
  minWei?: bigint;
}

const ZERO = "0x0000000000000000000000000000000000000000";

/// "1500000000000000000" and "1.5" both mean the same pool at eighteen decimals. More decimal
/// places than the asset has is a typo, not a rounding problem, so it is refused rather than
/// truncated: a pool that silently shrinks by a factor of ten is how a drop goes wrong quietly.
/// Always the asset's own units: `1` is one ETH, not one wei. An earlier version read a whole
/// number as wei and a decimal as units, which meant `--pool 1` quietly built a tree for a single
/// wei. Raw wei now needs saying so, through `--pool-wei` or a `poolWei` body field.
export function parseAmount(value: string, decimals: number, field = "pool"): bigint {
  const text = String(value).trim().replace(/_/g, "");
  if (!/^\d+(\.\d+)?$/.test(text)) throw new SeasonError(`${field} must be a positive number, got "${value}"`);
  const [whole, frac = ""] = text.split(".");
  if (frac.length > decimals) throw new SeasonError(`${field} has ${frac.length} decimal places but the asset has ${decimals}`);
  return BigInt(whole! + frac.padEnd(decimals, "0"));
}

/// A raw integer in the asset's smallest unit, for a caller that already did the conversion.
export function parseWei(value: string, field = "pool"): bigint {
  const text = String(value).trim().replace(/_/g, "");
  if (!/^\d+$/.test(text)) throw new SeasonError(`${field} must be a whole number of wei, got "${value}"`);
  return BigInt(text);
}

/// Builds a season's tree. Nothing is written: the caller decides whether to persist it, so the CLI
/// can dry-run against production data and print a root without touching the database.
export async function buildDrop(input: BuildInput): Promise<BuiltDrop> {
  const season = await getSeason(input.season);
  if (input.poolWei <= 0n) throw new SeasonError("pool must be greater than zero");
  const minWei = input.minWei ?? 0n;
  if (minWei < 0n) throw new SeasonError("--min cannot be negative");

  // The guard, not the source: a season that has not been snapshotted is still moving, and a drop
  // built over a moving board is a drop somebody can still earn their way into after publication.
  const { rows: [frozen] } = await pool.query<{ n: string }>(
    `select count(*) as n from season_snapshots where season = $1`, [season.id],
  );
  if (Number(frozen?.n ?? 0) === 0) {
    throw new SeasonError(
      `season ${season.id} has not been snapshotted; run "seasons-cli snapshot ${season.id}" (or POST /admin/seasons/${season.id}/snapshot) first`,
    );
  }

  // Points carry two decimals, so a hundredth of a point is the integer unit here and the pro rata
  // never touches a float.
  const { rows } = await pool.query<{ address: string; points: string }>(
    `select address, (sum(amount) * 100)::numeric(78,0) as points
     from points where season = $1
     group by address having sum(amount) > 0
     order by sum(amount) desc, address asc`,
    [season.id],
  );
  if (rows.length === 0) throw new SeasonError(`season ${season.id} has no points to allocate`);

  const totalPoints = rows.reduce((sum, r) => sum + BigInt(r.points), 0n);
  if (totalPoints === 0n) throw new SeasonError(`season ${season.id} has no points to allocate`);

  const allocated = rows.map((r) => ({
    address: r.address.toLowerCase(),
    amount: (input.poolWei * BigInt(r.points)) / totalPoints,
  }));
  const kept: typeof allocated = [];
  let belowFloor = 0;
  let belowFloorWei = 0n;
  for (const a of allocated) {
    if (a.amount > 0n && a.amount >= minWei) kept.push(a);
    else { belowFloor++; belowFloorWei += a.amount; }
  }
  if (kept.length === 0) {
    throw new SeasonError(`every wallet in season ${season.id} is under the floor of ${minWei} wei; lower --min`);
  }

  // The rows come back largest first, so the largest holder is kept[0]. They take the rounding dust
  // and whatever the floor left behind, which is the one place the sum can be made exact.
  const distributed = kept.reduce((sum, a) => sum + a.amount, 0n);
  const remainder = input.poolWei - distributed;
  kept[0]!.amount += remainder;

  const values = kept.map((a) => [String(season.id), a.address, a.amount.toString()]);
  const tree = StandardMerkleTree.of(values, [...LEAF_ENCODING]);

  const claims: Record<string, DropClaim> = {};
  for (const [i, v] of tree.entries()) {
    claims[String(v[1])] = { amount: String(v[2]), proof: tree.getProof(i) };
  }

  return {
    file: {
      season: season.id,
      asset: (input.asset ?? ZERO).toLowerCase(),
      total: input.poolWei.toString(),
      root: tree.root,
      generatedAt: new Date().toISOString(),
      claims,
    },
    stats: {
      included: kept.length,
      belowFloor,
      belowFloorWei: belowFloorWei.toString(),
      remainderWei: remainder.toString(),
      minWei: minWei.toString(),
      totalPoints: `${totalPoints / 100n}.${String(totalPoints % 100n).padStart(2, "0")}`,
    },
  };
}

/// Rebuilds the tree from the file alone and checks every proof against the published root, that
/// each address keys its own leaf, and that the amounts add up to the stated total. This is the
/// check that catches a hand-edited file, not a bug in the builder.
export function verifyDrop(file: DropFile): { claims: number; total: string; ok: true } {
  const entries = Object.entries(file.claims);
  if (entries.length === 0) throw new Error("the file has no claims");
  let sum = 0n;
  for (const [address, claim] of entries) {
    const value = [String(file.season), address, claim.amount];
    if (!StandardMerkleTree.verify(file.root, [...LEAF_ENCODING], value, claim.proof)) {
      throw new Error(`proof for ${address} does not verify against ${file.root}`);
    }
    sum += BigInt(claim.amount);
  }
  const rebuilt = StandardMerkleTree.of(entries.map(([a, c]) => [String(file.season), a, c.amount]), [...LEAF_ENCODING]);
  if (rebuilt.root !== file.root) throw new Error(`rebuilt root ${rebuilt.root} does not match ${file.root}`);
  if (sum !== BigInt(file.total)) throw new Error(`claims sum to ${sum}, the file says ${file.total}`);
  return { claims: entries.length, total: file.total, ok: true };
}

/// Writes the drop, replacing any earlier build of the same season in one transaction so a reader
/// never sees the new root beside the old proofs.
export async function saveDrop(file: DropFile, source: unknown): Promise<void> {
  await ensureAirdropTables();
  const addresses = Object.keys(file.claims);
  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query(`delete from airdrop_claims where season = $1`, [file.season]);
    await client.query(
      `insert into airdrop_drops (season, asset, total, root, generated_at, source)
       values ($1,$2,$3,$4,$5,$6)
       on conflict (season) do update set
         asset = excluded.asset, total = excluded.total, root = excluded.root,
         generated_at = excluded.generated_at, source = excluded.source`,
      [file.season, file.asset, file.total, file.root, file.generatedAt, JSON.stringify(source ?? {})],
    );
    await client.query(
      `insert into airdrop_claims (season, address, amount, proof)
       select $1, u.address, u.amount, u.proof
       from unnest($2::text[], $3::numeric[], $4::jsonb[]) as u(address, amount, proof)`,
      [
        file.season,
        addresses,
        addresses.map((a) => file.claims[a]!.amount),
        addresses.map((a) => JSON.stringify(file.claims[a]!.proof)),
      ],
    );
    await client.query("commit");
  } catch (e) {
    await client.query("rollback").catch(() => undefined);
    throw e;
  } finally {
    client.release();
  }
}

export interface StoredDrop {
  season: number;
  asset: string;
  total: string;
  root: string;
  generatedAt: Date;
  claims: number;
}

export async function storedDrop(season: number): Promise<StoredDrop | null> {
  await ensureAirdropTables();
  const { rows } = await pool.query<{
    season: number; asset: string; total: string; root: string; generated_at: Date; claims: string;
  }>(
    `select d.season, d.asset, d.total, d.root, d.generated_at,
            (select count(*) from airdrop_claims c where c.season = d.season) as claims
     from airdrop_drops d where d.season = $1`,
    [season],
  );
  const r = rows[0];
  if (!r) return null;
  return { season: r.season, asset: r.asset, total: r.total, root: r.root, generatedAt: r.generated_at, claims: Number(r.claims) };
}

export interface StoredProof { season: number; address: string; amount: string; proof: string[]; root: string }

export async function storedProof(season: number, address: string): Promise<StoredProof | null> {
  await ensureAirdropTables();
  const { rows } = await pool.query<{ amount: string; proof: string[]; root: string }>(
    `select c.amount, c.proof, d.root
     from airdrop_claims c join airdrop_drops d on d.season = c.season
     where c.season = $1 and c.address = $2`,
    [season, address.toLowerCase()],
  );
  const r = rows[0];
  if (!r) return null;
  return { season, address: address.toLowerCase(), amount: r.amount, proof: r.proof, root: r.root };
}
