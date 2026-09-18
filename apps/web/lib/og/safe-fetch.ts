import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

/// Fetching a URL a stranger chose, from inside our own network.
///
/// A launch's artwork is metadata the creator wrote on chain, and the share card renders it server
/// side, which makes a plain `fetch(url)` a request-forgery gadget: anybody can launch a token whose
/// image points at `http://169.254.169.254/`, at a neighbour on the container network, or at a port
/// that only answers from inside, and then ask a crawler to fetch the card. The body never comes
/// back to them, but the request still happens, and how long it takes is an answer of its own.
///
/// So the address is checked before the connection, not after: https only, never an IP literal,
/// every address the name resolves to has to be a public one, and a redirect is refused rather than
/// followed, because a redirect is how a name that passed the check sends you somewhere else.
///
/// What remains is DNS rebinding: a name that answers publicly here and privately a millisecond
/// later, when fetch resolves it again. Closing that needs connecting to the address that was
/// checked and carrying the name in a Host header, which node's fetch does not offer. For a picture
/// on a card, with the body discarded unless it is a PNG, JPEG or GIF, that is a residual worth
/// naming rather than a hole worth a custom agent.

const PRIVATE_V4: [number, number][] = [
  [0x00000000, 8], // this network
  [0x0a000000, 8], // 10/8
  [0x64400000, 10], // 100.64/10, carrier grade NAT
  [0x7f000000, 8], // loopback
  [0xa9fe0000, 16], // link local, which is where cloud metadata lives
  [0xac100000, 12], // 172.16/12
  [0xc0000000, 24], // 192.0.0/24
  [0xc0a80000, 16], // 192.168/16
  [0xc6120000, 15], // 198.18/15, benchmarking
  [0xe0000000, 4], // multicast
  [0xf0000000, 4], // reserved, and broadcast with it
];

function v4ToInt(address: string): number | null {
  const parts = address.split(".");
  if (parts.length !== 4) return null;
  let out = 0;
  for (const part of parts) {
    const n = Number(part);
    if (!Number.isInteger(n) || n < 0 || n > 255) return null;
    out = (out << 8) | n;
  }
  return out >>> 0;
}

export function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) {
    const n = v4ToInt(address);
    if (n === null) return false;
    return !PRIVATE_V4.some(([base, bits]) => (n >>> (32 - bits)) === (base >>> (32 - bits)));
  }
  if (family === 6) {
    const a = address.toLowerCase();
    // A v4 address wearing a v6 hat is still that v4 address.
    const mapped = a.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isPublicAddress(mapped[1]!);
    if (a === "::" || a === "::1") return false;
    if (/^f[cd]/.test(a)) return false; // unique local
    if (/^fe[89ab]/.test(a)) return false; // link local
    if (/^ff/.test(a)) return false; // multicast
    return true;
  }
  return false;
}

export interface SafeFetchOptions {
  timeoutMs: number;
  maxBytes: number;
}

/// The bytes, or undefined for every reason a caller does not need to tell apart: not https, a name
/// that does not resolve, an address that is ours, a redirect, a body that is too big, a timeout.
export async function fetchPublicBytes(raw: string, opts: SafeFetchOptions): Promise<Uint8Array | undefined> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return undefined;
  }
  if (url.protocol !== "https:") return undefined;
  // An IP literal has no name to resolve and no reason to be in a creator's metadata.
  if (isIP(url.hostname) !== 0) return undefined;

  try {
    const addresses = await lookup(url.hostname, { all: true, verbatim: true });
    if (addresses.length === 0) return undefined;
    if (!addresses.every((a) => isPublicAddress(a.address))) return undefined;
  } catch {
    return undefined;
  }

  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(opts.timeoutMs),
      redirect: "manual",
      headers: { accept: "image/*" },
    });
    if (res.status >= 300 && res.status < 400) return undefined;
    if (!res.ok || !res.body) return undefined;

    const declared = Number(res.headers.get("content-length") ?? 0);
    if (declared > opts.maxBytes) return undefined;

    // Counted while it arrives, because content-length is also something the other end chooses.
    const chunks: Uint8Array[] = [];
    let total = 0;
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
      total += chunk.byteLength;
      if (total > opts.maxBytes) return undefined;
      chunks.push(chunk);
    }
    if (total === 0) return undefined;
    const bytes = new Uint8Array(total);
    let at = 0;
    for (const chunk of chunks) { bytes.set(chunk, at); at += chunk.byteLength; }
    return bytes;
  } catch {
    return undefined;
  }
}
