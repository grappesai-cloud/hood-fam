"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { usePathname } from "next/navigation";
import { useAccount } from "wagmi";
import { useQuery } from "@tanstack/react-query";
import { API, EXPLORER } from "@/lib/config";

/// The help button. A chat with the support assistant, and a ticket form behind it for when the
/// assistant cannot help or is switched off. The conversation lives in this tab only.

type Msg = { role: "user" | "assistant"; content: string };
type Event =
  | { type: "text"; delta: string }
  | { type: "tool"; name: string }
  | { type: "ticket"; id: number }
  | { type: "done" }
  | { type: "error"; message: string };

const STORAGE = "hood.support";
const STARTERS = [
  "My buy failed. What happened?",
  "Where are my creator fees?",
  "How does graduation work?",
  "How do points and ranks work?",
];

function load(): Msg[] {
  try { return JSON.parse(sessionStorage.getItem(STORAGE) ?? "[]"); } catch { return []; }
}
function save(m: Msg[]) {
  try { sessionStorage.setItem(STORAGE, JSON.stringify(m.slice(-24))); } catch { /* private window */ }
}

/// Hosts a link in an answer may point at. The assistant reads token metadata, tickets and whatever
/// a user pastes, so a URL in its output is not necessarily one it chose: anything else is shown as
/// text, which is still readable and cannot be clicked into somebody's drainer.
const LINKABLE = [new URL(EXPLORER).host, "hood.fam", "www.hood.fam", "famdotfun.com", "www.famdotfun.com"];

function linkable(raw: string): string | null {
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    return LINKABLE.includes(url.host) ? url.toString() : null;
  } catch {
    return null;
  }
}

/// Plain text with links. Paragraph breaks, URLs, and anything that looks like a hash or address
/// pointing at the explorer. No markdown engine: the assistant is told not to use one.
function Rich({ text }: { text: string }) {
  const parts = text.split(/(https?:\/\/\S+|0x[a-fA-F0-9]{40,64})/g);
  return (
    <>
      {parts.map((p, i) => {
        if (/^https?:\/\//.test(p)) {
          const clean = p.replace(/[.,;:)]+$/, "");
          const href = linkable(clean);
          if (!href) return <span key={i} className="break-all">{clean}</span>;
          return <a key={i} href={href} target="_blank" rel="noreferrer noopener" className="text-[var(--color-lime)] underline break-all">{clean}</a>;
        }
        if (/^0x[a-fA-F0-9]{64}$/.test(p)) return <a key={i} href={`${EXPLORER}/tx/${p}`} target="_blank" rel="noreferrer" className="mono text-[var(--color-lime)] break-all">{p.slice(0, 10)}…{p.slice(-6)}</a>;
        if (/^0x[a-fA-F0-9]{40}$/.test(p)) return <a key={i} href={`${EXPLORER}/address/${p}`} target="_blank" rel="noreferrer" className="mono text-[var(--color-lime)] break-all">{p.slice(0, 6)}…{p.slice(-4)}</a>;
        return <span key={i}>{p}</span>;
      })}
    </>
  );
}

