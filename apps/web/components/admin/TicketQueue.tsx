"use client";

import { useState } from "react";
import { ago } from "@/lib/format";
import { useAdminAction, useAdminQuery } from "./session";
import { Addr, Row } from "./ui";

type Status = "open" | "answered" | "closed";
type Filter = Status | "all";

interface Ticket {
  id: number;
  created_at: string;
  updated_at: string;
  status: Status;
  address: string | null;
  contact: string;
  subject: string;
  summary: string;
  page: string | null;
  source: string;
  note: string | null;
  transcript: { role: string; content: string }[] | null;
}

const FILTERS: Filter[] = ["open", "answered", "closed", "all"];

/// The queue. Every ticket a person left, oldest work first to the eye because the API hands them
/// back newest first and an operator reads down.
export function TicketQueue() {
  const [filter, setFilter] = useState<Filter>("open");
  const [openId, setOpenId] = useState<number | null>(null);
  const { data, error, isLoading } = useAdminQuery<{ tickets: Ticket[] }>(
    ["tickets", filter],
    `/support/tickets?status=${filter}&limit=100`,
    15_000,
  );
  const tickets = data?.tickets ?? [];

  return (
    <section className="panel space-y-3 p-4">
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="font-semibold">tickets</h2>
        <span className="text-xs dim">{tickets.length} shown · refreshes every 15s</span>
      </div>

      <div className="flex flex-wrap gap-2">
        {FILTERS.map((f) => (
          <button
            key={f}
            onClick={() => setFilter(f)}
            className={`rounded-lg border px-2.5 py-1.5 text-xs ${
              filter === f ? "border-[var(--color-lime)] text-[var(--color-lime)]" : "border-[var(--color-line)] dim"
            }`}
          >
            {f}
          </button>
        ))}
      </div>

      {isLoading && <p className="text-xs dim">reading</p>}
      {error && <p className="break-words text-xs text-[var(--color-red)]">{error.message}</p>}
      {!isLoading && tickets.length === 0 && <p className="py-4 text-center text-xs dim">nothing in this pile.</p>}

      <div className="space-y-2">
        {tickets.map((t) => (
          <TicketRow key={t.id} ticket={t} open={openId === t.id} onToggle={() => setOpenId(openId === t.id ? null : t.id)} />
        ))}
      </div>
    </section>
  );
}

function TicketRow({ ticket, open, onToggle }: { ticket: Ticket; open: boolean; onToggle: () => void }) {
  const [note, setNote] = useState(ticket.note ?? "");
  const { run, pending, error } = useAdminAction();

  async function patch(label: string, body: { status?: Status; note?: string }) {
    await run(label, `/support/tickets/${ticket.id}`, { method: "PATCH", body: JSON.stringify(body) });
  }

  const noteChanged = note !== (ticket.note ?? "");

  return (
    <div className="rounded-lg border border-[var(--color-line)]">
      <button onClick={onToggle} className="flex w-full items-center gap-2 p-2.5 text-left">
        <span className="mono text-xs dim">#{ticket.id}</span>
        <span className="flex-1 truncate text-sm">{ticket.subject}</span>
        <span className={`text-[11px] ${ticket.status === "open" ? "text-[var(--color-lime)]" : "dim"}`}>{ticket.status}</span>
        <span className="text-[11px] dim">{ago(ticket.created_at)}</span>
      </button>

      {open && (
        <div className="space-y-3 border-t border-[var(--color-line)] p-2.5 text-xs">
          <p className="whitespace-pre-wrap">{ticket.summary}</p>

          <div className="space-y-1">
            <Row label="contact" value={ticket.contact} />
            <Row label="wallet" value={<Addr address={ticket.address} missing="none given" />} />
            <Row label="page" value={ticket.page ?? "unknown"} />
            <Row label="source" value={ticket.source} />
            <Row label="last touched" value={`${ago(ticket.updated_at)} ago`} />
          </div>

          {ticket.transcript && ticket.transcript.length > 0 && (
            <div className="space-y-2 rounded-lg border border-[var(--color-line)] p-2">
              <div className="dim">the chat before the ticket</div>
              {ticket.transcript.map((m, i) => (
                <div key={i}>
                  <div className="dim">{m.role}</div>
                  <p className="whitespace-pre-wrap break-words">{m.content}</p>
                </div>
              ))}
            </div>
          )}

          <textarea
            className="input min-h-20"
            placeholder="note for whoever picks this up next"
            value={note}
            maxLength={4000}
            onChange={(e) => setNote(e.target.value)}
          />

          <div className="flex flex-wrap gap-2">
            <button
              className="btn btn-ghost text-xs"
              disabled={pending !== null || !noteChanged}
              onClick={() => patch("note", { note })}
            >
              {pending === "note" ? "saving" : "save note"}
            </button>
            {(["open", "answered", "closed"] as Status[]).map((s) => (
              <button
                key={s}
                className="btn btn-ghost text-xs"
                disabled={pending !== null || ticket.status === s}
                onClick={() => patch(s, noteChanged ? { status: s, note } : { status: s })}
              >
                {pending === s ? "saving" : `mark ${s}`}
              </button>
            ))}
          </div>
          {error && <p className="break-words text-xs text-[var(--color-red)]">{error}</p>}
        </div>
      )}
    </div>
  );
}
