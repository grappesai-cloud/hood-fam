"use client";

import { useState } from "react";

/// Token art that degrades to initials instead of a broken image icon. Launch artwork is a URL a
/// stranger typed, so it is broken often enough for this to be the normal path, not the edge.
export function Artwork({ src, symbol, size, rounded = "rounded-lg" }: { src: string; symbol: string; size: number; rounded?: string }) {
  const [broken, setBroken] = useState(false);
  if (!src || broken) {
    return (
      <div className={`grid shrink-0 place-items-center bg-[var(--color-ink)] font-bold ${rounded}`}
        style={{ width: size, height: size, fontSize: size / 3 }}>
        {symbol.slice(0, 2)}
      </div>
    );
  }
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img src={src} alt="" width={size} height={size} onError={() => setBroken(true)}
      className={`shrink-0 object-cover bg-[var(--color-ink)] ${rounded}`} style={{ width: size, height: size }} />
  );
}
