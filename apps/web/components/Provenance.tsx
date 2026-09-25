/// Every number on this pad says how it was obtained, and a number that cannot be obtained
/// honestly is a dash with the reason next to it, never a zero. A zero reads as a measurement
/// somebody took; on a fresh launchpad the numbers that look invented are the first thing a reader
/// distrusts, and this is the cheapest answer to that.
///
/// Three words, the same three on every page:
///   measured  summed by our own indexer from events it read on chain
///   reported  taken from a third party (a price feed, a screener) and shown as given
///   derived   computed from the other two, so it inherits the weaker source

export type Provenance = "measured" | "reported" | "derived";

const TITLE: Record<Provenance, string> = {
  measured: "Summed by our indexer from events it read on chain.",
  reported: "Taken from a third party and shown as given.",
  derived: "Computed from the other two, so it inherits the weaker source.",
};

export function Prov({ kind }: { kind: Provenance }) {
  return <span className={`prov prov-${kind}`} title={TITLE[kind]}>{kind}</span>;
}

/// A labelled figure. `value` null or empty means the figure could not be computed, and `reason`
/// is printed under the dash so the reader knows what is missing rather than what is zero.
export function Figure({ label, value, kind, reason }: {
  label: string; value: string | null | undefined; kind: Provenance; reason?: string | null;
}) {
  const missing = value == null || value === "";
  return (
    <div className="figure">
      <div className="mono">{missing ? <span className="figure-dash" title={reason ?? undefined}>—</span> : value}</div>
      <div className="dim figure-label">{label} <Prov kind={kind} /></div>
      {missing && reason && <div className="figure-reason">{reason}</div>}
    </div>
  );
}

/// The legend, once per page that carries the tags.
export function ProvenanceKey() {
  return (
    <p className="prov-key">
      <Prov kind="measured" /> summed from events our indexer read on chain
      <span className="prov-sep">·</span>
      <Prov kind="reported" /> taken from a third party as given
      <span className="prov-sep">·</span>
      <Prov kind="derived" /> computed from the other two, inherits the weaker source
      <span className="prov-sep">·</span>
      a dash is a figure that could not be computed honestly; a zero is a measured zero
    </p>
  );
}

/// Dollars for a reader: $1.2M, $34.5k, $12.30, $0.0042. Not for accounting.
export function usdCompact(n: number): string {
  const abs = Math.abs(n);
  if (abs >= 1e9) return `$${(n / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `$${(n / 1e6).toFixed(2)}M`;
  if (abs >= 1e4) return `$${(n / 1e3).toFixed(1)}k`;
  if (abs >= 1) return `$${n.toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
  if (abs === 0) return "$0";
  return `$${n.toPrecision(2)}`;
}
