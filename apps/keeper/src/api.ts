import { log } from "./log.js";

/// A launch as the indexer's `/tokens` returns it. `pot` arrives with the Bag's API; until then it is
/// undefined and the jobs that need it have nothing to do.
export interface Row {
  token: string;
  curve: string;
  phase: number;
  fee_model: number;
  mode?: "curve" | "direct";
  splitter?: string | null;
  locker?: string | null;
  hook?: string | null;
  pair_token?: string;
  symbol?: string;
  pot?: string | null;
}

export interface PaydayEpoch {
  epoch: number;
  closed: boolean;
  totalPoints: string | number;
  wallets: { address: string; points: string | number }[];
  lastTen: { token: string; pot: string; asset: string }[];
}

export interface TapeRow {
  id: number | string;
  kind: string;
  token: string | null;
  asset: string | null;
  amount: string;
  tx: string;
  ts: string;
  extra?: Record<string, unknown>;
}

const PAGE = 100;
const TOKENS_TTL_MS = 10_000;

export class Api {
  private tokensCache: { at: number; rows: Row[] } | undefined;
  private inflight: Promise<Row[]> | undefined;

  constructor(private readonly base: string) {}

  /// GET that treats a 404 as "this route is not there yet" (null) and anything else that is not
  /// 2xx as an error. The API is deployed separately from the keeper, so a missing route is a
  /// state, not a fault.
  async get<T>(path: string): Promise<T | null> {
    const res = await fetch(`${this.base}${path}`);
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`api ${path}: ${res.status}`);
    return (await res.json()) as T;
  }

  /// Every launch, in pages of 100 (the API clamps `limit` there), cached for ten seconds so five
  /// loops asking at once cost one fetch.
  async allTokens(): Promise<Row[]> {
    if (this.tokensCache && Date.now() - this.tokensCache.at < TOKENS_TTL_MS) return this.tokensCache.rows;
    if (this.inflight) return this.inflight;
    this.inflight = (async () => {
      const rows: Row[] = [];
      const seen = new Set<string>();
      for (let offset = 0; offset < 100_000; offset += PAGE) {
        const page = await this.get<{ tokens: Row[] }>(`/tokens?limit=${PAGE}&offset=${offset}`);
        if (!page) throw new Error("api: /tokens is missing");
        let fresh = 0;
        for (const row of page.tokens) {
          const key = row.token.toLowerCase();
          if (seen.has(key)) continue;
          seen.add(key);
          rows.push(row);
          fresh++;
        }
        // a short page is the last one; a page with nothing new means offset is being ignored
        if (page.tokens.length < PAGE || fresh === 0) break;
      }
      this.tokensCache = { at: Date.now(), rows };
      return rows;
    })();
    try {
      return await this.inflight;
    } finally {
      this.inflight = undefined;
    }
  }

  /// Holders with a balance above zero, every page. The API today returns at most 100 and ignores
  /// offset; the loop notices a page with nothing new and stops, so it works either way.
  async holders(token: string): Promise<string[]> {
    const out: string[] = [];
    const seen = new Set<string>();
    for (let offset = 0; offset < 1_000_000; offset += PAGE) {
      const page = await this.get<{ holders: { address: string; balance: string }[] }>(
        `/tokens/${token}/holders?limit=${PAGE}&offset=${offset}`,
      );
      if (!page) break;
      let fresh = 0;
      for (const h of page.holders) {
        const key = h.address.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(h.address);
        fresh++;
      }
      if (page.holders.length < PAGE || fresh === 0) break;
    }
    return out;
  }

  /// One line when a route that a job needs is not there, once per route, not once per tick.
  private missing = new Set<string>();
  noteMissing(loop: string, route: string) {
    if (this.missing.has(route)) return;
    this.missing.add(route);
    log(loop, `${route} answers 404: the API does not have it yet, the job waits`);
  }
}
