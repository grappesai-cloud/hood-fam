"use client";

/// What a page shows when it has nothing to show. It is not a box with a sentence in it: the frame
/// draws itself open, one edge at a time, clockwise, and once it has closed a light keeps running
/// around it. The shape is borrowed from the Night Agents intro, where the plane unfolds before the
/// site arrives, and it does the same job here: a page with no data should look like it is opening,
/// not like it has failed.
///
/// Inside, the coin from the hero turns over a radar of rings, so an empty page still looks like
/// this product. Everything stops for anybody who asked for less motion.
export function Empty({ title, body, action }: { title: string; body: string; action?: React.ReactNode }) {
  return (
    <div className="empty">
      {/* Four edges, each growing from the corner the one before it finished at. */}
      <div className="empty-frame" aria-hidden="true">
        <span className="e-t" /><span className="e-r" /><span className="e-b" /><span className="e-l" />
      </div>
      {/* The light that keeps travelling once the frame has closed. */}
      <div className="empty-glow" aria-hidden="true" />

      <div className="empty-body">
        <div className="empty-stage" aria-hidden="true">
          <span className="empty-ring" />
          <span className="empty-ring" />
          <span className="empty-ring" />
          <div className="coin coin-sm">
            <div className="coin-face front"><span className="coin-mark">hood</span></div>
            <div className="coin-face back"><span className="coin-mark">FAM</span></div>
          </div>
        </div>
        <h2>{title}</h2>
        <p>{body}</p>
        {action}
      </div>
    </div>
  );
}
