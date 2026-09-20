"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useAccount, useConnect, useReadContract, useSignMessage } from "wagmi";
import { zeroAddress, type Address } from "viem";
import {
  ChatRefused,
  chatApi,
  describe,
  forgetSession,
  readSession,
  saveSession,
  type ChatChallenge,
  type ChatMessage,
  type ChatSession,
} from "@/lib/chat";
import { useLive } from "@/lib/live";
import { usePreferredConnector } from "@/lib/safe";
import { useTrades } from "@/components/Tape";
import { ago, shortAddress } from "@/lib/format";

/// The room under a launch.
///
/// Who may speak is the whole design: holders of the token and anybody who has traded it, which is
/// the same test the API applies and the reason a wallet is asked to sign once. The signature is
/// not a transaction and costs nothing; what it buys is a session token, kept per address, so the
/// wallet is not asked again until it expires.
///
/// The creator of the launch can hide a message. Everyone else sees a hidden one as a blank; the
/// author still sees their own words, because a room where your message disappears and nobody tells
/// you is a room you keep shouting into.

const LIMIT = 280;

const erc20 = [
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] },
] as const;

export function TokenChat({ token, symbol, creator, launchedAt }: { token: string; symbol: string; creator: string; launchedAt?: string }) {
  const { address } = useAccount();
  const { connect, isPending: connecting } = useConnect();
  const connector = usePreferredConnector();
  const { signMessageAsync } = useSignMessage();
  const client = useQueryClient();

  const [streamed, setStreamed] = useState<ChatMessage[]>([]);
  const [hiddenHere, setHiddenHere] = useState<Set<string>>(new Set());
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [signedIn, setSignedIn] = useState(false);
  const log = useRef<HTMLDivElement>(null);
  // The session is read and replaced inside async work that started several renders ago, so it
  // lives in a ref and `signedIn` is only what the composer prints.
  const session = useRef<ChatSession | null>(null);

  useEffect(() => {
    // Storage does not exist while this page is rendered on the server, and the address arrives a
    // tick after the wallet reconnects itself.
    session.current = address ? readSession(address) : null;
    setSignedIn(Boolean(session.current));
  }, [address]);

  const history = useQuery({
    queryKey: ["chat", token, signedIn],
    queryFn: () => chatApi<{ messages: ChatMessage[] }>(`/chat/${token}?limit=50`, { session: session.current?.token }),
    // The stream carries new messages; this is what the room does when there is no stream, and what
    // catches up a tab that was asleep.
    refetchInterval: 20_000,
    retry: false,
  });

  useLive({
    tokens: [token],
    onMessage: (message) =>
      setStreamed((seen) => (seen.some((m) => String(m.id) === String(message.id)) ? seen : [...seen, message].slice(-100))),
  });

  const messages = useMemo(() => {
    // Newest first is how the API answers and the opposite of how a room reads, so the history is
    // turned over and anything the stream brought goes on the end. A message in both is one entry,
    // keeping the place it first took.
    const byId = new Map<string, ChatMessage>();
    for (const message of [...(history.data?.messages ?? [])].reverse()) byId.set(String(message.id), message);
    for (const message of streamed) byId.set(String(message.id), message);
    return [...byId.values()];
  }, [history.data, streamed]);

  useEffect(() => {
    const box = log.current;
    if (!box) return;
    // Follow the tail only for a reader who is already at it. A message landing while somebody
    // reads back through the room should not drag them out of it.
    if (box.scrollHeight - box.scrollTop - box.clientHeight < 90) box.scrollTop = box.scrollHeight;
  }, [messages.length]);

  /// Whether this wallet may post, as far as the app can see from here. The API is the one that
  /// decides, and it decides on the same two facts: a balance now, or a trade at any point. The
  /// balance is read from the chain and the trades from the tape the page already has, so a wallet
  /// that bought a second ago is let in as soon as either of those catches up.
  const { data: balance } = useReadContract({
    address: token as Address,
    abi: erc20,
    functionName: "balanceOf",
    args: [address ?? zeroAddress],
    query: { enabled: Boolean(address), refetchInterval: 15_000 },
  });
  const trades = useTrades(token);
  const traded = Boolean(address) && (trades.data?.trades ?? []).some((t) => t.trader?.toLowerCase() === address?.toLowerCase());
  const canPost = Boolean(address) && (((balance as bigint | undefined) ?? 0n) > 0n || traded);
  const isCreator = Boolean(address) && address?.toLowerCase() === creator.toLowerCase();
  const left = LIMIT - draft.trim().length;

  /// One signature, once, and then a token. The nonce comes back with the exact sentence to sign,
  /// so the app never composes that sentence itself and the two halves cannot drift apart.
  // A launch's first day is when a fake claim page is worth posting, so that is the window where a
  // link is shown but not offered as a click. An unknown launch time is treated as new: withholding
  // a click costs a reader nothing, and giving one too early can cost them everything.
  const young = !launchedAt || Date.now() - new Date(launchedAt).getTime() < YOUNG_FOR_MS;

  async function openSession(): Promise<string> {
    if (!address) throw new Error("Connect a wallet to post.");
    const kept = session.current ?? readSession(address);
    if (kept) {
      session.current = kept;
      setSignedIn(true);
      return kept.token;
    }
    const challenge = await chatApi<ChatChallenge>("/chat/nonce", { method: "POST", body: { address } });
    const signature = await signMessageAsync({ message: challenge.message });
    const opened = await chatApi<ChatSession>("/chat/session", {
      method: "POST",
      body: { address, signature, nonce: challenge.nonce },
    });
    saveSession(address, opened);
    session.current = opened;
    setSignedIn(true);
    return opened.token;
  }

  /// A session the server has already rotated or forgotten comes back as a 401. That is not an
  /// error to print at somebody: it is a signature to ask for again, once.
  async function withSession<T>(run: (bearer: string) => Promise<T>): Promise<T> {
    try {
      return await run(await openSession());
    } catch (e) {
      if (!(e instanceof ChatRefused) || e.status !== 401 || !address) throw e;
      forgetSession(address);
      session.current = null;
      setSignedIn(false);
      return run(await openSession());
    }
  }

  async function post(event?: { preventDefault: () => void }) {
    event?.preventDefault();
    const body = draft.trim();
    if (!body || body.length > LIMIT || busy) return;
    setBusy(true);
    setError(undefined);
    try {
      const sent = await withSession((bearer) => chatApi<ChatMessage>(`/chat/${token}`, { method: "POST", body: { body }, session: bearer }));
      setDraft("");
      // The stream will carry it back in a moment; showing it now is what makes the room feel like
      // one, and the id keeps the two from becoming two messages.
      if (sent?.id !== undefined) setStreamed((seen) => (seen.some((m) => String(m.id) === String(sent.id)) ? seen : [...seen, sent]));
    } catch (e) {
      setError(describe(e));
    } finally {
      setBusy(false);
    }
  }

  async function hide(id: ChatMessage["id"]) {
    setError(undefined);
    try {
      await withSession((bearer) => chatApi<{ ok: boolean }>(`/chat/${token}/hide/${id}`, { method: "POST", session: bearer }));
      setHiddenHere((seen) => new Set(seen).add(String(id)));
      void client.invalidateQueries({ queryKey: ["chat", token] });
    } catch (e) {
      setError(describe(e));
    }
  }

  return (
    <section className="panel chat-panel p-4">
      <div className="chat-head">
        <h3>Chat</h3>
        <span className="dim">holders and traders of ${symbol}</span>
      </div>

      {/* A log rather than a plain box: a reader on a screen reader is told what arrives while
          they are here, in the order it arrived, without being dragged to it. */}
      <div className="chat-log" role="log" ref={log}>
        {messages.map((m) => (
          <Message
            key={String(m.id)}
            message={m}
            hidden={m.hidden || hiddenHere.has(String(m.id))}
            mine={Boolean(address) && m.author?.toLowerCase() === address?.toLowerCase()}
            canHide={isCreator}
            onHide={hide}
            token={token}
            symbol={symbol}
            young={young}
          />
        ))}
        {!messages.length && (
          <p className="chat-quiet dim">
            {history.isError
              ? "The chat is not answering. Everything else on this page is unaffected."
              : history.isLoading
                ? "Reading the room."
                : "Nothing said here yet."}
          </p>
        )}
      </div>

      {!address ? (
        <div className="chat-gate">
          <p>
            Connect a wallet to say something. The room is for people with something in this launch:
            anyone holding ${symbol}, and anyone who has traded it. Connecting reads your address and
            nothing else.
          </p>
          <button className="btn" disabled={connecting || !connector} onClick={() => connector && connect({ connector })}>
            {connecting ? "Connecting…" : "Connect"}
          </button>
        </div>
      ) : !canPost ? (
        <div className="chat-gate">
          <p>
            No ${symbol} in this wallet and no trade from it on the tape, so the room is read only
            here. Buy any amount and the box opens.
          </p>
        </div>
      ) : (
        <form className="chat-composer" onSubmit={(e) => void post(e)}>
          <textarea
            className="input chat-input"
            rows={2}
            value={draft}
            maxLength={LIMIT * 2}
            placeholder={`Say something about $${symbol}`}
            aria-label={`Say something about $${symbol}`}
            // The API takes one line of plain text and refuses a control character, so a pasted
            // paragraph arrives here as the one line it will be allowed to be.
            onChange={(e) => setDraft(e.target.value.replace(/\s*[\r\n]+\s*/g, " "))}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                void post();
              }
            }}
          />
          <div className="chat-composer-foot">
            <span className={left < 0 ? "chat-count is-over" : "chat-count"}>{left}</span>
            <button className="btn" disabled={busy || !draft.trim() || left < 0}>
              {busy ? "sending" : signedIn ? "post" : "sign and post"}
            </button>
          </div>
          {!signedIn && (
            <p className="chat-note">
              The first post asks your wallet to sign one sentence. It is free, it is not a
              transaction, and it stands in for a password until it runs out.
            </p>
          )}
        </form>
      )}

      {error && <p className="chat-error">{error}</p>}
    </section>
  );
}

