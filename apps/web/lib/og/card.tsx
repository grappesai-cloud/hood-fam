import { ImageResponse } from "next/og";
import type { TokenRow } from "@/lib/api";
import { compact, imageUrl, launchProgress, pairDecimals, pairSymbol, shortAddress } from "@/lib/format";
import { shareFontsOrNone } from "./fonts";

/// The picture a pasted `/token/0x...` link unfurls into, drawn here rather than handed over as
/// the token's own artwork. A launch's art is a square a stranger uploaded: on X it is cropped to
/// a letterbox with no name, no ticker and no number on it, and half the launches have no art at
/// all, so the link went out as text. This draws the card the site would draw: the name, the
/// ticker, the art when there is any, the cap, how far it is from the pool, and the wordmark.
///
/// Every step of it degrades. The indexer not answering, artwork that is a dead link, a font that
/// is not where it should be: each one falls back to something still branded, because the caller
/// is a crawler that gets one try and shows nothing at all on a 500.

export const CARD_SIZE = { width: 1200, height: 630 } as const;
export const CARD_CONTENT_TYPE = "image/png";
export const CARD_ALT = "hood.fam launch card";

/// Read straight out of the env rather than through `lib/config`: that module builds the wagmi
/// config at import time, and an image route has no business pulling a wallet stack into the
/// server bundle. Same reason `lib/site` keeps its distance.
const API = process.env.NEXT_PUBLIC_API_URL ?? "http://127.0.0.1:8080";

/// A crawler waits, but not for long, and a slow gateway must not hold the card hostage.
const TOKEN_TIMEOUT_MS = 2_500;
const ART_TIMEOUT_MS = 2_500;
/// Artwork bigger than this is somebody's 4000px png; it would be scaled into a 260px square
/// anyway, and decoding it costs the render more than the square is worth.
const ART_MAX_BYTES = 4_000_000;
/// The board moves every few seconds; a card that a crawler cached for an hour does not need to.
const REVALIDATE_SECONDS = 60;

const INK = "#111111";
const LINE = "#333333";
const DIM = "#949494";
const TEXT = "#f4f4f4";
const LIME = "#ccff00";

/// What the card reads off a launch. Everything is optional because this comes back as JSON from
/// a service that may be mid-migration, and a missing field must dim a line, not throw.
type ShareToken = Partial<Pick<
  TokenRow,
  "name" | "symbol" | "image" | "price" | "total_supply" | "pair_token" | "mode" | "status"
  | "sold" | "curve_supply" | "bonded" | "tick_start" | "tick_bond" | "last_tick"
>>;

/// The card's font carries Latin and little else. A glyph it does not have draws as a blank box,
/// and an emoji sends `next/og` off to a CDN in the middle of the render, so a name a stranger
/// typed is cut down to what can actually be drawn before it goes anywhere near satori.
const UNDRAWABLE = /[^ -~ -ſ‐-—‘’“”•…]/g;

function drawable(text: string | undefined, max: number): string {
  const clean = (text ?? "").replace(UNDRAWABLE, " ").replace(/\s+/g, " ").trim();
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

function big(value: string | undefined): bigint {
  try {
    return BigInt(value || "0");
  } catch {
    return 0n;
  }
}

/// A long name has to fit the same box a short one does.
function nameSize(name: string): number {
  if (name.length <= 13) return 82;
  if (name.length <= 20) return 66;
  if (name.length <= 28) return 54;
  return 44;
}

async function loadToken(address: string): Promise<ShareToken | undefined> {
  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) return undefined;
  try {
    const res = await fetch(`${API}/tokens/${address}`, {
      signal: AbortSignal.timeout(TOKEN_TIMEOUT_MS),
      next: { revalidate: REVALIDATE_SECONDS },
    });
    if (!res.ok) return undefined;
    return (await res.json()) as ShareToken;
  } catch {
    return undefined;
  }
}

/// satori draws png, apng, gif and jpeg and throws on everything else, and a throw inside the
/// render takes the whole card with it. So the bytes are fetched here, sniffed here, and anything
/// that is not one of those is simply not art: the card falls back to the initials tile the board
/// already uses for a broken image.
function imageType(bytes: Uint8Array): string | undefined {
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return "image/png";
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) return "image/gif";
  return undefined;
}

async function loadArtwork(raw: string | undefined): Promise<string | undefined> {
  const url = imageUrl(raw ?? "");
  if (!/^https?:\/\//i.test(url)) return undefined;
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(ART_TIMEOUT_MS),
      next: { revalidate: REVALIDATE_SECONDS },
    });
    if (!res.ok) return undefined;
    const bytes = new Uint8Array(await res.arrayBuffer());
    if (bytes.byteLength === 0 || bytes.byteLength > ART_MAX_BYTES) return undefined;
    const type = imageType(bytes);
    if (!type) return undefined;
    return `data:${type};base64,${Buffer.from(bytes).toString("base64")}`;
  } catch {
    return undefined;
  }
}

function Frame({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        justifyContent: "space-between",
        width: "100%",
        height: "100%",
        padding: "54px 60px",
        background: INK,
        backgroundImage: `linear-gradient(135deg, #191919 0%, ${INK} 58%)`,
        color: TEXT,
        fontFamily: "Inter",
      }}
    >
      {children}
    </div>
  );
}

