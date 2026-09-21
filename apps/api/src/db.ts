import pg from "pg";

export const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  max: Number(process.env.PG_POOL ?? 10),
});

/// Numbers here are token and pair amounts in wei, which do not fit in a bigint column.
/// numeric(78,0) holds anything a uint256 can.
const SCHEMA = `
create table if not exists launches (
  token            text primary key,
  curve            text not null,
  creator          text not null,
  fee_recipient    text not null,
  pair_token       text not null,
  config_id        int  not null,
  -- The four legs of the creator fee, as picked at launch. They add up to 10,000 on a curve
  -- launch, and they are all zero on a direct one: its tax never reaches HoodFeeRouter, it is
  -- split in the launch's own splitter under alloc_*_bps below. So zero here reads as "this
  -- machine does not use the split", not as "nothing is paid out". Null would say the chain never
  -- told us, and it does: the registry row carries four zeros for a direct launch.
  split_stakers_bps   smallint not null default 0,
  split_buyback_bps   smallint not null default 0,
  split_liquidity_bps smallint not null default 0,
  split_creator_bps   smallint not null default 0,
  -- The creator's own first buy, locked in the staking vault at launch. Zero and null when they
  -- took it in hand, which is the same thing the registry row says.
  first_buy_locked    numeric(78,0) not null default 0,
  first_buy_unlock_at timestamptz,
  name             text not null,
  symbol           text not null,
  image            text not null default '',
  description      text not null default '',
  website          text not null default '',
  twitter          text not null default '',
  telegram         text not null default '',
  launched_at      timestamptz not null,
  block            bigint not null,
  tx               text not null,
  mode             text not null default 'curve',
  hook             text,
  splitter         text,
  locker           text,
  pool_id          text,
  tick_spacing     int,
  pool_fee         int,
  buy_tax_bps      int,
  sell_tax_bps     int,
  snipe_tax_bps    int,
  snipe_decay_seconds int,
  max_hold_bps     int,
  max_buy_bps      int,
  restrictions_end_block bigint,
  alloc_creator_bps   int,
  alloc_buyback_bps   int,
  alloc_dividends_bps int,
  alloc_liquidity_bps int,
  bonded           boolean not null default false,
  total_supply     numeric(78,0) not null default 0,
  burned           numeric(78,0) not null default 0,
  tick_start       int,
  tick_bond        int,
  last_tick        int,
  phase            int not null default 0,
  sold             numeric(78,0) not null default 0,
  reserve          numeric(78,0) not null default 0,
  curve_supply     numeric(78,0) not null default 0,
  price            numeric(78,0) not null default 0,
  volume_24h       numeric(78,0) not null default 0,
  volume_total     numeric(78,0) not null default 0,
  trades_total     int not null default 0,
  graduated_at     timestamptz,
  volume_usd       numeric(20,2) not null default 0,
  launch_points_at timestamptz
);
create index if not exists launches_launched_at on launches (launched_at desc);
create index if not exists launches_volume on launches (volume_24h desc);
-- Columns that arrived after the first deployment. A database created from an older schema picks
-- them up here; a fresh one already has them from the create above. total_supply is what is left
-- after burns, burned is what left, so price times total_supply is the cap.
alter table launches add column if not exists snipe_tax_bps int;
alter table launches add column if not exists volume_usd numeric(20,2) not null default 0;
alter table launches add column if not exists launch_points_at timestamptz;
alter table launches add column if not exists snipe_decay_seconds int;
alter table launches add column if not exists max_hold_bps int;
alter table launches add column if not exists max_buy_bps int;
alter table launches add column if not exists restrictions_end_block bigint;
alter table launches add column if not exists alloc_creator_bps int;
alter table launches add column if not exists alloc_buyback_bps int;
alter table launches add column if not exists alloc_dividends_bps int;
alter table launches add column if not exists alloc_liquidity_bps int;
alter table launches add column if not exists burned numeric(78,0) not null default 0;
alter table launches add column if not exists split_stakers_bps smallint not null default 0;
alter table launches add column if not exists split_buyback_bps smallint not null default 0;
alter table launches add column if not exists split_liquidity_bps smallint not null default 0;
alter table launches add column if not exists split_creator_bps smallint not null default 0;
alter table launches add column if not exists first_buy_locked numeric(78,0) not null default 0;
alter table launches add column if not exists first_buy_unlock_at timestamptz;
-- The single fee model is gone from the contracts, so it goes from here too rather than lingering
-- in every select * as a number no launch has any more.
alter table launches drop column if exists fee_model;

create table if not exists trades (
  id           bigserial primary key,
  token        text not null references launches(token) on delete cascade,
  side         text not null,
  trader       text not null,
  recipient    text not null,
  pair_amount  numeric(78,0) not null,
  token_amount numeric(78,0) not null,
  fee          numeric(78,0) not null,
  price        numeric(78,0) not null,
  block        bigint not null,
  tx           text not null,
  log_index    int not null,
  ts           timestamptz not null,
  unique (tx, log_index)
);
create index if not exists trades_token_ts on trades (token, ts desc);
create index if not exists trades_trader on trades (trader);

create table if not exists balances (
  token   text not null references launches(token) on delete cascade,
  address text not null,
  balance numeric(78,0) not null default 0,
  primary key (token, address)
);
create index if not exists balances_token_balance on balances (token, balance desc);
-- The portfolio page reads every token one address holds. Without this it is a full scan of the
-- largest table in the schema (one row per holder per token), which grows without bound. Partial on
-- the same balance-over-zero the query filters by, so the index is only the live holdings. Measured:
-- 30 ms full scan at half a million rows becomes 0.2 ms.
create index if not exists balances_address on balances (address) where balance > 0;

create table if not exists stakes (
  position_id bigint primary key,
  token       text not null,
  owner       text not null,
  amount      numeric(78,0) not null,
  unlock_at   timestamptz not null,
  weight_bps  int not null,
  active      boolean not null default true,
  claimed     numeric(78,0) not null default 0,
  created_at  timestamptz not null
);
create index if not exists stakes_owner on stakes (owner);
create index if not exists stakes_token on stakes (token);
-- One vault, one coin, and rewards in whatever each launch trades against. The claimed column
-- stays the total in the chain's own currency; this one carries every asset, keyed by address,
-- as decimal strings so a uint256 survives the trip through JSON.
alter table stakes add column if not exists claimed_by_asset jsonb not null default '{}'::jsonb;

-- What a launch trades against, as the token itself reports it. Five assets today and more when
-- the owner allows them, so the scale cannot be a constant in the app any more.
alter table launches add column if not exists pair_symbol text;
alter table launches add column if not exists pair_decimals smallint;
-- How far a position has been paid for being locked. Null means "since it was created": a database
-- from before points accrued over time starts every open position from its own beginning.
alter table stakes add column if not exists points_through timestamptz;
create index if not exists stakes_active on stakes (active) where active;

create table if not exists dividend_events (
  id        bigserial primary key,
  token     text not null,
  holder    text not null,
  amount    numeric(78,0) not null,
  block     bigint not null,
  tx        text not null,
  log_index int not null,
  ts        timestamptz not null,
  unique (tx, log_index)
);
create index if not exists dividend_events_holder on dividend_events (holder);

create table if not exists fee_events (
  id        bigserial primary key,
  token     text not null,
  kind      text not null,
  amount    numeric(78,0) not null,
  result    numeric(78,0) not null default 0,
  -- Where a flush actually went, straight off the Flushed log: four pair amounts that add up to
  -- the amount. Null on every other kind, which has no legs to speak of. The result column stays
  -- what it has always been, the outcome of the money moving: for a flush, the tokens it burned.
  to_stakers   numeric(78,0),
  to_buyback   numeric(78,0),
  to_liquidity numeric(78,0),
  to_creator   numeric(78,0),
  block     bigint not null,
  tx        text not null,
  log_index int not null,
  ts        timestamptz not null,
  unique (tx, log_index)
);
alter table fee_events add column if not exists to_stakers numeric(78,0);
alter table fee_events add column if not exists to_buyback numeric(78,0);
alter table fee_events add column if not exists to_liquidity numeric(78,0);
alter table fee_events add column if not exists to_creator numeric(78,0);
alter table fee_events drop column if exists fee_model;

create table if not exists seasons (
  id     int primary key,
  name   text not null,
  starts timestamptz not null,
  ends   timestamptz
);

-- A season's final board, frozen by an operator. Same numbers as the live board (launches is
-- kept so the row shape matches), one taken_at per snapshot.
create table if not exists season_snapshots (
  season     int not null,
  position   int not null,
  address    text not null,
  points     numeric(20,2) not null,
  volume_usd numeric(20,2) not null default 0,
  launches   int not null default 0,
  rank       text not null,
  taken_at   timestamptz not null default now(),
  primary key (season, address)
);
create index if not exists season_snapshots_position on season_snapshots (season, position);

create table if not exists points (
  id      bigserial primary key,
  address text not null,
  season  int not null,
  kind    text not null,
  token   text,
  amount  numeric(20,2) not null,
  usd     numeric(20,2) not null default 0,
  ref     text,
  ts      timestamptz not null,
  unique (kind, ref)
);
create index if not exists points_address on points (address, season);

create table if not exists cursors (
  name  text primary key,
  block bigint not null
);
-- The hash of the block the cursor stands on. It is how a reorg is noticed at all: the block number
-- is the same afterwards, the hash is not.
alter table cursors add column if not exists block_hash text;

-- Ranges the indexer could not read and walked past. Every row is trades, points and holders that
-- are missing from the database and from nowhere else, so they are recorded rather than logged:
-- a line in a log nobody greps is the same as no line at all.
create table if not exists indexer_gaps (
  from_block bigint not null,
  to_block   bigint not null,
  reason     text not null,
  at         timestamptz not null default now(),
  healed_at  timestamptz,
  primary key (from_block, to_block)
);
-- 'gap' is a range the node would not serve, and reading it again fixes it. 'reorg' is a range that
-- was read and then stopped being true, which reading again does NOT fix: balances and volumes are
-- accumulated, so replaying them would count the same trades twice. Both are surfaced; only a gap
-- is retried.
alter table indexer_gaps add column if not exists kind text not null default 'gap';
create index if not exists indexer_gaps_open on indexer_gaps (from_block) where healed_at is null;

create table if not exists support_tickets (
  id         bigserial primary key,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  status     text not null default 'open',
  address    text,
  contact    text not null,
  subject    text not null,
  summary    text not null,
  page       text,
  transcript jsonb not null default '[]'::jsonb,
  source     text not null default 'assistant',
  note       text
);
create index if not exists support_tickets_status on support_tickets (status, created_at desc);

-- One chat per launch. A message is hidden, never deleted and never edited: a creator who could
-- erase what a holder said could rewrite the room afterwards and nobody would be able to show it,
-- so the row stays and hidden_by with hidden_at say who took it off the wall and when. It is also
-- what lets the author keep seeing their own words (the API returns a hidden body to its author and
-- to nobody else), and what a wallet accused of spamming a token can be read back from.
create table if not exists messages (
  id         bigserial primary key,
  token      text not null references launches(token) on delete cascade,
  author     text not null,
  body       text not null,
  created_at timestamptz not null default now(),
  hidden_by  text,
  hidden_at  timestamptz
);
-- The room, newest first and paged backwards by id; then one wallet's own history, for a creator
-- or an operator deciding whether it is a person or a machine.
create index if not exists messages_token_id on messages (token, id desc);
create index if not exists messages_author on messages (author, created_at desc);

-- Who brought whom. One row per referred wallet, written once and never rewritten: a referral that
-- could be re-pointed later is a referral worth farming, and the reward is paid as points on the
-- referee's own trades, so the row has to outlive any single session. The code is the referrer's
-- own address; there is no separate namespace to squat, and a wallet can always be checked on chain
-- before anyone clicks.
create table if not exists referrals (
  referee  text primary key,
  referrer text not null,
  bound_at timestamptz not null default now()
);
create index if not exists referrals_referrer on referrals (referrer);

-- Follows, for reading somebody else's trades as they happen. Nothing here can spend: following is
-- a subscription to a public feed, and the copy button fills a form the follower still signs.
create table if not exists follows (
  follower   text not null,
  followed   text not null,
  created_at timestamptz not null default now(),
  primary key (follower, followed)
);
create index if not exists follows_followed on follows (followed);

-- Tokens a wallet asked to be told about. The alerts themselves are drawn by the browser from the
-- same stream the board reads, so this table is only the list; nothing is pushed from here.
create table if not exists watchlist (
  address    text not null,
  token      text not null references launches(token) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (address, token)
);
create index if not exists watchlist_token on watchlist (token);

-- Cost basis, kept from trades on this pad alone. A token that arrived by plain transfer has no
-- price we know, so it enters at zero cost and shows up as profit when it is sold: that is stated
-- on the page rather than hidden, because the alternative is inventing a number. qty is token wei,
-- the two dollar columns are what was paid and what has been realised.
create table if not exists trade_positions (
  token        text not null references launches(token) on delete cascade,
  address      text not null,
  qty          numeric(78,0) not null default 0,
  cost_usd     numeric(20,2) not null default 0,
  realized_usd numeric(20,2) not null default 0,
  updated_at   timestamptz not null default now(),
  primary key (token, address)
);
create index if not exists trade_positions_address on trade_positions (address);

-- A race is a window with a name: the standings are the same points the board already keeps, read
-- between two timestamps. No prize is stored as money, only the line the operator announced, so
-- nothing here can promise what the treasury has not got.
create table if not exists races (
  id     bigserial primary key,
  name   text not null,
  starts timestamptz not null,
  ends   timestamptz not null,
  prize  text not null default '',
  metric text not null default 'points'
);
create index if not exists races_window on races (ends desc);
`;

