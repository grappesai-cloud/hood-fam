import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { createPublicClient, http, isAddress, verifyMessage } from "viem";
import { z } from "zod";

import { robinhood } from "@hood/sdk";

import { isAdmin } from "./admin.js";
import { currentSeason, pool } from "./db.js";
import { notify } from "./events.js";
import { RANKS, rankFor } from "./points.js";
import { isSystem } from "./system.js";

/// One room per token, for the people who are in it.
///
/// The right to speak is a position, not an account: a wallet that holds the token or has traded it
/// once may post, and nothing else may. That is the whole of the anti-spam story, and it is the
/// reason there is no sign-up, no password and no profile anywhere in here. A wallet proves itself
/// once with a signature and carries a session afterwards, because asking for a signature per
/// message teaches people to sign whatever they are shown.
const SESSION_MS = 7 * 24 * 60 * 60 * 1000;
const NONCE_MS = 5 * 60 * 1000;
const MAX_BODY = 280;
/// Per wallet, not per IP: an IP is one coffee shop and a wallet is one voice. One message every
/// five seconds keeps a room readable; thirty an hour keeps it a conversation rather than a feed.
const EVERY_MS = 5_000;
const PER_HOUR = 30;

export type ChatMessage = {
  id: number;
  token: string;
  author: string;
  /// null when the message is hidden and the reader is not its author.
  body: string | null;
  at: Date;
  rank: string;
  holdingBps: number;
  isCreator: boolean;
  hidden: boolean;
};

interface Row {
  id: string;
  token: string;
  author: string;
  body: string;
  created_at: Date;
  hidden_by: string | null;
}

/// Every refusal says which rule it was and why, because a room that only answers 403 is a room
/// nobody can work out how to be let into.
const refuse = (reply: FastifyReply, status: number, error: string, reason: string) =>
  reply.code(status).send({ error, reason });

const clamp = (value: unknown, fallback: number, max: number, min = 1): number => {
  const n = Math.floor(Number(value));
  if (!Number.isFinite(n) || n < min) return fallback;
  return Math.min(n, max);
};

// ---------------------------------------------------------------- the session

/// Signed here, stored nowhere: a session is the address and its expiry with an HMAC over both, so
/// any instance can check one without a shared table and a restart does not sign anybody out.
/// Resolved once at boot rather than per call, because a secret that changes invalidates every
/// session signed with the old one, and a random one has to at least outlive the process that made it.
let SECRET: Buffer = randomBytes(32);

function resolveSecret(app: FastifyInstance) {
  const configured = process.env.CHAT_SECRET || process.env.HOOD_ADMIN_TOKEN;
  if (configured) {
    SECRET = Buffer.from(configured);
    return;
  }
  SECRET = randomBytes(32);
  app.log.warn(
    "CHAT_SECRET is not set: chat sessions are signed with a secret made at boot, so every restart signs every wallet out. Set CHAT_SECRET (or HOOD_ADMIN_TOKEN) to keep them.",
  );
}

const mac = (body: string) => createHmac("sha256", SECRET).update(body).digest();

function issueSession(address: string): { token: string; expiresAt: Date } {
  const expiresAt = Date.now() + SESSION_MS;
  const body = `${address}:${expiresAt}`;
  return {
    token: `${Buffer.from(body).toString("base64url")}.${mac(body).toString("base64url")}`,
    expiresAt: new Date(expiresAt),
  };
}

/// The wallet behind a request, or null. Everything after the one signature check takes this and
/// nothing else, so no route past /chat/session ever handles a signature.
function sessionOf(req: FastifyRequest): string | null {
  const given = (req.headers.authorization ?? "").replace(/^Bearer\s+/i, "");
  const [head, sig] = given.split(".");
  if (!head || !sig) return null;
  const body = Buffer.from(head, "base64url").toString("utf8");
  const [address, expiry] = body.split(":");
  if (!address || !expiry) return null;
  const want = mac(body);
  const got = Buffer.from(sig, "base64url");
  if (want.length !== got.length || !timingSafeEqual(want, got)) return null;
  if (!Number(expiry) || Number(expiry) <= Date.now()) return null;
  return address;
}

/// Where the site is served from, for the line the wallet shows first.
const SITE = (() => {
  const url = process.env.NEXT_PUBLIC_SITE_URL?.trim();
  if (!url) return "hood.fam";
  try {
    return new URL(url).host;
  } catch {
    return "hood.fam";
  }
})();

