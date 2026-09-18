import Link from "next/link";

/// The line that keeps a demo honest.
///
/// A preview seeded with invented launches looks exactly like a launchpad with real ones, which is
/// the point of seeding it and also the danger: the page cannot be allowed to imply that anybody
/// traded anything. Shown on every page whenever NEXT_PUBLIC_DEMO is set, which is a build-time
/// decision, so a real deployment cannot end up with the strip and a demo cannot end up without it.
const DEMO = process.env.NEXT_PUBLIC_DEMO === "1";
const WALLET = process.env.NEXT_PUBLIC_DEMO_WALLET;

export function DemoBanner() {
  if (!DEMO) return null;
  return (
    <div className="demo-strip" role="note">
      <span>
        <strong>Demo data.</strong> The launches, wallets and trades here are invented, so the board has
        something to show. Nothing is on chain and no button writes anything.
      </span>
      {WALLET && <Link href={`/portfolio?address=${WALLET}`}>open the demo wallet</Link>}
    </div>
  );
}
