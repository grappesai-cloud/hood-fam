import Link from "next/link";
import type { TokenRow } from "@/lib/api";
import { ago, compact, imageUrl, launchProgress, pairDecimals, pairSymbol, shortAddress } from "@/lib/format";
import { Artwork } from "./Artwork";

export function TokenCard({ t }: { t: TokenRow }) {
  const progress = launchProgress(t);
  const decimals = pairDecimals(t.pair_token);
  const mcap = (BigInt(t.price || "0") * BigInt(t.total_supply || "0")) / 10n ** 18n;
  const graduated = t.status === "graduated";
  return (
    <Link href={`/token/${t.token}`} className="token-card">
      <div className="token-art">
        <Artwork src={imageUrl(t.image)} symbol={t.symbol} size={320} rounded="rounded-xl" />
        <span className="token-art-badge">{t.mode === "direct" ? "Pool" : graduated ? "Graduated" : "On curve"}</span>
      </div>
      <div className="token-card-body">
        <div className="token-card-name"><h3>{t.name}</h3><span>{ago(t.launched_at)}</span></div>
        <div className="token-symbol">$<span>{t.symbol}</span></div>
        <div className="token-card-mcap">{compact(mcap, decimals)} <small>{pairSymbol(t.pair_token)} MC</small></div>
        <div className="token-card-bottom"><span>{shortAddress(t.token)}</span><span>{t.mode === "direct" ? "Live" : graduated ? "Graduated" : `${Math.round(progress * 100)}%`}</span></div>
        {t.mode !== "direct" && !graduated && <div className="card-progress"><div style={{ width: `${Math.min(100, progress * 100).toFixed(1)}%` }} /></div>}
      </div>
    </Link>
  );
}
