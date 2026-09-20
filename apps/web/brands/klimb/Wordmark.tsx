/// Klimb's mark: a K drawn in one gesture, whose leg dips off the stem and then climbs away to the
/// upper right as an arrow. It is the row on the board turned into a letter, which is the whole
/// idea of this face: a launch is a thing that rises towards its pool or does not.
///
/// Inline SVG on `currentColor` rather than a file, so the mark takes the colour of whatever it
/// sits in (the rail, the footer, a button) and needs no second asset to stay in step with the
/// palette. Stroke, not fill: at 20px a filled letterform closes up, a hairline stays legible.
export function Wordmark({ className }: { className?: string }) {
  return (
    <span className={className ? `kl-wordmark ${className}` : "kl-wordmark"}>
      <svg className="kl-wordmark-glyph" viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"
        fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        {/* the stem */}
        <path d="M5 3.5V20.5" />
        {/* the arm, falling from the top right into the middle of the stem */}
        <path d="M15 4L5 12.5" />
        {/* the leg: down to the baseline the way a K's leg does, and then away and up. The climb
            stays well below the arm so the two strokes never close up at 22px. */}
        <path d="M5 12.5L11 19L21 8.5" />
        {/* the head of the arrow, square on the line of the climb */}
        <path d="M16.7 9.8L21 8.5L19.9 12.9" />
      </svg>
      <span className="kl-wordmark-name">Klimb</span>
    </span>
  );
}