/// The share a wallet holds, from basis points. Under a percent it needs the decimals to say
/// anything at all; over one it does not.
function holding(bps: number | undefined): string | null {
  if (typeof bps !== "number" || !Number.isFinite(bps) || bps <= 0) return null;
  return `${(bps / 100).toFixed(bps < 100 ? 2 : 1)}%`;
}

/// The two things a launchpad room is used to attack a reader: a contract address that is not the
/// one this room is about, and a link to a page that will ask for their wallet. Neither is solved by
/// a word filter, so neither is filtered: an address is checked against the token and marked when it
/// is a different one, and a link is not a link while a launch is new, which is the window the fake
/// claim pages live in. Everything is still said; only the click is withheld.
const ADDRESS_OR_URL = /(0x[0-9a-fA-F]{40}|https?:\/\/[^\s]+|(?:^|\s)(?:www\.)[^\s]+)/g;
const YOUNG_FOR_MS = 24 * 60 * 60 * 1000;

function Body({ text, token, symbol, young }: { text: string; token: string; symbol: string; young: boolean }) {
  const pieces = text.split(ADDRESS_OR_URL).filter((piece) => piece !== undefined && piece !== "");
  return (
    <>
      {pieces.map((piece, i) => {
        const value = piece.trim();
        if (/^0x[0-9a-fA-F]{40}$/.test(value)) {
          const isThisToken = value.toLowerCase() === token.toLowerCase();
          return (
            <span key={i} className={isThisToken ? "chat-addr mono" : "chat-addr is-other mono"}
              title={isThisToken ? `The contract of $${symbol}` : `This is not the contract of $${symbol}`}>
              {value}
              {!isThisToken && <span className="chat-addr-note"> not ${symbol}</span>}
            </span>
          );
        }
        if (/^(https?:\/\/|www\.)/i.test(value)) {
          if (young) {
            return (
              <span key={i} className="chat-link-held" title="A link is not clickable in a launch's first day.">
                {piece}
              </span>
            );
          }
          const href = value.startsWith("www.") ? `https://${value}` : value;
          return (
            <a key={i} className="chat-link" href={href} target="_blank" rel="nofollow noreferrer noopener">
              {piece}
            </a>
          );
        }
        return <span key={i}>{piece}</span>;
      })}
    </>
  );
}

