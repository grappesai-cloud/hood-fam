import { NextResponse } from "next/server";

// The live board in the landing hero: what a hood.fam coin can be priced in (tokenized stocks and ETH
// on Robinhood Chain), with real prices from GeckoTerminal. The browser used to ask GeckoTerminal
// directly, 13 requests per visitor, and its free tier (about 30 a minute per IP) refused half of
// them. Here one process asks for everyone: prices at most once a minute, the 24 hourly closes
// behind each row's chart and 24h change at most every ten minutes, and every visitor reads memory.
//
// The change is computed from the token's own price series (OHLCV of its largest pool, requested
// with `token=` so the series is that token's price whichever side of the pair it sits on), never
// from the pool's headline change, which belongs to the pool's base token.

export const dynamic = "force-dynamic";

const GT = "https://api.geckoterminal.com/api/v2/networks/robinhood/";
const TOKENS: [string, string, string][] = [
  ["0xd0601ce157db5bdc3162bbac2a2c8af5320d9eec", "NVDA", "Nvidia"],
  ["0x322f0929c4625ed5bad873c95208d54e1c003b2d", "TSLA", "Tesla"],
  ["0xaf3d76f1834a1d425780943c99ea8a608f8a93f9", "AAPL", "Apple"],
  ["0x117cc2133c37b721f49de2a7a74833232b3b4c0c", "SPY", "S&P 500 fund"],
  ["0x0bd7d308f8e1639fab988df18a8011f41eacad73", "ETH", "Ether"],
  ["0xc0d6457c16cc70d6790dd43521c899c87ce02f35", "META", "Meta"],
  ["0x32ac8c1d7672667d5ebdea22935f7b06fc8d496f", "HOOD", "Robinhood"],
  ["0xe93237c50d904957cf27e7b1133b510c669c2e74", "MSFT", "Microsoft"],
  ["0x12f190a9f9d7d37a250758b26824b97ce941bf54", "AMZN", "Amazon"],
  ["0x2e0847e8910a9732eb3fb1bb4b70a580adad4fe3", "GOOGL", "Alphabet"],
  ["0x6330d8c3178a418788df01a47479c0ce7ccf450b", "COIN", "Coinbase"],
  ["0xd5f3879160bc7c32ebb4dc785f8a4f505888de68", "QQQ", "Nasdaq 100 fund"],
];
const PRICE_TTL = 60_000;
const HISTORY_TTL = 10 * 60_000;

interface Row { a: string; s: string; n: string; p: number | null; c: number | null; spark: number[] | null; pool?: string }
const rows = new Map<string, Row>(TOKENS.map(([a, s, n]) => [a, { a, s, n, p: null, c: null, spark: null }]));
let pricesAt = 0;
let historyAt = 0;

async function gt(path: string): Promise<any> {
  const res = await fetch(GT + path, { headers: { Accept: "application/json" }, cache: "no-store", signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`geckoterminal ${res.status}`);
  return res.json();
}

async function refreshPrices() {
  const body = await gt(`tokens/multi/${TOKENS.map(([a]) => a).join(",")}?include=top_pools`);
  for (const t of body.data ?? []) {
    const row = rows.get(String(t.attributes.address).toLowerCase());
    if (!row) continue;
    const price = Number.parseFloat(t.attributes.price_usd);
    row.p = Number.isFinite(price) ? price : null;
    const top = t.relationships?.top_pools?.data?.[0]?.id as string | undefined;
    if (top) row.pool = top.replace(/^robinhood_/, "");
    // Between history refreshes the chart ends at the latest price, so the change stays current.
    if (row.spark && row.p != null) {
      row.spark[row.spark.length - 1] = row.p;
      row.c = (row.p / row.spark[0] - 1) * 100;
    }
  }
  pricesAt = Date.now();
}

async function refreshHistory() {
  let missing = 0;
  for (const row of rows.values()) {
    if (!row.pool) { missing++; continue; }
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const body = await gt(`pools/${row.pool}/ohlcv/hour?aggregate=1&limit=25&currency=usd&token=${row.a}`);
        const closes = ((body.data?.attributes?.ohlcv_list ?? []) as number[][]).map((c) => c[4]).reverse();
        if (closes.length > 1) {
          if (row.p != null) closes[closes.length - 1] = row.p;
          row.spark = closes;
          row.c = (closes[closes.length - 1] / closes[0] - 1) * 100;
        }
        break;
      } catch {
        // Usually the free tier saying slow down: one pause and one more try, then move on.
        if (attempt === 0) await new Promise((r) => setTimeout(r, 2500));
        else if (!row.spark) missing++;
      }
    }
    await new Promise((r) => setTimeout(r, 400)); // a steady trickle, well under the free tier
  }
  // A pass with gaps comes back in a minute instead of ten, so a row never stays blank for long.
  historyAt = missing ? Date.now() - HISTORY_TTL + 60_000 : Date.now();
}

let pricing: Promise<void> | null = null;
let charting: Promise<void> | null = null;
function refreshPricesOnce(): Promise<void> {
  pricing ??= refreshPrices().finally(() => { pricing = null; });
  return pricing;
}
function refreshHistoryOnce(): void {
  charting ??= refreshHistory().catch(() => undefined).finally(() => { charting = null; });
}

export async function GET() {
  // The first visitor after a cold start waits for the prices (one request); the charts fill in
  // behind it. Everyone after that reads memory at once, and a stale part refreshes in the background.
  if (pricesAt === 0) await refreshPricesOnce().catch(() => undefined);
  else if (Date.now() - pricesAt > PRICE_TTL) void refreshPricesOnce().catch(() => undefined);
  if (pricesAt !== 0 && Date.now() - historyAt > HISTORY_TTL) refreshHistoryOnce();
  const out = [...rows.values()].map(({ pool: _pool, ...r }) => r);
  return NextResponse.json(
    { at: pricesAt, rows: out },
    { headers: { "Cache-Control": "public, max-age=20, stale-while-revalidate=60" } },
  );
}
