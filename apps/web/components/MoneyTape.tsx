"use client";

import { useMemo, useState, type ReactNode } from "react";
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { EXPLORER } from "@/lib/config";
import { ago, compact, fmt, shortAddress } from "@/lib/format";
import { useLive, type LiveBag } from "@/lib/live";
import { BAG_KEYS, assetOf, big, fetchTape, isMissing, type TapeRow } from "@/lib/bag";

/// The money tape: one line per thing the Bag, a pot, Payday, the burn clock or the boosts did,
/// in the order the chain did them, each with the transaction that did it. It reads the indexer
/// on a timer and the stream is laid on top: a row that arrives while somebody is watching is
/// prepended and lit for a moment, and the next read confirms it rather than duplicating it.
///
/// The Bag page shows the whole market; a token page passes its address and the kinds it cares
/// about and gets the same tape cut down to that launch.

export interface MoneyTapeProps {
  token?: string | null;
  /// bag_events kinds to show. Null or empty is everything.
  kinds?: string[] | null;
  limit?: number;
  /// Offer "older" paging under the list. A token page's small tape turns it off.
  pages?: boolean;
  /// What to say when there is nothing on the tape yet.
  empty?: string;
}

const KEEP = 40;

/// A line is unique by what was done, not by its row id: the stream has no row id to give.
const lineKey = (row: { tx: string; kind: string; amount: string }) => `${(row.tx ?? "").toLowerCase()}:${row.kind}:${row.amount}`;

export function MoneyTape({ token, kinds, limit = 60, pages: paged = true, empty }: MoneyTapeProps) {
  const [arrived, setArrived] = useState<TapeRow[]>([]);
  const [pages, setPages] = useState<number[]>([]);
  const kindList = kinds?.length ? kinds : null;
  const kindKey = kindList ? kindList.join(",") : null;

  const first = useQuery({
    queryKey: BAG_KEYS.tape(token, kindKey),
    queryFn: () => fetchTape({ limit, token, kinds: kindList }),
    refetchInterval: 30_000,
    retry: false,
  });
  const rest = useQuery({
    queryKey: ["bag-tape-more", token?.toLowerCase() ?? "all", kindKey ?? "all", pages.join(",")],
    queryFn: async () => {
      const out: TapeRow[] = [];
      for (const before of pages) out.push(...(await fetchTape({ limit, token, kinds: kindList, before })).rows);
      return out;
    },
    enabled: pages.length > 0,
    retry: false,
  });

  // The symbols the indexer already told this tape, so a row off the stream (which carries only
  // an address) can be named the same way the rows around it are.
  const symbols = useMemo(() => {
    const map = new Map<string, string>();
    for (const row of [...(first.data?.rows ?? []), ...(rest.data ?? [])]) {
      if (row.token && row.symbol) map.set(row.token.toLowerCase(), row.symbol);
    }
    return map;
  }, [first.data, rest.data]);

  const live = useLive({
    tokens: token ? [token] : [],
    onBag: (event: LiveBag) => {
      if (kindList && !kindList.includes(event.kind)) return;
      const row: TapeRow = {
        id: -Date.now(),
        kind: event.kind,
        token: event.token,
        symbol: event.token ? symbols.get(event.token.toLowerCase()) ?? null : null,
        asset: event.asset,
        assetSymbol: null,
        decimals: null,
        amount: event.amount,
        extra: event.extra,
        tx: event.tx,
        ts: event.at,
      };
      setArrived((seen) => {
        const key = lineKey(row);
        return [row, ...seen.filter((r) => lineKey(r) !== key)].slice(0, KEEP);
      });
    },
  });

  const indexed = [...(first.data?.rows ?? []), ...(rest.data ?? [])];
  const known = new Set(indexed.map(lineKey));
  // The two lists meet in the middle: what the stream brought is newer than what the indexer has,
  // and a row in both is one line, keyed the same way, so it keeps its place and the light plays once.
  const rows = [
    ...arrived.filter((r) => !known.has(lineKey(r))).map((r) => ({ row: r, arrived: true })),
    ...indexed.map((r) => ({ row: r, arrived: false })),
  ];
  const last = indexed[indexed.length - 1];
  const more = paged && first.data?.nextBefore != null && last && indexed.length % limit === 0;
  const missing = first.isError && isMissing(first.error);

  return (
    <div className="money-tape-wrap">
      <ul className="money-tape">
        {rows.map(({ row, arrived: lit }, i) => <Line key={`${lineKey(row)}#${i}`} row={row} lit={lit} />)}
        {first.isSuccess && rows.length === 0 && (
          <li className="feed-empty dim">{empty ?? "Nothing on the tape yet. The first trade on the new machine writes the first line."}</li>
        )}
        {first.isError && (
          <li className="feed-empty dim">
            {missing ? "The tape is not wired into this API yet. The lines appear once the indexer serves the Bag." : "The tape could not be read. The API is not answering."}
          </li>
        )}
        {first.isPending && <li className="feed-empty dim">Reading the tape…</li>}
      </ul>
      {(more || live) && (
        <div className="money-tape-foot">
          {more && (
            <button className="btn btn-ghost" onClick={() => setPages((p) => [...p, last.id])} disabled={rest.isFetching}>
              {rest.isFetching ? "Reading…" : "Older lines"}
            </button>
          )}
          {live && <span className="money-tape-live"><i aria-hidden="true" /> live</span>}
        </div>
      )}
    </div>
  );
}

