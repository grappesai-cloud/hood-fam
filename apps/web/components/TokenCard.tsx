import Link from "next/link";
import type { TokenRow } from "@/lib/api";
import { ago, compact, imageUrl, launchProgress, pairDecimals, pairSymbol, shortAddress } from "@/lib/format";
import { Artwork } from "./Artwork";

/// One launch. The picture leads, full width across the top, but on a wide strip rather than the
/// tall square it used to be: the same artwork gets more area and the card stays short enough that
/// a screen shows a market. Everything under it is the reading: what it is worth, how far it has to
/// go, and the one action.
export function TokenCard({ t, spotlight, flag }: { t: TokenRow; spotlight?: boolean; flag?: string }) {
  const progress = launchProgress(t);
  const decimals = pairDecimals(t.pair_token, t);
  const mcap = (BigInt(t.price || "0") * BigInt(t.total_supply || "0")) / 10n ** 18n;
  const graduated = t.status === "graduated";
  const direct = t.mode === "direct";
  const tag = direct ? "In the pool" : graduated ? "Graduated" : "On the curve";
  const stage = direct ? "in the pool" : graduated ? "graduated" : `${Math.round(progress * 100)}% to the pool`;
  // The gauge reads full for a launch with nowhere left to go, so a graduated token and a direct one
  // are not drawn as though they had stalled at zero.
  const fill = direct || graduated ? 1 : progress;
  // The one fact a buyer most wants and can least check by eye: whether the creator's own first buy
  // is locked in the vault, and until when. It is on chain, so the card can simply say it.
  const devLocked = BigInt(t.first_buy_locked || "0") > 0n
    && (!t.first_buy_unlock_at || new Date(t.first_buy_unlock_at).getTime() > Date.now());

  return (
    <Link href={`/token/${t.token}`} className={spotlight ? "token-card spot spotlight" : "token-card spot"}>
      <div className="token-art">
        <Artwork src={imageUrl(t.image)} symbol={t.symbol} size={520} rounded="rounded-none" />
        <span className="token-art-badge">{flag ?? tag}</span>
        {devLocked && <span className="token-locked" title="The creator's first buy is held by the locker and cannot be sold until it comes free">dev locked</span>}
        <span className="token-age">{ago(t.launched_at)}</span>
      </div>

      <div className="token-body">
        <div className="token-id">
          <strong>{t.name}</strong>
          <span>${t.symbol}</span>
        </div>

        <div className="token-figure">
          <strong>{compact(mcap, decimals)}</strong>
          <small>{pairSymbol(t.pair_token, t)} MC</small>
        </div>

        <div className={fill >= 1 ? "card-progress done" : "card-progress"} role="img"
          aria-label={direct ? "trading in the pool" : graduated ? "graduated" : `${Math.round(progress * 100)} percent of the way to graduation`}>
          <div style={{ width: `${Math.min(100, fill * 100).toFixed(1)}%` }} />
        </div>

        <div className="token-card-bottom">
          <span className={direct || graduated ? "token-state on" : "token-state"}>{stage}</span>
          <span className="token-addr">{shortAddress(t.token)}</span>
          <span className="token-go">trade →</span>
        </div>
      </div>
    </Link>
  );
}