export async function migrate() {
  await pool.query(SCHEMA);
  await pool.query(
    `insert into seasons (id, name, starts) values (1, 'Season 1', now())
     on conflict (id) do nothing`,
  );
}

export const currentSeason = async (): Promise<number> => {
  const { rows } = await pool.query<{ id: number }>(
    `select id from seasons where starts <= now() and (ends is null or ends > now()) order by id desc limit 1`,
  );
  if (rows[0]) return rows[0].id;
  /// Between seasons (the last one closed, the next not open yet) points keep landing on the last
  /// season that started rather than on season 1, so nothing earned is credited to the wrong year.
  const { rows: last } = await pool.query<{ id: number }>(`select id from seasons where starts <= now() order by id desc limit 1`);
  return last[0]?.id ?? 1;
};

export async function getCursor(name: string, fallback: bigint): Promise<bigint> {
  const { rows } = await pool.query<{ block: string }>(`select block from cursors where name = $1`, [name]);
  return rows[0] ? BigInt(rows[0].block) : fallback;
}

export async function setCursor(name: string, block: bigint, hash?: string) {
  await pool.query(
    `insert into cursors (name, block, block_hash) values ($1, $2, $3)
     on conflict (name) do update set block = excluded.block, block_hash = excluded.block_hash`,
    [name, block.toString(), hash ?? null],
  );
}

export async function getCursorHash(name: string): Promise<string | null> {
  const { rows } = await pool.query<{ block_hash: string | null }>(
    `select block_hash from cursors where name = $1`, [name],
  );
  return rows[0]?.block_hash ?? null;
}
