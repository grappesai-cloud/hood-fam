"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { shortAddress } from "@/lib/format";
import { useAdminAction, useAdminQuery } from "./session";
import { ConfirmButton, Field } from "./ui";

interface Season {
  id: number;
  name: string;
  starts: string;
  ends: string | null;
  snapshot: boolean;
}

interface Board {
  season: number;
  frozen: boolean;
  takenAt?: string;
  rows: { position: number; address: string; points: number; volumeUsd: number; launches: number; rank: string }[];
}

/// A local datetime-local value is a wall clock with no zone. The API wants something it can
/// parse without guessing, so it goes out as an instant.
function instant(value: string): string | undefined {
  if (!value) return undefined;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}

function when(value: string | null): string {
  if (!value) return "open";
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? value : d.toLocaleString();
}

/// Seasons are windows over the points table. Opening the next one closes the last one at the
/// same instant, and a snapshot freezes a board so late points cannot move it any more.
export function SeasonsPanel() {
  const { data, error, isLoading } = useAdminQuery<{ seasons: Season[]; current: number }>(["seasons"], "/admin/seasons", 30_000);
  const { run, pending, error: actionError } = useAdminAction();
  const [picked, setPicked] = useState<number | null>(null);
  const [form, setForm] = useState({ name: "", starts: "", ends: "" });
  const [said, setSaid] = useState<string>();

  const seasons = data?.seasons ?? [];
  const selected = picked ?? data?.current ?? 1;

  const board = useQuery({
    queryKey: ["admin", "board", selected],
    queryFn: () => api<Board>(`/leaderboard?season=${selected}&limit=10`),
    enabled: Boolean(data),
    refetchInterval: 30_000,
  });

  async function open() {
    setSaid(undefined);
    const out = await run<{ season: Season }>("open", "/admin/seasons", {
      method: "POST",
      body: JSON.stringify({ name: form.name.trim(), starts: instant(form.starts), ends: instant(form.ends) }),
    });
    if (out) {
      setForm({ name: "", starts: "", ends: "" });
      setPicked(out.season.id);
      setSaid(`${out.season.name} is open as season ${out.season.id}.`);
    }
  }

  async function close(id: number) {
    setSaid(undefined);
    const out = await run<{ season: Season }>(`close-${id}`, `/admin/seasons/${id}/close`, { method: "POST", body: JSON.stringify({}) });
    if (out) setSaid(`season ${out.season.id} ends ${when(out.season.ends)}.`);
  }

  async function snapshot(id: number) {
    setSaid(undefined);
    const out = await run<{ season: number; rows: number }>(`snapshot-${id}`, `/admin/seasons/${id}/snapshot`, {
      method: "POST",
      body: JSON.stringify({}),
    });
    if (out) setSaid(`froze ${out.rows} rows of season ${out.season}.`);
    await board.refetch();
  }

  return (
    <section className="panel space-y-3 p-4">
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="font-semibold">seasons</h2>
        <span className="text-xs dim">season {data?.current ?? "?"} is live</span>
      </div>

      {isLoading && <p className="text-xs dim">reading</p>}
      {error && <p className="break-words text-xs text-[var(--color-red)]">{error.message}</p>}

      <div className="space-y-2">
        {seasons.map((s) => (
          <div
            key={s.id}
            className={`rounded-lg border p-2.5 ${
              s.id === selected ? "border-[var(--color-lime)]" : "border-[var(--color-line)]"
            }`}
          >
            <button onClick={() => setPicked(s.id)} className="flex w-full items-baseline gap-2 text-left">
              <span className="mono text-xs dim">{s.id}</span>
              <span className="flex-1 truncate text-sm">{s.name}</span>
              {s.id === data?.current && <span className="text-[11px] text-[var(--color-lime)]">live</span>}
              {s.snapshot && <span className="text-[11px] dim">frozen</span>}
            </button>
            <div className="mt-1 text-[11px] dim">
              {when(s.starts)} to {when(s.ends)}
            </div>
            <div className="mt-2 flex flex-wrap gap-2">
              <ConfirmButton
                label="close"
                confirm="close it"
                disabled={pending !== null}
                onConfirm={() => void close(s.id)}
              />
              <ConfirmButton
                label={s.snapshot ? "snapshot again" : "snapshot"}
                confirm="freeze the board"
                disabled={pending !== null}
                onConfirm={() => void snapshot(s.id)}
              />
              {pending === `close-${s.id}` && <span className="text-xs dim">closing</span>}
              {pending === `snapshot-${s.id}` && <span className="text-xs dim">freezing</span>}
            </div>
          </div>
        ))}
      </div>

      <div className="space-y-2 rounded-lg border border-[var(--color-line)] p-2.5">
        <div className="text-sm font-semibold">open the next season</div>
        <p className="text-xs dim">
          The season running now closes the moment this one starts, so no point can land in two seasons or in none.
        </p>
        <Field label="name">
          <input className="input" placeholder="Season 2" value={form.name} maxLength={60} onChange={(e) => setForm({ ...form, name: e.target.value })} />
        </Field>
        <div className="grid gap-2 sm:grid-cols-2">
          <Field label="starts (optional, now if empty)">
            <input className="input mono" type="datetime-local" value={form.starts} onChange={(e) => setForm({ ...form, starts: e.target.value })} />
          </Field>
          <Field label="ends (optional)">
            <input className="input mono" type="datetime-local" value={form.ends} onChange={(e) => setForm({ ...form, ends: e.target.value })} />
          </Field>
        </div>
        <button className="btn w-full text-xs" disabled={form.name.trim().length < 2 || pending !== null} onClick={() => void open()}>
          {pending === "open" ? "opening" : "open season"}
        </button>
      </div>

      {said && <p className="text-xs text-[var(--color-lime)]">{said}</p>}
      {actionError && <p className="break-words text-xs text-[var(--color-red)]">{actionError}</p>}

      <div className="space-y-2 rounded-lg border border-[var(--color-line)] p-2.5">
        <div className="flex items-baseline justify-between gap-3">
          <div className="text-sm font-semibold">top of the board, season {selected}</div>
          {board.data?.frozen && (
            <span className="text-[11px] dim">frozen {board.data.takenAt ? when(board.data.takenAt) : ""}</span>
          )}
        </div>
        {board.isError && <p className="text-xs text-[var(--color-red)]">could not read the board for this season.</p>}
        {board.data?.rows.length === 0 && <p className="py-2 text-xs dim">nobody has scored in this season.</p>}
        {board.data && board.data.rows.length > 0 && (
          <table className="w-full text-xs">
            <thead className="dim">
              <tr>
                <th className="pb-1 text-left">#</th>
                <th className="text-left">wallet</th>
                <th className="text-left">rank</th>
                <th className="text-right">launches</th>
                <th className="text-right">points</th>
              </tr>
            </thead>
            <tbody>
              {board.data.rows.map((r) => (
                <tr key={r.address} className="border-t border-[var(--color-line)]">
                  <td className="py-1">{r.position}</td>
                  <td className="mono">{shortAddress(r.address)}</td>
                  <td className="dim">{r.rank}</td>
                  <td className="text-right">{r.launches}</td>
                  <td className="mono text-right">{Math.round(r.points).toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </section>
  );
}