function Message({ message, hidden, mine, canHide, onHide, token, symbol, young }: {
  message: ChatMessage;
  hidden: boolean;
  mine: boolean;
  canHide: boolean;
  onHide: (id: ChatMessage["id"]) => void;
  token: string;
  symbol: string;
  young: boolean;
}) {
  const share = holding(message.holdingBps);
  // The API blanks a hidden message for everyone but its author. A message hidden from this tab a
  // moment ago has not been read back yet, so it is blanked here on the same rule.
  const body = hidden && !mine ? null : message.body;

  return (
    <article className={hidden ? "chat-line is-hidden" : "chat-line"}>
      <div className="chat-line-head">
        <span className="chat-who mono">{shortAddress(message.author)}</span>
        {message.isCreator && <span className="chat-tag">creator</span>}
        {message.rank && <span className="chat-rank">{message.rank}</span>}
        {share && <span className="chat-hold">holds {share}</span>}
        <span className="chat-age dim">{ago(message.at)}</span>
        {canHide && !hidden && (
          <button type="button" className="chat-hide" onClick={() => onHide(message.id)}>
            hide
          </button>
        )}
      </div>
      {body === null ? (
        <p className="chat-body chat-quiet">hidden by the creator</p>
      ) : (
        <p className="chat-body">
          <Body text={body} token={token} symbol={symbol} young={young} />
          {hidden && <span className="chat-note"> Hidden by the creator. Only you still see it.</span>}
        </p>
      )}
    </article>
  );
}
