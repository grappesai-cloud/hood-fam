/// 0x.fam's mark: the two characters every address on this chain opens with, and the block a
/// terminal parks where the next character will land. The suffix is dimmed rather than lit, because
/// on this front the accent belongs to whatever is live, never to the furniture.
///
/// Spans and a background colour, not an SVG or an image: the mark has to sit on a 44px header line
/// next to 12px route text and still line up on the monospace grid, which it only does if it is
/// actually text.
export function Wordmark({ className }: { className?: string }) {
  return (
    <span className={className}>
      0x<span className="ox-caret" aria-hidden="true" />
      <span className="ox-mark-tail">.fam</span>
    </span>
  );
}
