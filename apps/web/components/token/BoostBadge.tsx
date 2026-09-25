/// The tag a launch wears while it holds a boost slot on the board. It is a fact from the boosts
/// contract, read by the indexer for the current hour, so it reads as a label and not as praise.
/// No hooks, so a card that is not a client component can wear it too.
export function BoostBadge({ className }: { className?: string }) {
  return (
    <span
      className={className ? `boost-tag ${className}` : "boost-tag"}
      title="This launch bought a slot on the board for this hour. The house was paid for it, through the Bag."
    >
      boosted
    </span>
  );
}
