/// The generated glass OX is used as the visual mark. The crop keeps the same source usable in the
/// narrow sidebar while the full frame remains available to the home-page hero.
export function Wordmark({ className }: { className?: string }) {
  return (
    <span className={`ox-wordmark ${className ?? ""}`.trim()}>
      <span className="ox-wordmark-mark" aria-hidden="true">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src="/ox/ox-green-hero.png" alt="" />
      </span>
      <span className="ox-wordmark-name">ox<span>.family</span></span>
    </span>
  );
}
