/// The pixel mark and the name, side by side, at every size. The mark is one flat green SVG with
/// no plate behind it, so it sits on the pearl page and on the dark footer alike.
export function Wordmark({ className }: { className?: string }) {
  return (
    <span className={`ox-wordmark ${className ?? ""}`.trim()}>
      <span className="ox-wordmark-mark" aria-hidden="true">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src="/ox/ox-pixel.svg" alt="" width={50} height={30} loading="eager" decoding="async" />
      </span>
      <span className="ox-wordmark-name">ox.family</span>
    </span>
  );
}
