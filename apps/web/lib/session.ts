"use client";

import { useCallback, useEffect, useState } from "react";
import { useAccount, useSignMessage } from "wagmi";

import {
  ChatRefused, chatApi, describe, forgetSession, readSession, saveSession,
  type ChatChallenge, type ChatSession,
} from "./chat";

/// One sign-in for the whole pad.
///
/// The chat was the first thing that needed to know which wallet was asking, so it grew a session:
/// one signature, no account, a token that lasts a week. Everything social since — following a
/// trader, watching a launch, claiming a quest, being tied to whoever brought you — asks exactly
/// the same question, so it takes exactly the same session rather than each growing its own.
///
/// The signature proves the wallet and nothing else. Nothing behind this session can move a token:
/// every one of these routes reads or writes a row in our own database, and anything that touches
/// money is still a transaction the wallet signs on its own.

export { describe } from "./chat";

export interface WalletSession {
  /// The connected address, lower case, or null when no wallet is connected.
  address: string | null;
  /// Whether this wallet already has a session token to send.
  signedIn: boolean;
  /// Signs in if needed, then runs the call with the bearer attached. A session that the API has
  /// stopped accepting is thrown away and made again once, because the common reason for a 401 is
  /// a week having passed, and asking the reader to click twice for that is noise.
  authed: <T>(path: string, options?: { method?: string; body?: unknown }) => Promise<T>;
  /// Signs in without making a call, for a button that says so.
  signIn: () => Promise<void>;
  signingIn: boolean;
}

export function useWalletSession(): WalletSession {
  const { address } = useAccount();
  const { signMessageAsync } = useSignMessage();
  const [signedIn, setSignedIn] = useState(false);
  const [signingIn, setSigningIn] = useState(false);
  const me = address?.toLowerCase() ?? null;

  useEffect(() => {
    setSignedIn(Boolean(me && readSession(me)));
  }, [me]);

  const open = useCallback(async (): Promise<string> => {
    if (!address) throw new Error("Connect a wallet first.");
    const kept = readSession(address);
    if (kept) return kept.token;
    setSigningIn(true);
    try {
      const challenge = await chatApi<ChatChallenge>("/chat/nonce", { method: "POST", body: { address } });
      const signature = await signMessageAsync({ message: challenge.message });
      const opened = await chatApi<ChatSession>("/chat/session", {
        method: "POST", body: { address, nonce: challenge.nonce, signature },
      });
      saveSession(address, opened);
      setSignedIn(true);
      return opened.token;
    } finally {
      setSigningIn(false);
    }
  }, [address, signMessageAsync]);

  const authed = useCallback(async <T,>(path: string, options: { method?: string; body?: unknown } = {}): Promise<T> => {
    const token = await open();
    try {
      return await chatApi<T>(path, { ...options, session: token });
    } catch (error) {
      if (error instanceof ChatRefused && error.status === 401 && address) {
        forgetSession(address);
        setSignedIn(false);
        const fresh = await open();
        return chatApi<T>(path, { ...options, session: fresh });
      }
      throw error;
    }
  }, [address, open]);

  return { address: me, signedIn, signingIn, authed, signIn: async () => { await open(); } };
}

/// The referral code that brought this browser here, kept until a wallet is connected and bound.
/// It survives the walk from the link to the first trade, which is the whole point: nobody signs
/// anything the second they land.
const REF_KEY = "hood.ref";

export function rememberReferral(code: string) {
  try {
    if (!/^0x[0-9a-fA-F]{40}$/.test(code)) return;
    localStorage.setItem(REF_KEY, code.toLowerCase());
  } catch {
    /* private window: the code lives for this page view, and binding still works from the link */
  }
}

export function pendingReferral(): string | null {
  try {
    return localStorage.getItem(REF_KEY);
  } catch {
    return null;
  }
}

export function clearReferral() {
  try {
    localStorage.removeItem(REF_KEY);
  } catch {
    /* nothing to clear */
  }
}