function Line({ row, lit }: { row: TapeRow; lit: boolean }) {
  return (
    <li className={lit ? "arrived" : undefined}>
      <span className="money-when" title={new Date(row.ts).toLocaleString()}>{ago(row.ts)} ago</span>
      <span className="money-what">{describe(row)}</span>
      <a className="money-tx" href={`${EXPLORER}/tx/${row.tx}`} target="_blank" rel="noreferrer">{row.tx.slice(0, 10)}… ↗</a>
    </li>
  );
}

/// The words for each kind, in the doc's voice: who paid what to whom.
export function describe(row: TapeRow): ReactNode {
  const x = row.extra ?? {};
  const money = (amount: unknown = row.amount, asset: string | null | undefined = row.asset) => {
    const { symbol, decimals } = assetOf(asset, asset === row.asset ? row : undefined);
    return <b>{fmt(big(amount), decimals, decimals >= 18 ? 4 : 2)} {symbol}</b>;
  };
  const coin = <Coin token={row.token} symbol={row.symbol} />;
  const who = (address: unknown) => typeof address === "string" && address.startsWith("0x")
    ? <Link href={`/trader/${address}`}>{shortAddress(address)}</Link>
    : "somebody";
  const holders = (n: unknown) => {
    const count = Number(n);
    return Number.isFinite(count) && count > 0 ? <>{count.toLocaleString("en-US")} holders</> : <>the holders of {coin}</>;
  };
  const reason = String(x.reason ?? "");
  const outlet = Number(x.outlet);
  const source = Number(x.source);

  switch (row.kind) {
    case "penalty": {
      const payer = reason === "snipe" ? "sniper" : reason === "jeet" ? "jeet" : reason === "whale" ? "whale" : "a seller";
      const toHolders = x.to_holders != null ? x.to_holders : row.amount;
      const toBag = big(x.to_bag);
      return <>{payer} {who(x.payer)} paid {money(toHolders)} to {holders(x.holders)} on {coin}{toBag > 0n && <>, {money(toBag)} to the Bag</>}</>;
    }
    case "slash":
      return <>creator sold {coin}, {money()} of fees went to holders</>;
    case "holders_paid": {
      switch (reason) {
        case "confetti": return <>Confetti paid {money()} to {holders(x.holders)} of {coin}</>;
        case "dividends": return <>the creator&apos;s dividends leg paid {money()} to {holders(x.holders)} of {coin}</>;
        case "lp_fees": return <>pool fees paid {money()} to {holders(x.holders)} of {coin}</>;
        case "payday": return <>Payday&apos;s slice paid {money()} to {holders(x.holders)} of {coin}</>;
        case "slash": return <>the creator&apos;s slashed fees paid {money()} to {holders(x.holders)} of {coin}</>;
        case "auction": return <>the sniper auction paid {money()} to {holders(x.holders)} of {coin}</>;
        case "king": return <>a sell put {money()} in {coin}&apos;s king pot</>;
        case "snipe": return <>the pot paid a sniper&apos;s {money()} to {holders(x.holders)} of {coin}</>;
        case "jeet": return <>the pot paid a jeet&apos;s {money()} to {holders(x.holders)} of {coin}</>;
        case "whale": return <>the pot paid a whale&apos;s {money()} to {holders(x.holders)} of {coin}</>;
        default: return <>the pot paid {money()} to {holders(x.holders)} of {coin}{reason && <> ({reason})</>}</>;
      }
    }
    case "pushed":
      return <>{coin}&apos;s pot pushed {money()} to {who(x.wallet ?? x.account ?? x.recipient)}</>;
    case "bag_in": {
      switch (source) {
        case 0: return <>a trade{row.token && <> on {coin}</>} put {money()} in the Bag</>;
        case 1: return <>{coin} graduated, {money()} went to the Bag</>;
        case 2: return <>a penalty{row.token && <> on {coin}</>} put {money()} in the Bag</>;
        case 3: return <>a launch fee or a boost put {money()} in the Bag</>;
        case 4: return <>the house coin&apos;s creator leg put {money()} in the Bag</>;
        default: return <>{money()} went into the Bag</>;
      }
    }
    case "bag_out": {
      switch (outlet) {
        case 0: return <>the Bag paid {money()} to the house</>;
        case 1: return <>the Bag paid {money()} to the Vault</>;
        case 2: return <>the Bag paid {money()} to Payday</>;
        case 3: return <>the Bag paid {money()} to the burn clock</>;
        case 4: return <>the Bag paid {money()} to {coin}&apos;s pot as Confetti</>;
        default: return <>the Bag paid {money()} out</>;
      }
    }
    case "held":
      return <>the Bag is holding {money()} for {outlet === 3 ? "the burn clock" : "the Vault"} until the house coin exists</>;
    case "payday_funded":
      return <>Payday took {money()} for hour {String(x.epoch ?? "")}</>;
    case "payday_paid":
      return <>Payday paid {who(x.wallet)} {money()}</>;
    case "payday_slice":
      return <>Payday sent {money()} to {coin}&apos;s pot, one of the last ten launches</>;
    case "payday_epoch": {
      const wallets = Number(x.wallets ?? x.paid ?? 0);
      const toWallets = x.to_wallets ?? x.toWallets ?? row.amount;
      const toLaunches = big(x.to_launches ?? x.toLaunches);
      const carried = big(x.carried);
      return (
        <>
          Payday paid {wallets > 0 ? `${wallets.toLocaleString("en-US")} wallets` : "the hour's wallets"} {money(toWallets)}
          {toLaunches > 0n && <>, {money(toLaunches)} to the last ten launches</>}
          {carried > 0n && <>, {money(carried)} carried to the next hour</>}
        </>
      );
    }
    case "burn": {
      const burned = big(x.burned ?? x.coinBurned);
      const spent = x.spent ?? row.amount;
      return <>burn clock bought and burned {burned > 0n ? <b>{compact(burned)} {row.symbol ?? "of the house coin"}</b> : "the house coin"} with {money(spent)}</>;
    }
    case "boost":
      return <>{coin} bought boost slot {String(x.slot ?? "?")} for {money()}{typeof x.buyer === "string" && <>, paid by {who(x.buyer)}</>}</>;
    case "king_crowned":
      return <>{who(x.king)} is king of {coin} with {money(x.pot ?? row.amount)} in the pot</>;
    case "king_won":
      return <>king {who(x.king ?? x.winner)} won {money()} on {coin}</>;
    case "auction_bid":
      return <>{who(x.bidder ?? x.payer)} bid {money()} for {coin}&apos;s first slot</>;
    case "auction_settled":
      return <>{who(x.winner)} won {coin}&apos;s first slot for {money()}: half to holders, half to locked liquidity</>;
    case "buyback": {
      const burned = big(x.burned);
      return <>a sell tax bought back {coin} with {money(x.spent ?? row.amount)}{burned > 0n && <> and burned <b>{compact(burned)}</b></>}</>;
    }
    case "buyback_wanted":
      return <>a buyback of {coin} is queued for the keeper</>;
    case "airdrop":
      return <>{who(x.wallet ?? x.account ?? x.recipient ?? x.claimer)} claimed {money()} from the season drop{x.season != null && <>, season {String(x.season)}</>}</>;
    case "graduated":
      return <>{coin} migrated to the pool with {money(x.pair_amount ?? x.liquidity ?? x.to_pool ?? x.toPool ?? row.amount)}</>;
    default:
      return <>{row.kind.replace(/_/g, " ")} {money()}{row.token && <> on {coin}</>}</>;
  }
}

function Coin({ token, symbol }: { token: string | null; symbol: string | null }) {
  if (!token) return <>the house coin</>;
  return <Link href={`/token/${token}`}>{symbol ? `$${symbol}` : shortAddress(token)}</Link>;
}