/// What the wallet is asked to sign. It names the site, the wallet, the nonce and when the request
/// dies, because a signature prompt that says none of those is one nobody can check, and signing
/// what you cannot check is the habit that empties wallets. Kept with the nonce and verified byte
/// for byte, so the string that is checked is the string the wallet showed.
const loginMessage = (address: string, nonce: string, expires: Date) =>
  `${SITE} wants you to sign in to chat.

This signature proves the wallet is yours. It is not a transaction: it moves nothing and costs nothing.

Wallet: ${address}
Nonce: ${nonce}
Expires: ${expires.toISOString()}`;

/// In memory on purpose. A nonce is worth five minutes and a restart invalidating every open login
/// prompt costs a person one more click, which is cheaper than a table to sweep.
/// Only for the ERC-1271 half of a login: a contract wallet's signature is a question for the chain.
const chain = createPublicClient({
  chain: robinhood,
  transport: http(process.env.HOOD_RPC ?? robinhood.rpcUrls.default.http[0]),
});

const nonces = new Map<string, { address: string; message: string; expiresAt: number }>();

function sweepNonces() {
  const now = Date.now();
  for (const [nonce, held] of nonces) if (held.expiresAt <= now) nonces.delete(nonce);
  // Nothing rate limits handing out random numbers below the API's own per-IP limit, so the map
  // keeps a ceiling of its own; the oldest go first because a Map iterates in insertion order.
  while (nonces.size > 10_000) {
    const oldest = nonces.keys().next().value;
    if (!oldest) break;
    nonces.delete(oldest);
  }
}

// ---------------------------------------------------------------- the message

/// The three facts a message carries beyond its words: what its author has earned, how much of this
/// token they are holding right now, and whether the room is theirs. Read for the whole page at
/// once, so a page of fifty messages is three queries rather than a hundred and fifty.
async function decorate(token: string, rows: Row[], viewer: string | null): Promise<ChatMessage[]> {
  if (!rows.length) return [];
  const authors = [...new Set(rows.map((r) => r.author))];
  const season = await currentSeason();
  const [{ rows: launch }, { rows: held }, { rows: volume }] = await Promise.all([
    pool.query<{ creator: string; total_supply: string }>(
      `select creator, total_supply from launches where token = $1`, [token],
    ),
    pool.query<{ address: string; balance: string }>(
      `select address, balance from balances where token = $1 and address = any($2::text[])`, [token, authors],
    ),
    /// The same rank the board shows, bought with the same season's traded volume. A second
    /// definition of a word the leaderboard already defines would be a second thing to explain.
    pool.query<{ address: string; volume_usd: string }>(
      `select address, coalesce(sum(usd) filter (where kind in ('trade_buy','trade_sell')), 0) as volume_usd
       from points where season = $1 and address = any($2::text[]) group by address`,
      [season, authors],
    ),
  ]);

  // Supply is what is left after burns, which is what a share of it means to anybody reading.
  const supply = BigInt(launch[0]?.total_supply ?? "0");
  const creator = launch[0]?.creator ?? "";
  const balances = new Map(held.map((r) => [r.address, BigInt(r.balance)]));
  const ranks = new Map(volume.map((r) => [r.address, rankFor(Number(r.volume_usd)).name]));

  return rows.map((r) => {
    const hidden = r.hidden_by !== null;
    return {
      id: Number(r.id),
      token: r.token,
      author: r.author,
      // Hiding takes a message off the wall. It does not take an author's own words away from the
      // author, who would otherwise be arguing with a blank space they cannot see.
      body: hidden && r.author !== viewer ? null : r.body,
      at: r.created_at,
      rank: ranks.get(r.author) ?? RANKS[0].name,
      holdingBps: supply > 0n ? Number(((balances.get(r.author) ?? 0n) * 10_000n) / supply) : 0,
      isCreator: r.author === creator,
      hidden,
    };
  });
}

const COLUMNS = `id, token, author, body, created_at, hidden_by`;

/// One message by id, for the stream: a payload too long for NOTIFY comes down the channel as an
/// id, and this is what turns it back into the object every reader expects.
export async function chatMessage(id: number): Promise<Record<string, unknown> | null> {
  if (!Number.isInteger(id)) return null;
  const { rows } = await pool.query<Row>(`select ${COLUMNS} from messages where id = $1`, [id]);
  if (!rows[0]) return null;
  const [message] = await decorate(rows[0].token, rows, null);
  return message as unknown as Record<string, unknown>;
}

/// Wallet by wallet, in memory. A restart forgives everybody, which is the right way round for a
/// limit whose job is pacing rather than punishment.
const posts = new Map<string, number[]>();