function Header() {
  return (
    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
      <div style={{ display: "flex", fontSize: 40, fontWeight: 800, letterSpacing: "-0.07em" }}>
        <span style={{ color: "#ffffff" }}>hood</span>
        <span style={{ color: LIME }}>.fam</span>
      </div>
      <div style={{ display: "flex", fontSize: 22, letterSpacing: "0.06em", color: DIM }}>
        ROBINHOOD CHAIN · 4663
      </div>
    </div>
  );
}

function Art({ art, symbol }: { art?: string; symbol: string }) {
  if (art) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={art}
        alt=""
        width={260}
        height={260}
        style={{ width: 260, height: 260, borderRadius: 30, objectFit: "cover", background: "#1d1d1d" }}
      />
    );
  }
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        width: 260,
        height: 260,
        borderRadius: 30,
        background: "#343434",
        color: LIME,
        fontSize: 96,
        fontWeight: 800,
        letterSpacing: "-0.05em",
      }}
    >
      {symbol.slice(0, 2).toUpperCase() || "??"}
    </div>
  );
}

function Launch({ token, art, address }: { token: ShareToken; art?: string; address: string }) {
  const symbol = drawable(token.symbol, 12) || "???";
  const name = drawable(token.name, 34) || shortAddress(address);
  const pair = token.pair_token ?? "";
  const cap = compact((big(token.price) * big(token.total_supply)) / 10n ** 18n, pairDecimals(pair));
  const direct = token.mode === "direct";
  const graduated = token.status === "graduated" || (direct && Boolean(token.bonded));
  const progress = launchProgress({
    mode: token.mode ?? "curve",
    sold: token.sold ?? "0",
    curve_supply: token.curve_supply ?? "0",
    bonded: Boolean(token.bonded),
    tick_start: token.tick_start ?? null,
    tick_bond: token.tick_bond ?? null,
    last_tick: token.last_tick ?? null,
  });
  const percent = Math.max(0, Math.min(100, progress * 100));
  const machine = direct
    ? "Direct · the whole supply in the pool from block one"
    : "Curve · sold on a curve, then into a pool";

  return (
    <Frame>
      <Header />

      <div style={{ display: "flex", alignItems: "center", gap: 44 }}>
        <Art art={art} symbol={symbol} />
        <div style={{ display: "flex", flexDirection: "column", flexGrow: 1 }}>
          <div
            style={{
              display: "flex",
              color: "#ffffff",
              fontSize: nameSize(name),
              fontWeight: 800,
              letterSpacing: "-0.045em",
              lineHeight: 1.05,
            }}
          >
            {name}
          </div>
          <div style={{ display: "flex", marginTop: 12, fontSize: 32, color: DIM }}>${symbol}</div>
          <div style={{ display: "flex", alignItems: "baseline", gap: 14, marginTop: 30 }}>
            <span style={{ color: LIME, fontSize: 64, fontWeight: 800, letterSpacing: "-0.04em" }}>{cap}</span>
            <span style={{ color: DIM, fontSize: 26, letterSpacing: "0.04em" }}>
              {pairSymbol(pair)} MARKET CAP
            </span>
          </div>
        </div>
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", fontSize: 26 }}>
          <span style={{ color: DIM }}>{machine}</span>
          <span style={{ color: graduated ? LIME : TEXT, fontWeight: 800, letterSpacing: "0.02em" }}>
            {graduated ? "GRADUATED" : `${percent.toFixed(0)}% to the pool`}
          </span>
        </div>
        <div style={{ display: "flex", width: "100%", height: 14, borderRadius: 999, background: "#242424" }}>
          <div
            style={{
              display: "flex",
              width: `${graduated ? 100 : percent}%`,
              height: "100%",
              borderRadius: 999,
              background: LIME,
            }}
          />
        </div>
      </div>
    </Frame>
  );
}

/// What a crawler gets when the indexer does not answer, or when the address in the link is not
/// one. It still says whose site this is and which chain it is on.
function Unknown({ address }: { address: string }) {
  const known = /^0x[0-9a-fA-F]{40}$/.test(address);
  return (
    <Frame>
      <Header />
      <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
        <div style={{ display: "flex", color: "#ffffff", fontSize: 72, fontWeight: 800, letterSpacing: "-0.05em" }}>
          A launch on hood.fam
        </div>
        <div style={{ display: "flex", color: DIM, fontSize: 30 }}>
          The board is catching up with this one. Open it to see where it stands.
        </div>
      </div>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          paddingTop: 26,
          borderTop: `1px solid ${LINE}`,
          fontSize: 26,
          color: DIM,
        }}
      >
        <span>{known ? shortAddress(address) : "hood.fam"}</span>
        <span>What the house takes, the fam gets back.</span>
      </div>
    </Frame>
  );
}

/// The one entry point both image routes use.
export async function tokenShareCard(address: string): Promise<ImageResponse> {
  const fonts = shareFontsOrNone();
  const token = await loadToken(address);
  const art = token ? await loadArtwork(token.image) : undefined;
  return new ImageResponse(
    token ? <Launch token={token} art={art} address={address} /> : <Unknown address={address} />,
    { ...CARD_SIZE, fonts },
  );
}
