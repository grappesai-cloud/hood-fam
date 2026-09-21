"use client";

import { useEffect, useState } from "react";
import { useLive } from "@/lib/live";

export function GraduationCelebration({ token, symbol }: { token: string; symbol: string }) {
  const [active, setActive] = useState(false);
  useLive({
    tokens: [token],
    onGraduated: (event) => {
      if (event.token.toLowerCase() === token.toLowerCase()) setActive(true);
    },
  });

  useEffect(() => {
    if (!active) return;
    const timer = window.setTimeout(() => setActive(false), 5_500);
    return () => window.clearTimeout(timer);
  }, [active]);

  if (!active) return null;
  return (
    <div className="graduation-celebration" role="status" aria-live="polite">
      <div className="graduation-burst" aria-hidden="true">
        {Array.from({ length: 28 }, (_, i) => <i key={i} style={{ "--i": i } as React.CSSProperties} />)}
      </div>
      <strong>${symbol} graduated</strong>
      <span>Liquidity is live and locked.</span>
    </div>
  );
}
