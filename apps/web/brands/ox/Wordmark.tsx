/// The transparent glass OX is optically cropped by the theme so the mark, not its source canvas,
/// sets the size in the navigation.
export function Wordmark({ className }: { className?: string }) {
  return (
    <span className={`ox-wordmark ${className ?? ""}`.trim()}>
      <span className="ox-wordmark-mark" aria-hidden="true">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src="/ox/ox-glossy.svg" alt="" />
      </span>
    </span>
  );
}
