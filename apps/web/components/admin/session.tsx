"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { API } from "@/lib/config";

/// The operator token. It lives in this tab and nowhere else: no cookie, no local storage, no
/// second window. Every touch of storage is wrapped, because a private window throws on the
/// accessor itself rather than handing back null.

export const ADMIN_KEY = "hood.admin";
export const REFUSED = "that token was refused. sign in again.";

export function readToken(): string | null {
  try {
    return sessionStorage.getItem(ADMIN_KEY);
  } catch {
    return null;
  }
}

export function saveToken(token: string) {
  try {
    sessionStorage.setItem(ADMIN_KEY, token);
  } catch {
    /* private window: the token holds for this render only */
  }
}

export function forgetToken() {
  try {
    sessionStorage.removeItem(ADMIN_KEY);
  } catch {
    /* nothing to forget */
  }
}

/// A 401 is not an error to print in a box. It means the token is gone or was rotated, and the
/// page has to go back to asking for one.
export class Unauthorized extends Error {
  constructor() {
    super(REFUSED);
  }
}

function parse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/// Every admin call, one shape: bearer token in, the API's own `error` text out.
export async function adminFetch<T>(token: string, path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    ...init,
    cache: "no-store",
    headers: {
      ...(init?.body ? { "content-type": "application/json" } : {}),
      ...((init?.headers as Record<string, string> | undefined) ?? {}),
      authorization: `Bearer ${token}`,
    },
  });
  if (res.status === 401) throw new Unauthorized();
  const body = parse(await res.text());
  if (!res.ok) {
    const message = (body as { error?: string } | null)?.error;
    throw new Error(message ?? `${path} answered ${res.status}`);
  }
  return body as T;
}

interface Session {
  token: string;
  signOut: (message?: string) => void;
}

const Ctx = createContext<Session | null>(null);

export function AdminSession({ token, signOut, children }: { token: string; signOut: (message?: string) => void; children: ReactNode }) {
  const value = useMemo(() => ({ token, signOut }), [token, signOut]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAdmin(): Session {
  const session = useContext(Ctx);
  if (!session) throw new Error("admin panels must sit inside AdminSession");
  return session;
}

/// A read that carries the token. No retries: a refused token should bounce to the form on the
/// first answer rather than three seconds later.
export function useAdminQuery<T>(key: readonly unknown[], path: string, refetchInterval: number) {
  const { token, signOut } = useAdmin();
  const query = useQuery<T>({
    queryKey: ["admin", ...key],
    queryFn: () => adminFetch<T>(token, path),
    retry: false,
    refetchInterval,
  });
  const error = query.error;
  useEffect(() => {
    if (error instanceof Unauthorized) signOut(REFUSED);
  }, [error, signOut]);
  return query;
}

/// A write that carries the token, keeps its own pending label and error, and invalidates the
/// admin reads once the API has answered.
export function useAdminAction() {
  const { token, signOut } = useAdmin();
  const queryClient = useQueryClient();
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string>();

  const run = useCallback(
    async <T,>(label: string, path: string, init: RequestInit): Promise<T | null> => {
      setError(undefined);
      setPending(label);
      try {
        const out = await adminFetch<T>(token, path, init);
        await queryClient.invalidateQueries({ queryKey: ["admin"] });
        return out;
      } catch (e) {
        if (e instanceof Unauthorized) {
          signOut(REFUSED);
          return null;
        }
        setError(e instanceof Error ? e.message : String(e));
        return null;
      } finally {
        setPending(null);
      }
    },
    [token, queryClient, signOut],
  );

  return { run, pending, error, setError };
}
