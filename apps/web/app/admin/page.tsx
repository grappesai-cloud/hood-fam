"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { AdminSession, adminFetch, forgetToken, readToken, saveToken, Unauthorized } from "@/components/admin/session";
import { OverviewPanel } from "@/components/admin/OverviewPanel";
import { TicketQueue } from "@/components/admin/TicketQueue";
import { SeasonsPanel } from "@/components/admin/SeasonsPanel";
import { PortalPanel } from "@/components/admin/PortalPanel";
import { FactoryPanel } from "@/components/admin/FactoryPanel";
import { BridgePanel } from "@/components/admin/BridgePanel";
import { WalletStrip } from "@/components/admin/owner";

/// The desk. Two halves that never touch: the left one is the server, opened with a token that
/// lives in this tab, and the right one is the chain, opened with the owner's wallet. Nothing
/// links here from the nav; you arrive by knowing the address.
export default function AdminPage() {
  const [token, setToken] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [message, setMessage] = useState<string>();
  const queryClient = useQueryClient();

  useEffect(() => {
    setToken(readToken());
    setReady(true);
  }, []);

  const signOut = useCallback(
    (why?: string) => {
      forgetToken();
      setToken(null);
      setMessage(why);
      queryClient.removeQueries({ queryKey: ["admin"] });
    },
    [queryClient],
  );

  if (!ready) return <p className="py-10 text-center text-sm dim">reading</p>;

  if (!token) {
    return (
      <SignIn
        message={message}
        onToken={(t) => {
          saveToken(t);
          setMessage(undefined);
          setToken(t);
        }}
      />
    );
  }

  return (
    <AdminSession token={token} signOut={signOut}>
      <div className="space-y-4">
        <header className="page-intro flex items-end justify-between gap-4">
          <div>
            <div className="section-kicker">OPERATIONS</div>
            <h1>the desk</h1>
            <p>What the box is doing, who is waiting for an answer, and the switches only an owner can throw.</p>
          </div>
          <button className="btn btn-ghost text-xs" onClick={() => signOut()}>
            sign out
          </button>
        </header>

        <div className="grid items-start gap-4 lg:grid-cols-2">
          <div className="space-y-4">
            <OverviewPanel />
            <TicketQueue />
            <SeasonsPanel />
          </div>
          <div className="space-y-4">
            <WalletStrip />
            <PortalPanel />
            <FactoryPanel />
            <BridgePanel />
          </div>
        </div>
      </div>
    </AdminSession>
  );
}

/// One field, one call. The token is checked against /admin/me before it is kept, so a typo never
/// gets as far as a panel.
function SignIn({ message, onToken }: { message?: string; onToken: (token: string) => void }) {
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      await adminFetch<{ ok: boolean }>(draft.trim(), "/admin/me");
      onToken(draft.trim());
    } catch (err) {
      setError(err instanceof Unauthorized ? "that token is not the one." : err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="panel mx-auto mt-10 max-w-sm space-y-3 p-5">
      <div>
        <h1 className="font-semibold">the desk</h1>
        <p className="text-xs dim">The operator token. It stays in this tab and is dropped the moment it closes.</p>
      </div>
      <input
        className="input mono"
        type="password"
        autoComplete="off"
        placeholder="token"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
      />
      <button className="btn w-full" disabled={busy || draft.trim().length === 0}>
        {busy ? "checking" : "sign in"}
      </button>
      {message && <p className="text-xs dim">{message}</p>}
      {error && <p className="break-words text-xs text-[var(--color-red)]">{error}</p>}
    </form>
  );
}
