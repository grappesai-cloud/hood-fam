import type { ServerResponse } from "node:http";
import pg from "pg";
import type { FastifyInstance } from "fastify";

import { pool } from "./db.js";

/// The live feed, and the one wire that makes it work in either deployment.
///
/// The indexer and the API are one process by default and two when INDEXER=0 splits them, so an
/// event cannot be handed over in memory: the process that watches a trade land is not always the
/// one holding the readers' connections. Postgres is already between them and LISTEN/NOTIFY is the
/// hand-off it ships with, so whoever writes the row announces it and every API instance fans it
/// out to its own readers. Two API replicas both get every event, which is what a reader on either
/// of them needs.
const CHANNEL = "hood_events";

/// `bag` is one row of the money tape as it lands (kind, token, asset, amount, tx, at, extra); `king`
/// is a king-of-the-hill round moving (token, king, pot, ends_at, and `won` once the timer ran out).
/// Both carry the token when the event has one, so a `?tokens=` reader gets its own pot and penalties.
export type StreamEvent = "trade" | "launch" | "graduated" | "message" | "fee" | "bag" | "king";

/// Postgres refuses a NOTIFY payload over 8000 bytes, and it refuses it on the write that sent it,
/// so an oversized one must never reach it. A chat body is capped at 280 characters and a trade is
/// addresses and digits, but a launch carries a name and a ticker straight off the chain and those
/// are whatever the launcher typed. Over the limit only a reference goes down the channel and the
/// listening side reads the row back, so a reader always gets the documented shape.
const MAX_PAYLOAD = 7000;

/// A reader holds one connection for as long as the tab is open, so the caps are on connections
/// rather than on requests. Ten per address is several tabs and a phone on the same wifi; two
/// thousand is what one instance will carry before it is the memory that suffers.
const MAX_PER_IP = 10;
const MAX_READERS = 2000;
/// Proxies close a connection that has been silent for a while, commonly at thirty or sixty
/// seconds, and a feed on a quiet night is silent for hours.
const PING_MS = 25_000;
/// A reader that stopped reading still has a socket, and Node buffers everything it cannot write
/// into it. A megabyte of backlog is a dead connection, not a slow one.
const MAX_BACKLOG = 1_000_000;
/// A filter is a query string, and a query string is a thing a caller can make a megabyte long.
const MAX_FILTER = 100;

interface Reader {
  ip: string;
  /// null is everything; a set is what the ?tokens= filter named.
  tokens: Set<string> | null;
  res: ServerResponse;
  /// Closing a connection can raise the error that closes it again, so a reader is let go once.
  closed: boolean;
}

const readers = new Set<Reader>();
/// Insertion order is age, which is what "drop the oldest" needs and what a Set already keeps.
const byIp = new Map<string, Set<Reader>>();

/// What the stream cannot assemble on its own. A chat message is three tables wide and the bus has
/// no business knowing that, so the one query it cannot write is handed in by whoever registers it.
export interface StreamDeps {
  message(id: number): Promise<Record<string, unknown> | null>;
}

/// Said once the row is in, never before: a reader told about a trade goes and looks for it.
/// A feed that cannot be published is not worth failing an index pass over, so this only logs.
export async function notify(
  event: StreamEvent,
  data: Record<string, unknown>,
  ref?: Record<string, string | number>,
): Promise<void> {
  try {
    let payload = JSON.stringify({ event, data });
    if (Buffer.byteLength(payload) > MAX_PAYLOAD) {
      if (!ref) return;
      payload = JSON.stringify({ event, ref });
    }
    await pool.query(`select pg_notify($1, $2)`, [CHANNEL, payload]);
  } catch (err) {
    console.warn(`stream: could not publish a ${event} event`, err instanceof Error ? err.message : err);
  }
}

function drop(reader: Reader) {
  if (reader.closed) return;
  reader.closed = true;
  readers.delete(reader);
  const mine = byIp.get(reader.ip);
  if (mine) {
    mine.delete(reader);
    if (!mine.size) byIp.delete(reader.ip);
  }
  if (!reader.res.writableEnded) reader.res.end();
}

function write(reader: Reader, frame: string) {
  if (reader.closed || reader.res.writableEnded) {
    drop(reader);
    return;
  }
  if (reader.res.writableLength > MAX_BACKLOG) {
    drop(reader);
    return;
  }
  reader.res.write(frame);
}

function fanout(event: string, data: Record<string, unknown>) {
  const token = typeof data.token === "string" ? data.token.toLowerCase() : null;
  const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const reader of [...readers]) {
    // A filtered reader asked for those tokens and nothing else, including an event with no token
    // on it at all.
    if (reader.tokens && (token === null || !reader.tokens.has(token))) continue;
    write(reader, frame);
  }
}

