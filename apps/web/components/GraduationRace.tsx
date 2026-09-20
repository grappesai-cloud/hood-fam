"use client";

import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { useReadContract } from "wagmi";
import { zeroAddress, type Address } from "viem";
import { hoodCurveAbi } from "@hood/sdk";
import { api, type TokenRow } from "@/lib/api";
import { useLive } from "@/lib/live";
import { fmt, launchProgress, pairDecimals, pairSymbol } from "@/lib/format";

/// The race to the pool.
///
/// Graduation is the loop this whole place runs on, and the launch closest to it is worth seeing
/// from anywhere, including from a different launch's page. One line: who is closest, how much
/// road is left, and the way in.
///
/// It is read through the board's own query family, so a trade anywhere on the market refreshes
/// the strip through the invalidation lib/live already does rather than through a second stream.
/// The timer underneath is what carries it when no stream ever connected.

const LIMIT = 5;

/// An amount off the wire is a string somebody else wrote, and `BigInt("")` throws. A strip that
/// cannot read one number should print the rest of the line rather than take the page down.
function big(value: string | undefined): bigint {
  try {
    return BigInt(value ?? "0");
  } catch {
    return 0n;
  }
}

const max0 = (value: bigint) => (value > 0n ? value : 0n);

export function GraduationRace({ current }: { current?: string }) {
  const race = useQuery({
    // "tokens" is the name lib/live invalidates the board on, and the rest of the key is this
    // strip's own, so it shares the refresh without sharing the board's cache entry.
    queryKey: ["tokens", "race"],
    queryFn: () => api<{ tokens: TokenRow[] }>(`/tokens?sort=progress&status=graduating&limit=${LIMIT}`),
    refetchInterval: 20_000,
  });

  const runners = race.data?.tokens ?? [];
  const leader: TokenRow | undefined = runners[0];

  // The contenders are what this strip is about, so they are what it asks the stream for: a buy on
  // any of them moves the number on screen in the same second. With nobody close the list is empty,
  // which lib/live reads as the whole market, and the whole market is exactly what a strip with no
  // leader is waiting for.
  const live = useLive({ tokens: runners.map((t) => t.token) });

  // What the reserve holds is indexed; what the whole curve costs is not, and only the curve knows
  // it. It is fixed at launch and never moves, so it is read once and never asked for again.
  const curve =
    leader && leader.mode === "curve" && leader.curve !== zeroAddress ? (leader.curve as Address) : undefined;
  const { data: raiseTarget } = useReadContract({
    address: curve,
    abi: hoodCurveAbi,
    functionName: "raiseTarget",
    query: { enabled: Boolean(curve), staleTime: Infinity },
  });

  const progress = leader ? launchProgress(leader) : 0;
  const left = Math.max(0, 1 - progress);
  const target = raiseTarget as bigint | undefined;
  // Three different things, and each says its own sentence. A direct launch has no curve and no
  // raise at all: its pool opens when the price has travelled far enough, so there is no amount and
  // none is invented. A curve whose target has not come back from the node yet is not the same
  // statement, and must not borrow that one.
  const needed = leader && curve && target !== undefined ? max0(target - big(leader.reserve)) : null;
  const distance: "amount" | "price" | "waiting" = !leader || curve === undefined ? "price" : needed === null ? "waiting" : "amount";
  const dec = leader ? pairDecimals(leader.pair_token) : 18;
  const sym = leader ? pairSymbol(leader.pair_token) : "";
  const here = Boolean(leader && current && leader.token.toLowerCase() === current.toLowerCase());
  const rest = runners.slice(1);

  return (
    <section className="panel race p-4" aria-labelledby="race-title">
      <div className="race-head">
        <h3 id="race-title">Closest to the pool</h3>
        {live && (
          <span className="tape-live">
            <i className="live-indicator" aria-hidden="true" /> live
          </span>
        )}
      </div>

      {race.isError ? (
        <p className="race-quiet">The board is not answering, so nobody can be placed in the race right now.</p>
      ) : !leader ? (
        // Nothing close is a fact about the market, not a hole in the page, so it is one quiet line
        // rather than the unfolding frame a whole empty page gets.
        <p className="race-quiet">
          {race.isLoading
            ? "Looking for the launch closest to its pool."
            : "Nothing is close to a pool yet. A launch appears here once it is halfway there."}
        </p>
      ) : (
        <>
          <Lead
            leader={leader}
            left={left}
            needed={needed}
            distance={distance}
            dec={dec}
            sym={sym}
            here={here}
          />
          <div className="card-progress" aria-hidden="true">
            <div style={{ width: `${Math.min(100, progress * 100)}%` }} />
          </div>
          {rest.length > 0 && (
            <p className="race-rest">
              behind it{" "}
              {rest.map((t) => (
                <Link key={t.token} href={`/token/${t.token}`}>
                  ${t.symbol} {(launchProgress(t) * 100).toFixed(0)}%
                </Link>
              ))}
            </p>
          )}
        </>
      )}
    </section>
  );
}

function Lead({
  leader, left, needed, distance, dec, sym, here,
}: {
  leader: TokenRow;
  left: number;
  needed: bigint | null;
  distance: "amount" | "price" | "waiting";
  dec: number;
  sym: string;
  here: boolean;
}) {
  const body = (
    <>
      <span className="race-ticker">${leader.symbol}</span>
      <span className="race-gap">
        <strong>{(left * 100).toFixed(1)}%</strong> left
      </span>
      <span className="race-need">
        {distance === "amount" && needed !== null
          ? `${fmt(needed, dec, 4)} ${sym} still to go in`
          : distance === "price"
            ? "its pool opens on price, not on an amount"
            : "reading what is left to raise"}
      </span>
      <span className="race-go">{here ? "you are on it" : "open"}</span>
    </>
  );
  // A link to the page the reader is already on does nothing when it is clicked, which reads as a
  // broken control. On its own page the leader is a line, not a way out.
  return here ? (
    <div className="race-lead is-here">{body}</div>
  ) : (
    <Link className="race-lead" href={`/token/${leader.token}`}>
      {body}
    </Link>
  );
}
