/// One lightweight, background-free mark at every size.
export function Wordmark({ className }: { className?: string }) {
  return (
    <span className={`ox-wordmark ${className ?? ""}`.trim()}>
      <span className="ox-wordmark-mark" aria-hidden="true">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src="/ox/ox-pixel.svg" alt="" width={128} height={56} loading="eager" decoding="async" />
      </span>
    </span>
  );
}