function tooSoon(address: string): { error: string; reason: string; retryAfter: number } | null {
  const now = Date.now();
  const mine = (posts.get(address) ?? []).filter((t) => now - t < 3_600_000);
  posts.set(address, mine);
  if (posts.size > 5_000) for (const [who, when] of posts) if (!when.length) posts.delete(who);
  const last = mine[mine.length - 1];
  if (last !== undefined && now - last < EVERY_MS) {
    return { error: "too_fast", reason: "One message every five seconds.", retryAfter: Math.ceil((EVERY_MS - (now - last)) / 1000) };
  }
  if (mine.length >= PER_HOUR) {
    return {
      error: "too_many",
      reason: `A wallet posts at most ${PER_HOUR} messages an hour.`,
      retryAfter: Math.ceil((3_600_000 - (now - mine[0]!)) / 1000),
    };
  }
  return null;
}

const note = (address: string) => posts.set(address, [...(posts.get(address) ?? []), Date.now()]);

// ---------------------------------------------------------------- routes

const NonceBody = z.object({ address: z.string().refine(isAddress, "not an address") });
const SessionBody = z.object({
  address: z.string().refine(isAddress, "not an address"),
  signature: z.string().min(4).max(2000),
  nonce: z.string().min(8).max(80),
});

export function registerChat(app: FastifyInstance) {
  resolveSecret(app);

  app.post("/chat/nonce", async (req, reply) => {
    const parsed = NonceBody.safeParse(req.body ?? {});
    if (!parsed.success) return refuse(reply, 400, "bad_request", parsed.error.issues[0]?.message ?? "bad request");
    const address = parsed.data.address.toLowerCase();
    const expiresAt = new Date(Date.now() + NONCE_MS);
    const nonce = randomBytes(16).toString("hex");
    const message = loginMessage(address, nonce, expiresAt);
    sweepNonces();
    nonces.set(nonce, { address, message, expiresAt: expiresAt.getTime() });
    return { nonce, message, expiresAt };
  });

  /// The only place a signature is checked. Everything after this takes the session.
  app.post("/chat/session", async (req, reply) => {
    const parsed = SessionBody.safeParse(req.body ?? {});
    if (!parsed.success) return refuse(reply, 400, "bad_request", parsed.error.issues[0]?.message ?? "bad request");
    const address = parsed.data.address.toLowerCase();
    const held = nonces.get(parsed.data.nonce);
    if (!held || held.expiresAt <= Date.now()) {
      return refuse(reply, 400, "unknown_nonce", "That nonce was not issued here, has been used, or has expired; ask for another.");
    }
    if (held.address !== address) return refuse(reply, 400, "wrong_wallet", "That nonce was issued to a different wallet.");

    // A key signs locally and is checked here with no network at all. A Safe cannot: it is a
    // contract, its "signature" is its owners' work recorded against the Safe, and the only way to
    // check one is to ask the chain (ERC-1271). So the cheap check runs first and the chain is only
    // asked when it fails, which is the case of a contract wallet. It is one call against current
    // state, so this chain's pruning of history does not reach it, and a chain that cannot be
    // reached refuses the login rather than accepting it.
    let signed = false;
    const claim = {
      address: parsed.data.address as `0x${string}`,
      message: held.message,
      signature: parsed.data.signature as `0x${string}`,
    };
    try {
      signed = await verifyMessage(claim);
    } catch {
      signed = false;
    }
    if (!signed) {
      try {
        signed = await chain.verifyMessage(claim);
      } catch {
        signed = false;
      }
    }
    if (!signed) return refuse(reply, 401, "bad_signature", "That signature was not made by this wallet over this message.");

    // Single use, and only a signature that checked out spends it: a typo should not cost a round
    // trip, and nothing else can reach this line.
    nonces.delete(parsed.data.nonce);
    const session = issueSession(address);
    return { token: session.token, address, expiresAt: session.expiresAt };
  });

  app.get("/chat/:token", async (req, reply) => {
    const { token } = req.params as { token: string };
    const q = req.query as { limit?: string; before?: string };
    const before = Number(q.before);
    // What comes back depends on who asked, so no shared cache may hold it: one wallet's own hidden
    // message would otherwise be served to the next reader through the edge.
    reply.header("cache-control", "no-store");
    reply.header("vary", "authorization");
    const { rows } = await pool.query<Row>(
      `select ${COLUMNS} from messages
       where token = $1 and ($2::bigint is null or id < $2::bigint)
       order by id desc limit $3`,
      [token.toLowerCase(), Number.isInteger(before) && before > 0 ? before : null, clamp(q.limit, 50, 100)],
    );
    return { messages: await decorate(token.toLowerCase(), rows, sessionOf(req)) };
  });

  app.post("/chat/:token", async (req, reply) => {
    const author = sessionOf(req);
    if (!author) {
      return refuse(reply, 401, "no_session", "Sign the message from /chat/nonce and send the session from /chat/session as a bearer token.");
    }
    const token = (req.params as { token: string }).token.toLowerCase();

    const raw = (req.body as { body?: unknown } | null)?.body;
    if (typeof raw !== "string") return refuse(reply, 400, "body_missing", "Send a body field with the message in it.");
    const body = raw.trim();
    if (!body) return refuse(reply, 400, "body_empty", "A message with nothing in it is not a message.");
    if (body.length > MAX_BODY) return refuse(reply, 400, "body_too_long", `A message is at most ${MAX_BODY} characters.`);
    // Newlines count: a message is one line, and the control characters below it are what smuggles
    // a fake second message, a terminal escape or a broken SSE frame past a reader.
    if (/[\u0000-\u001f\u007f-\u009f]/.test(body)) {
      return refuse(reply, 400, "body_control_characters", "A message is one line of plain text, with no control characters in it.");
    }

    const { rows: launch } = await pool.query<{ token: string }>(`select token from launches where token = $1`, [token]);
    if (!launch[0]) return refuse(reply, 404, "unknown_token", "Nothing has launched here at that address.");
    if (isSystem(author)) return refuse(reply, 403, "system_wallet", "Our own contracts trade here; they do not talk.");

    // Holding it now, or having traded it once, is the whole entry fee. Either end of a trade
    // counts, because a buy sent by a router lands in a wallet that never signed the transaction.
    const { rows: standing } = await pool.query<{ holds: boolean; traded: boolean }>(
      `select exists(select 1 from balances where token = $1 and address = $2 and balance > 0) as holds,
              exists(select 1 from trades where token = $1 and (trader = $2 or recipient = $2)) as traded`,
      [token, author],
    );
    if (!standing[0]?.holds && !standing[0]?.traded) {
      return refuse(reply, 403, "no_position", "Only a wallet holding this token, or one that has traded it at least once, can post in its chat.");
    }

    // Counted after everything else, so a rejected message never spends a wallet's allowance.
    const waiting = tooSoon(author);
    if (waiting) {
      return reply.code(429).header("retry-after", String(waiting.retryAfter))
        .send({ error: waiting.error, reason: waiting.reason, retryAfter: waiting.retryAfter });
    }

    const { rows } = await pool.query<Row>(
      `insert into messages (token, author, body) values ($1,$2,$3) returning ${COLUMNS}`,
      [token, author, body],
    );
    note(author);
    const [message] = await decorate(token, rows, author);
    await notify("message", message as unknown as Record<string, unknown>, { id: message!.id });
    return message;
  });

  /// Hiding, by the creator of the launch or by an operator. There is no delete and no edit: see
  /// the table in db.ts for why. The same two can put a message back, with { "hidden": false }.
  app.post("/chat/:token/hide/:id", async (req, reply) => {
    const { token: rawToken, id: rawId } = req.params as { token: string; id: string };
    const token = rawToken.toLowerCase();
    const id = Number(rawId);
    if (!Number.isInteger(id) || id < 1) return refuse(reply, 400, "bad_id", "A message id is a positive whole number.");

    const { rows: launch } = await pool.query<{ creator: string }>(`select creator from launches where token = $1`, [token]);
    if (!launch[0]) return refuse(reply, 404, "unknown_token", "Nothing has launched here at that address.");

    const operator = isAdmin(req);
    const who = operator ? "admin" : sessionOf(req);
    if (!who) return refuse(reply, 401, "no_session", "Send a chat session, or the admin token, as a bearer token.");
    if (!operator && who !== launch[0].creator) {
      return refuse(reply, 403, "not_the_creator", "Only the wallet that launched this token, or an operator, can hide a message in its chat.");
    }

    const hidden = (req.body as { hidden?: unknown } | null)?.hidden !== false;
    const { rows } = await pool.query<{ id: string }>(
      hidden
        ? `update messages set hidden_by = $3, hidden_at = now() where id = $1 and token = $2 returning id`
        : `update messages set hidden_by = null, hidden_at = null where id = $1 and token = $2 returning id`,
      hidden ? [id, token, who] : [id, token],
    );
    if (!rows[0]) return refuse(reply, 404, "unknown_message", "No message with that id in this token's chat.");
    return { ok: true };
  });
}