/// A payload that did not fit came down the channel as a reference, so the row is read back here
/// rather than in the browser: every reader sees the same shape whatever the size of the original.
async function hydrate(event: string, ref: Record<string, unknown>, deps: StreamDeps): Promise<Record<string, unknown> | null> {
  if (event === "launch") {
    const { rows } = await pool.query<{ token: string; symbol: string; name: string; creator: string; mode: string; launched_at: Date }>(
      `select token, symbol, name, creator, mode, launched_at from launches where token = $1`,
      [String(ref.token ?? "").toLowerCase()],
    );
    if (!rows[0]) return null;
    return { token: rows[0].token, symbol: rows[0].symbol, name: rows[0].name, creator: rows[0].creator, mode: rows[0].mode, at: rows[0].launched_at };
  }
  if (event === "message") return deps.message(Number(ref.id));
  return null;
}

async function deliver(payload: string | undefined, deps: StreamDeps) {
  if (!payload) return;
  let parsed: { event?: string; data?: Record<string, unknown>; ref?: Record<string, unknown> };
  try {
    parsed = JSON.parse(payload);
  } catch {
    return;
  }
  if (!parsed.event) return;
  const data = parsed.data ?? (parsed.ref ? await hydrate(parsed.event, parsed.ref, deps) : null);
  if (data) fanout(parsed.event, data);
}

/// One connection of its own, because a connection that is LISTENing cannot be handed back to the
/// pool and used for a query. It drops when the database restarts or a proxy times it out, so it
/// comes back on its own; events during the gap are lost, which is what a live feed is. Anything
/// that has to be complete is a list the reader refetches.
function listen(app: FastifyInstance, deps: StreamDeps) {
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
  let gone = false;
  const again = (err: unknown) => {
    if (gone) return;
    gone = true;
    app.log.warn({ err: err instanceof Error ? err.message : err }, "stream: the event connection dropped, reconnecting");
    client.end().catch(() => {});
    setTimeout(() => listen(app, deps), 2_000).unref();
  };
  client.on("error", again);
  client.on("end", () => again(new Error("connection ended")));
  client.on("notification", (msg) => void deliver(msg.payload, deps));
  client
    .connect()
    .then(() => client.query(`listen ${CHANNEL}`))
    .then(() => app.log.info("stream: listening for events"))
    .catch(again);
}

/// Server-sent events rather than a socket: the feed only ever travels one way, a browser gets
/// EventSource for free and reconnects on its own, and every proxy in the path already knows what
/// to do with a long-lived GET.
export function registerStream(app: FastifyInstance, deps: StreamDeps) {
  listen(app, deps);
  const ping = setInterval(() => {
    for (const reader of [...readers]) write(reader, "event: ping\ndata: {}\n\n");
  }, PING_MS);
  // One timer for every reader, and it never keeps the process alive on its own.
  ping.unref();

  app.get("/stream", { config: { rateLimit: false } }, async (req, reply) => {
    const q = req.query as { tokens?: string };
    let tokens: Set<string> | null = null;
    if (q.tokens?.trim()) {
      const wanted = q.tokens.split(",").map((t) => t.trim().toLowerCase()).filter(Boolean);
      if (wanted.length > MAX_FILTER) {
        return reply.code(400).send({
          error: "too_many_tokens",
          reason: `A stream follows at most ${MAX_FILTER} tokens; leave the filter off to follow every launch.`,
        });
      }
      tokens = new Set(wanted);
    }
    if (readers.size >= MAX_READERS) {
      return reply.code(503).send({
        error: "too_many_readers",
        reason: "This instance is holding as many live connections as it will; try again shortly.",
      });
    }

    const ip = req.ip;
    const mine = byIp.get(ip) ?? new Set<Reader>();
    // The oldest goes, not the newest. A tab that was closed or put to sleep leaves a connection
    // that only the timeout will clear, and refusing the new one would lock a person out of the
    // site they are looking at because of the tab they already left.
    while (mine.size >= MAX_PER_IP) {
      const oldest = mine.values().next().value;
      if (!oldest) break;
      drop(oldest);
    }

    // Hijacked, so nothing in the response pipeline touches it: the gzip hook would buffer a body
    // that never ends, and the cache hook would put an age on a connection rather than on an answer.
    reply.hijack();
    const res = reply.raw;
    const head: Record<string, string> = {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-store, no-transform",
      connection: "keep-alive",
      // Nginx and most reverse proxies buffer a response body by default, which turns a live feed
      // into a feed that arrives in lumps whenever the buffer happens to fill.
      "x-accel-buffering": "no",
    };
    // CORS was decided by the plugin in its own hook and written onto the reply; hijacking means
    // Fastify never sends those headers, so they are carried across by hand.
    for (const [key, value] of Object.entries(reply.getHeaders())) {
      if (typeof value === "string" && (key.startsWith("access-control-") || key === "vary")) head[key] = value;
    }
    res.writeHead(200, head);
    // Frames are small and a feed is about latency, so they go out rather than wait for company.
    res.socket?.setNoDelay(true);
    // Bytes immediately, so a proxy waiting on the first byte lets the connection through, and a
    // reconnect after a drop is three seconds rather than whatever the browser felt like.
    res.write(": hood.fam stream\nretry: 3000\n\n");

    const reader: Reader = { ip, tokens, res, closed: false };
    readers.add(reader);
    mine.add(reader);
    byIp.set(ip, mine);

    req.raw.on("close", () => drop(reader));
    res.on("error", () => drop(reader));
  });
}
