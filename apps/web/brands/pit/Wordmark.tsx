/// PIT's mark: three letters knocked out of a solid block of accent.
///
/// The other faces of this launchpad sign themselves with lit type. This one is a floor sign: the
/// name is a painted rectangle you could read from the far side of a room, which is why the colour
/// is a fill behind the letters rather than a glow around them. Text, not an image, so it stays
/// sharp at any size and the chrome and a share card can both draw it from one place.
export function Wordmark({ className }: { className?: string }) {
  return (
    <span className={className ? `pit-wordmark ${className}` : "pit-wordmark"}>
      <span className="pit-wordmark-block">PIT</span>
    </span>
  );
}
