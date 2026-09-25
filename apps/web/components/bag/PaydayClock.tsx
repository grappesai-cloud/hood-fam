"use client";

import { useEffect, useState } from "react";
import { ago, fmt } from "@/lib/format";
import { Prov } from "@/components/Provenance";
import { assetOf, big, type BagPayday } from "@/lib/bag";

/// Payday pays at the top of every hour: the hour's pot to the hour's wallets by points, plus a
/// slice to the last ten launches. The countdown runs on the reader's clock and takes the API's
/// `endsAt` as the truth whenever it arrives, so a laptop that is a minute off still lands on the
/// hour the keeper pays.

function topOfHour(now: number): number {
  return (Math.floor(now / 3_600_000) + 1) * 3_600_000;
}

function pad(n: number): string {
  return String(Math.max(0, n)).padStart(2, "0");
}

/// The time to the next Payday, as mm:ss. Null before the first client tick, because the server
/// and the first client render must agree on what they draw.
export function usePaydayCountdown(endsAt?: string | null): { text: string | null; due: boolean } {
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, []);
  if (now == null) return { text: null, due: false };
  const reported = endsAt ? Date.parse(endsAt) : NaN;
  // An `endsAt` in the past is an hour the keeper has not closed yet; the clock says so rather
  // than counting up, and the next read of the API moves it on.
  const target = Number.isFinite(reported) && reported > now ? reported : topOfHour(now);
  const due = Number.isFinite(reported) && reported <= now;
  const left = Math.max(0, Math.floor((target - now) / 1000));
  return { text: due ? "00:00" : `${pad(Math.floor(left / 60))}:${pad(left % 60)}`, due };
}

export function PaydayClock({ payday, missing }: { payday: BagPayday | null | undefined; missing: boolean }) {
  const { text, due } = usePaydayCountdown(payday?.endsAt);
  const pot = (payday?.pot ?? []).filter((p) => big(p.funded) + big(p.carried) > 0n);
  const last = payday?.last ?? null;
  const lastAsset = last ? assetOf(last.asset, { symbol: last.symbol, decimals: last.decimals }) : null;

  return (
    <section className="panel bag-card">
      <header className="refer-head">
        <h2>Payday</h2>
        <span className="dim text-sm">every hour, on the hour</span>
      </header>
      <div className="bag-clock" aria-live="off">
        <strong className="mono">{text ?? "--:--"}</strong>
        <span>{due ? "the hour is up, the keeper is paying it" : "until the next Payday"}</span>
      </div>
      <div className="bag-rows">
        <div>
          <span>this hour&apos;s pot</span>
          <span className="mono">
            {missing
              ? <span className="figure-dash" title="the API does not serve the Bag yet">—</span>
              : pot.length === 0
                ? <span className="figure-dash" title="nothing has been funded this hour">—</span>
                : pot.map((p) => {
                    const { symbol, decimals } = assetOf(p.asset, p);
                    return <span key={p.asset} className="bag-amount">{fmt(big(p.funded) + big(p.carried), decimals, decimals >= 18 ? 4 : 2)} {symbol}</span>;
                  })}
            {" "}<Prov kind="measured" />
          </span>
        </div>
        {!missing && pot.length === 0 && <p className="bag-reason">Nothing has been funded this hour. Every trade puts a tenth of the Bag&apos;s share here.</p>}
        <div>
          <span>last hour</span>
          <span className="mono">
            {last && lastAsset
              ? <>{last.wallets.toLocaleString("en-US")} wallets got {fmt(big(last.toWallets), lastAsset.decimals, lastAsset.decimals >= 18 ? 4 : 2)} {lastAsset.symbol}{big(last.toLaunches) > 0n && <>, the last ten launches {fmt(big(last.toLaunches), lastAsset.decimals, lastAsset.decimals >= 18 ? 4 : 2)}</>} <Prov kind="measured" /></>
              : <span className="figure-dash" title="Payday has not paid an hour yet">—</span>}
          </span>
        </div>
        {!last && !missing && <p className="bag-reason">Payday has not paid an hour yet. The first paid hour is written here.</p>}
        {last?.paid_at && <p className="bag-reason">paid {ago(last.paid_at)} ago, hour {last.epoch}</p>}
      </div>
      <p className="bag-fine">You trade in the hour, you earn points; at the top of the hour the pot is split by points. A tenth goes to the holders of the ten launches before yours.</p>
    </section>
  );
}
