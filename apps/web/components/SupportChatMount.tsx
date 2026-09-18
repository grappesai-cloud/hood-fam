"use client";

import dynamic from "next/dynamic";

/// The help widget sits in the root layout, so it is in the first-load bundle of every page even
/// though it only does anything on click. A server layout cannot use `ssr: false` directly, so this
/// tiny client wrapper does: it splits SupportChat into its own chunk, loaded after hydration.
const SupportChat = dynamic(() => import("./SupportChat").then((m) => m.SupportChat), { ssr: false });

export function SupportChatMount() {
  return <SupportChat />;
}
