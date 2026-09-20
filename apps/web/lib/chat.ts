import { API } from "./config";

/// The chat under a launch: what a message is, how a wallet gets the right to write one, and the
/// single fetch that carries both.
///
/// Nothing here touches a wallet. Signing belongs to the component that has one; this file only
/// knows that a session token exists, where it is kept and when it stops being worth sending.

export interface ChatMessage {
  /// The API paginates on this and hides on this, and it never says which of the two it is, so the
  /// app carries it as it arrived rather than deciding it is a number.
  id: string | number;
  token: string;
  author: string;
  /// Null when the message is hidden and the reader is not the one who wrote it.
  body: string | null;
  at: string;
  rank: string | null;
  holdingBps: number;
  isCreator: boolean;
  hidden: boolean;
}

export interface ChatSession {
  token: string;
  address: string;
  expiresAt: string | number;
}

export interface ChatChallenge {
  nonce: string;
  /// The exact sentence to sign. Retyping it here would be a second source of truth and the first
  /// one to drift.
  message: string;
  expiresAt: string | number;
}

/// A refusal carries the server's own sentence. "You do not hold this token" and "wait a minute"
/// are facts a reader can act on; "something went wrong" is not, and every refusal the chat can
/// give is one of the first kind.
export class ChatRefused extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

/// The chat refuses with a code and a sentence: `{ error: "no_position", reason: "..." }`. The
/// sentence is the half a reader can act on; the code is plumbing, and showing somebody the word
/// `no_position` is the app talking to itself in front of them.
function sentence(status: number, body: { error?: string; reason?: string } | null): string {
  const reason = body?.reason?.trim();
  if (reason) return reason;
  // An older answer, or another route, that puts the whole sentence in `error` rather than a code.
  const error = body?.error?.trim();
  if (error && /\s/.test(error)) return error;
  return fallback(status);
}

function fallback(status: number): string {
  if (status === 401) return "That signature is no longer good. Sign again to post.";
  if (status === 403) return "Only wallets that hold this token or have traded it can post here.";
  if (status === 429) return "Too many messages in a short time. Give it a minute.";
  if (status === 404) return "This chat is not open yet.";
  return `The chat answered ${status}.`;
}

/// Every chat call, one shape: a bearer when there is one, the API's own `error` text out.
export async function chatApi<T>(
  path: string,
  options: { method?: string; body?: unknown; session?: string } = {},
): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    method: options.method ?? "GET",
    cache: "no-store",
    headers: {
      ...(options.body === undefined ? {} : { "content-type": "application/json" }),
      ...(options.session ? { authorization: `Bearer ${options.session}` } : {}),
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const text = await res.text();
  let parsed: unknown = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    // A proxy in front of the API answers in HTML when it is the one refusing, and that is not the
    // reader's problem to read: the status carries the meaning.
    parsed = null;
  }
  if (!res.ok) throw new ChatRefused(res.status, sentence(res.status, parsed as { error?: string; reason?: string } | null));
  return parsed as T;
}

const key = (address: string) => `hood.chat.${address.toLowerCase()}`;

/// An expiry the app cannot read is not treated as expired. A stale token comes back as a 401, the
/// app signs again, and the reader has lost one round trip; guessing "expired" instead would ask a
/// wallet for a signature before every single post.
function expired(value: ChatSession["expiresAt"] | undefined): boolean {
  if (value === undefined || value === null) return false;
  const ms = typeof value === "number" ? (value < 1e12 ? value * 1000 : value) : Date.parse(String(value));
  return Number.isFinite(ms) ? ms <= Date.now() : false;
}

/// Storage throws in a private window rather than handing back null, and it can hold whatever an
/// older build of this app wrote, so every read is guarded and anything unrecognised is no session.
export function readSession(address: string): ChatSession | null {
  try {
    const raw = localStorage.getItem(key(address));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as ChatSession | null;
    if (!parsed || typeof parsed.token !== "string" || !parsed.token) return null;
    if (expired(parsed.expiresAt)) {
      forgetSession(address);
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export function saveSession(address: string, session: ChatSession) {
  try {
    localStorage.setItem(key(address), JSON.stringify(session));
  } catch {
    /* private window: the session holds for this tab only, which is still a working chat */
  }
}

export function forgetSession(address: string) {
  try {
    localStorage.removeItem(key(address));
  } catch {
    /* nothing to forget */
  }
}

/// A wallet error, a refusal or anything else, as one sentence for the reader. Wallets put the
/// useful half of what they know in `shortMessage`.
export function describe(error: unknown): string {
  if (error instanceof ChatRefused) return error.message;
  const wallet = error as { shortMessage?: string; message?: string };
  return wallet?.shortMessage ?? wallet?.message ?? String(error);
}
