import { pool } from "./db.js";
import { pairUsdPrice } from "./price.js";
import { isSystem } from "./system.js";

/// Profit, from the trades this pad saw and from nothing else.
///
/// A board that ranks by volume answers "who is loudest". The question people actually ask before
/// they follow somebody is "who is up", and that needs a cost basis, which is the one number a
/// launchpad does not get for free: the chain says a wallet received tokens, never what it paid.
///
/// So the basis is built from trades on this pad, in the order they happened, as a weighted
/// average: a buy adds dollars and tokens to the position, a sell takes the same average out of it
/// and books the difference as realised. Two things are therefore true and both are said on the
/// page rather than hidden:
///
///   - Tokens that arrived by plain transfer (an airdrop, a friend, a bridge) enter at zero cost,
///     so selling them reads as pure profit. Inventing a price for them would be worse.
///   - Unrealised profit is marked at the launch's last traded price, which is the same price the
///     board and the chart use. It moves with the market, and it is labelled as open, not banked.
///
/// The position row is only ever moved by a trade the indexer wrote for the first time, so a
/// re-read of a range the node refused earlier cannot count the same buy twice.

export interface TradeBasis {
  token: string;
  address: string;
  side: "buy" | "sell";
  /// Token wei moved by the trade.
  tokenAmount: bigint;
  /// What that was worth in dollars at the moment of the trade.
  usd: number;
  at: Date;
}

export async function recordBasis(trade: TradeBasis) {
  const address = trade.address.toLowerCase();
  if (isSystem(address) || trade.tokenAmount === 0n) return;

  if (trade.side === "buy") {
    await pool.query(
      `insert into trade_positions (token, address, qty, cost_usd, updated_at)
       values ($1,$2,$3,$4,$5)
       on conflict (token, address) do update
         set qty = trade_positions.qty + excluded.qty,
             cost_usd = trade_positions.cost_usd + excluded.cost_usd,
             updated_at = excluded.updated_at`,
      [trade.token, address, trade.tokenAmount.toString(), trade.usd.toFixed(2), trade.at],
    );
    return;
  }

  // A sell takes out the average cost of what it sold. Selling more than this pad ever saw bought
  // means the rest came from somewhere we cannot price, and that part leaves at zero cost.
  const { rows } = await pool.query<{ qty: string; cost_usd: string }>(
    `select qty, cost_usd from trade_positions where token = $1 and address = $2`,
    [trade.token, address],
  );
  const held = BigInt(rows[0]?.qty ?? "0");
  const cost = Number(rows[0]?.cost_usd ?? 0);
  const sold = trade.tokenAmount;
  const priced = sold > held ? held : sold;
  const costOut = held > 0n && cost > 0 ? (cost * Number(priced)) / Number(held) : 0;

  await pool.query(
    `insert into trade_positions (token, address, qty, cost_usd, realized_usd, updated_at)
     values ($1,$2,$3,$4,$5,$6)
     on conflict (token, address) do update
       set qty = greatest(0, trade_positions.qty - $7),
           cost_usd = greatest(0, trade_positions.cost_usd - $8),
           realized_usd = trade_positions.realized_usd + $5,
           updated_at = excluded.updated_at`,
    [trade.token, address, "0", "0", (trade.usd - costOut).toFixed(2), trade.at,
     sold.toString(), costOut.toFixed(2)],
  );
}

export interface WalletPnl {
  realizedUsd: number;
  unrealizedUsd: number;
  totalUsd: number;
}

/// One wallet's profit across every launch it traded here. Unrealised is marked at each launch's
/// last price, converted with the same pair price the rest of the API uses, so the number on the
/// profile is the number the token pages add up to.
export async function walletPnl(address: string): Promise<WalletPnl> {
  const { rows } = await pool.query<{ qty: string; cost_usd: string; realized_usd: string; price: string; pair_token: string; pair_decimals: number | null }>(
    `select p.qty, p.cost_usd, p.realized_usd, l.price, l.pair_token, l.pair_decimals
       from trade_positions p join launches l on l.token = p.token
      where p.address = $1`,
    [address.toLowerCase()],
  );
  let realizedUsd = 0;
  let unrealizedUsd = 0;
  for (const row of rows) {
    realizedUsd += Number(row.realized_usd);
    const qty = Number(row.qty) / 1e18;
    if (qty <= 0) continue;
    const pairPrice = await pairUsdPrice(row.pair_token);
    const decimals = row.pair_decimals ?? 18;
    // price is pair wei per whole token, as the indexer wrote it.
    const pairPerToken = Number(row.price) / 10 ** decimals;
    unrealizedUsd += qty * pairPerToken * pairPrice - Number(row.cost_usd);
  }
  return { realizedUsd, unrealizedUsd, totalUsd: realizedUsd + unrealizedUsd };
}

/// The profit board. Realised profit is all-time by design: it is banked money, and a window that
/// hid last week's would rank a wallet by when it closed rather than by how well it traded. The
/// open side is marked at each launch's last price, so the two halves are always named apart.
///
/// One row per wallet and pair rather than one query per wallet: the pair price is the only part
/// that has to leave the database, and there are a handful of pairs against thousands of wallets.
export async function pnlLeaderboard(limit: number) {
  const { rows } = await pool.query<{
    address: string; pair_token: string; pair_decimals: number | null;
    realized: string; open_pair: string; cost: string;
  }>(
    `select p.address, l.pair_token, l.pair_decimals,
            sum(p.realized_usd)::numeric(20,2) as realized,
            sum((p.qty::numeric / 1e18) * (l.price::numeric)) as open_pair,
            sum(case when p.qty > 0 then p.cost_usd else 0 end)::numeric(20,2) as cost
       from trade_positions p join launches l on l.token = p.token
      group by p.address, l.pair_token, l.pair_decimals`,
  );

  const prices = new Map<string, number>();
  const wallets = new Map<string, { realizedUsd: number; unrealizedUsd: number }>();
  for (const row of rows) {
    if (isSystem(row.address)) continue;
    let price = prices.get(row.pair_token);
    if (price === undefined) {
      price = await pairUsdPrice(row.pair_token);
      prices.set(row.pair_token, price);
    }
    const open = (Number(row.open_pair) / 10 ** (row.pair_decimals ?? 18)) * price - Number(row.cost);
    const held = wallets.get(row.address) ?? { realizedUsd: 0, unrealizedUsd: 0 };
    held.realizedUsd += Number(row.realized);
    held.unrealizedUsd += open;
    wallets.set(row.address, held);
  }

  return [...wallets.entries()]
    .map(([address, held]) => ({ address, ...held, totalUsd: held.realizedUsd + held.unrealizedUsd }))
    .sort((a, b) => b.totalUsd - a.totalUsd)
    .slice(0, limit);
}
