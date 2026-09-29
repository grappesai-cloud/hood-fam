/// The bag mark and the name, side by side, at every size. The mark is one flat green SVG with
/// no plate behind it, so it sits on the dark page and on the black footer alike.
export function Wordmark({ className }: { className?: string }) {
  return (
    <span className={`ox-wordmark ${className ?? ""}`.trim()}>
      <span className="ox-wordmark-mark" aria-hidden="true">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src="/ox/bags-mark.svg" alt="" width={32} height={32} loading="eager" decoding="async" />
      </span>
      <span className="ox-wordmark-name">famdotfun</span>
    </span>
  );
}
