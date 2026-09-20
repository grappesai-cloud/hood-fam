/// Bodega's mark: the name in the serif, under the awning of a corner shop.
///
/// The awning is drawn here rather than loaded as a file because the header, the footer and the
/// share card all take the mark from this one component, and an image would be a second copy of
/// the name to keep in step with this one. It is the only place the accent appears in the chrome.
export function Wordmark({ className }: { className?: string }) {
  return (
    <span className={className ? `bd-mark ${className}` : "bd-mark"}>
      {/* A scalloped canopy: a flat valance with four half circles hanging off it. Sized in `em` by
          the stylesheet, so it grows with whatever text size the mark is set at. */}
      <svg className="bd-mark-awning" viewBox="0 0 24 6" width="24" height="6" aria-hidden="true" focusable="false">
        <path
          fill="currentColor"
          d="M0 0h24v3a3 3 0 0 1-6 0 3 3 0 0 1-6 0 3 3 0 0 1-6 0 3 3 0 0 1-6 0z"
        />
      </svg>
      <span className="bd-mark-word">Bodega</span>
    </span>
  );
}