export function SupportChat() {
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<"chat" | "ticket">("chat");
  const [messages, setMessages] = useState<Msg[]>([]);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [ticketId, setTicketId] = useState<number | null>(null);
  const path = usePathname();
  const { address } = useAccount();
  const scroller = useRef<HTMLDivElement>(null);
  const abort = useRef<AbortController | null>(null);

  const status = useQuery({
    queryKey: ["support-status"],
    queryFn: async () => (await fetch(`${API}/support/status`)).json() as Promise<{ enabled: boolean }>,
    staleTime: 60_000, refetchInterval: false,
  });
  const enabled = status.data?.enabled ?? true;

  useEffect(() => { setMessages(load()); }, []);
  useEffect(() => { scroller.current?.scrollTo({ top: scroller.current.scrollHeight }); }, [messages, busy, open]);
  useEffect(() => () => abort.current?.abort(), []);

  async function send(text: string) {
    const content = text.trim();
    if (!content || busy) return;
    setError(null);
    setDraft("");
    const history: Msg[] = [...messages, { role: "user", content }];
    setMessages(history);
    save(history);
    setBusy("thinking");
    const ac = new AbortController();
    abort.current = ac;
    let reply = "";
    const push = () => setMessages([...history, { role: "assistant", content: reply }]);
    try {
      const res = await fetch(`${API}/support/chat`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ messages: history.slice(-24), address: address ?? null, page: path }),
        signal: ac.signal,
      });
      if (res.status === 503) { setMode("ticket"); setError("The assistant is offline right now. Leave a ticket and a person will reply."); return; }
      if (res.status === 429) { setError("Too many messages in a short time. Give it a few minutes."); return; }
      if (!res.ok || !res.body) { setError("Could not reach support. Try again in a moment."); return; }
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        const frames = buf.split("\n\n");
        buf = frames.pop() ?? "";
        for (const f of frames) {
          const line = f.split("\n").find((l) => l.startsWith("data: "));
          if (!line) continue;
          const ev = JSON.parse(line.slice(6)) as Event;
          if (ev.type === "text") { reply += ev.delta; setBusy(null); push(); }
          else if (ev.type === "tool") setBusy(ev.name);
          else if (ev.type === "ticket") setTicketId(ev.id);
          else if (ev.type === "error") setError(ev.message);
        }
      }
      if (reply) save([...history, { role: "assistant", content: reply }]);
    } catch (e) {
      if (!ac.signal.aborted) setError("The connection dropped. Try again.");
    } finally {
      setBusy(null);
      abort.current = null;
    }
  }

  function reset() {
    abort.current?.abort();
    setMessages([]); save([]); setError(null); setTicketId(null); setMode("chat");
  }

  return (
    <>
      <button
        onClick={() => setOpen((o) => !o)}
        aria-label={open ? "close support" : "open support"}
        className="fixed bottom-5 right-5 z-30 rounded-full border border-[var(--color-line)] bg-[var(--color-panel)] px-4 py-2.5 text-sm font-semibold shadow-lg hover:border-[var(--color-lime)]"
      >
        {open ? "close" : "help"}
      </button>

      {open && (
        <div className="panel fixed bottom-20 right-5 z-30 flex h-[min(560px,calc(100vh-120px))] w-[calc(100vw-40px)] flex-col overflow-hidden sm:w-[380px]">
          <div className="flex items-center justify-between border-b border-[var(--color-line)] px-4 py-3">
            <div>
              <div className="text-sm font-semibold">support</div>
              <div className="dim text-[11px]">{enabled ? "answers from the docs and the chain" : "assistant offline, tickets open"}</div>
            </div>
            <div className="flex gap-2 text-xs">
              <button className="dim hover:text-[var(--color-text)]" onClick={() => setMode(mode === "chat" ? "ticket" : "chat")}>
                {mode === "chat" ? "talk to a person" : "back to chat"}
              </button>
              {messages.length > 0 && mode === "chat" && (
                <button className="dim hover:text-[var(--color-text)]" onClick={reset}>clear</button>
              )}
            </div>
          </div>

          {mode === "ticket" ? (
            <TicketForm address={address ?? null} page={path} transcript={messages} onDone={(id) => { setTicketId(id); }} ticketId={ticketId} />
          ) : (
            <>
              <div ref={scroller} className="flex-1 space-y-3 overflow-y-auto px-4 py-3 text-[13px] leading-relaxed">
                {messages.length === 0 && (
                  <div className="space-y-2">
                    <p className="dim">Ask about a launch, a trade, fees, locking, points or the bridge. Paste a transaction hash and I will read it.</p>
                    {enabled && STARTERS.map((s) => (
                      <button key={s} onClick={() => send(s)} className="block w-full rounded-lg border border-[var(--color-line)] px-3 py-2 text-left hover:border-[var(--color-lime)]">
                        {s}
                      </button>
                    ))}
                  </div>
                )}
                {messages.map((m, i) => (
                  <div key={i} className={m.role === "user" ? "ml-8 rounded-xl bg-[var(--color-ink)] px-3 py-2" : "mr-4 whitespace-pre-wrap"}>
                    <Rich text={m.content} />
                  </div>
                ))}
                {busy && <div className="dim animate-pulse text-xs">{busy}…</div>}
                {ticketId !== null && <div className="text-xs text-[var(--color-lime)]">ticket #{ticketId} opened</div>}
                {error && <div className="text-xs text-[var(--color-red)]">{error}</div>}
              </div>
              <form
                className="flex gap-2 border-t border-[var(--color-line)] p-3"
                onSubmit={(e: FormEvent) => { e.preventDefault(); void send(draft); }}
              >
                <input
                  className="input"
                  placeholder={enabled ? "ask anything about hood.fam" : "assistant offline"}
                  value={draft}
                  disabled={!enabled || busy !== null}
                  maxLength={4000}
                  onChange={(e) => setDraft(e.target.value)}
                />
                <button className="btn" disabled={!enabled || busy !== null || !draft.trim()}>send</button>
              </form>
            </>
          )}
        </div>
      )}
    </>
  );
}

function TicketForm({ address, page, transcript, onDone, ticketId }: {
  address: string | null; page: string; transcript: Msg[]; onDone: (id: number) => void; ticketId: number | null;
}) {
  const [contact, setContact] = useState("");
  const [subject, setSubject] = useState("");
  const [summary, setSummary] = useState("");
  const [state, setState] = useState<"idle" | "sending" | "sent" | "error">(ticketId !== null ? "sent" : "idle");
  const [id, setId] = useState<number | null>(ticketId);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setState("sending");
    try {
      const res = await fetch(`${API}/support/ticket`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ contact, subject, summary, address, page, transcript: transcript.slice(-24) }),
      });
      if (!res.ok) throw new Error(String(res.status));
      const j = (await res.json()) as { id: number };
      setId(j.id); onDone(j.id); setState("sent");
    } catch {
      setState("error");
    }
  }

  if (state === "sent") {
    return (
      <div className="flex-1 px-4 py-6 text-[13px]">
        <div className="font-semibold">ticket #{id} opened</div>
        <p className="dim mt-2">A person will reply to the contact you gave. Keep the number if you follow up.</p>
      </div>
    );
  }
  return (
    <form onSubmit={submit} className="flex flex-1 flex-col gap-2 overflow-y-auto px-4 py-3 text-[13px]">
      <p className="dim">Leave a way to reach you and what happened. Transaction hashes help.</p>
      <input className="input" placeholder="email, Telegram or X handle" value={contact} onChange={(e) => setContact(e.target.value)} required minLength={3} maxLength={200} />
      <input className="input" placeholder="subject" value={subject} onChange={(e) => setSubject(e.target.value)} required minLength={3} maxLength={200} />
      <textarea className="input min-h-28 flex-1" placeholder="what happened, what you tried, addresses and tx hashes" value={summary} onChange={(e) => setSummary(e.target.value)} required minLength={10} maxLength={4000} />
      {address && <div className="dim text-[11px]">attached: connected wallet {address.slice(0, 6)}…{address.slice(-4)}{transcript.length ? " and this chat" : ""}</div>}
      {state === "error" && <div className="text-xs text-[var(--color-red)]">Could not send. Try again.</div>}
      <button className="btn" disabled={state === "sending"}>{state === "sending" ? "sending" : "open ticket"}</button>
    </form>
  );
}
