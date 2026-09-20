"use client";

import { useEffect } from "react";
import { useConnect } from "wagmi";
import { safeQueueUrl } from "@hood/sdk";
import { usePendingSafeTxs, useSafeAccount } from "@/lib/safe";

/// Inside Safe{Wallet} the app is framed by the Safe, so it connects to it without a Connect button:
/// there is one account here and it is the Safe's.
export function SafeAutoConnect() {
  const { connect, connectors, status } = useConnect();
  useEffect(() => {
    if (typeof window === "undefined" || window.parent === window || status !== "idle") return;
    const safe = connectors.find((c) => c.id === "safe");
    if (safe) connect({ connector: safe });
  }, [connect, connectors, status]);
  return null;
}

/// What a Safe does with a transaction is queue it. Every button in the app still says "confirming"
/// while that happens, which is true but says nothing about why it is taking minutes: this says the
/// rest, and points at the queue where the other signers are.
export function SafeStrip() {
  const waiting = usePendingSafeTxs();
  const { safe } = useSafeAccount();
  if (waiting.length === 0) return null;

  return (
    <div className="safe-strip" role="status">
      <span className="safe-dot" aria-hidden="true" />
      <span>
        {waiting.length === 1 ? "A transaction is waiting in your Safe" : `${waiting.length} transactions are waiting in your Safe`}
        {waiting[0]?.required
          ? `: ${waiting[0].confirmations ?? 0} of ${waiting[0].required} signatures so far.`
          : safe
            ? `: it runs once ${safe.threshold} of ${safe.owners.length} owners have signed.`
            : "."}
        {waiting.some((w) => w.txHash) ? " One has just gone through." : ""}
      </span>
      {(safe ?? waiting[0]) && (
        <a className="safe-strip-link" href={safeQueueUrl(safe?.address ?? waiting[0]!.safe)} target="_blank" rel="noreferrer noopener">
          open the queue
        </a>
      )}
    </div>
  );
}
