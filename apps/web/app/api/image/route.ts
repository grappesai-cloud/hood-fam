import { NextResponse } from "next/server";
import { generateImage } from "@hood/sdk/image";

const WINDOW_MS = 60 * 60 * 1000;
const CONFIGURED = Number(process.env.IMAGE_RATE_LIMIT_PER_HOUR);
const LIMIT = Number.isFinite(CONFIGURED) && CONFIGURED > 0 ? Math.floor(CONFIGURED) : 10;

/// One counter per caller, per hour, held in this process only. A second instance doubles the
/// allowance, which is fine: the real cap is the provider's own budget, and this is here to stop a
/// stranger looping the key rather than to bill anyone exactly.
const hits = new Map<string, { count: number; resetAt: number }>();
let sweptAt = 0;

/// Expired counters go out at most once a window, on whichever request notices. No timer, because
/// a route handler that keeps one alive keeps the process awake for nothing.
function sweep(now: number) {
  if (now - sweptAt < WINDOW_MS) return;
  sweptAt = now;
  for (const [key, seen] of hits) if (seen.resetAt <= now) hits.delete(key);
}

/// Who to count this against. Not the FIRST hop of x-forwarded-for: that entry is whatever the
/// caller typed, and a proxy appends rather than rewrites, so one curl with a random header is a
/// fresh bucket every request and the limit below counts nothing. The LAST entry is the address our
/// own proxy saw, which is the closest thing to the caller that cannot be forged. x-real-ip, which
/// Traefik sets from the same peer, is the same claim in one value. With neither, everybody shares
/// one bucket, which is the safe way to be wrong.
function caller(req: Request): string {
  const forwarded = req.headers.get("x-forwarded-for");
  if (forwarded) {
    const hops = forwarded.split(",").map((h) => h.trim()).filter(Boolean);
    const last = hops[hops.length - 1];
    if (last) return last;
  }
  return req.headers.get("x-real-ip")?.trim() || "unknown";
}

function overLimit(req: Request): boolean {
  const now = Date.now();
  sweep(now);
  const key = caller(req);
  const seen = hits.get(key);
  if (!seen || seen.resetAt <= now) {
    hits.set(key, { count: 1, resetAt: now + WINDOW_MS });
    return false;
  }
  seen.count += 1;
  return seen.count > LIMIT;
}

/// The image key lives on the server, never in the browser bundle.
export async function POST(req: Request) {
  try {
    const { prompt } = (await req.json()) as { prompt?: string };
    if (!prompt) return NextResponse.json({ error: "no prompt" }, { status: 400 });
    if (!process.env.OPENROUTER_API_KEY) {
      return NextResponse.json({ error: "art generation is off: no OPENROUTER_API_KEY on the server" }, { status: 501 });
    }
    if (overLimit(req)) {
      return NextResponse.json(
        { error: `art generation is capped at ${LIMIT} images an hour from one address, so this one has to wait.` },
        { status: 429 },
      );
    }
    const img = await generateImage({ prompt });
    return NextResponse.json({ dataUri: img.dataUri, model: img.model });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
