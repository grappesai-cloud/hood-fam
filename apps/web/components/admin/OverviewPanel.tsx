"use client";

import { useAdminQuery } from "./session";
import { Addr, Chip, Fact, Row } from "./ui";

interface Overview {
  indexedBlock: number | null;
  head: number | null;
  blocksBehind: number | null;
  integrations: { assistant: boolean; art: boolean; relay: boolean };
  contracts: Record<string, string | null>;
  launches: number;
  graduated: number;
  openTickets: number;
  currentSeason: number;
}

/// The names in the order an operator reads them: the two machines first, then the modules.
const CONTRACTS: { key: string; label: string }[] = [
  { key: "factory", label: "factory" },
  { key: "portal", label: "portal" },
  { key: "directDeployer", label: "direct deployer" },
  { key: "feeRouter", label: "fee router" },
  { key: "staking", label: "staking" },
  { key: "graduator", label: "graduator" },
  { key: "buybackModule", label: "buyback module" },
  { key: "bridgeFactory", label: "bridge factory" },
];

/// Blocks are 100 ms apart on this chain, so a block count is also a clock.
function behind(blocks: number): string {
  const seconds = blocks / 10;
  if (seconds < 1) return "under a second of chain time";
  if (seconds < 90) return `about ${seconds.toFixed(1)}s of chain time`;
  return `about ${Math.round(seconds / 60)}m of chain time`;
}

export function OverviewPanel() {
  const { data, error, isLoading } = useAdminQuery<Overview>(["overview"], "/admin/overview", 15_000);

  return (
    <section className="panel space-y-3 p-4">
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="font-semibold">the box</h2>
        <span className="text-xs dim">season {data?.currentSeason ?? "?"}</span>
      </div>

      {isLoading && <p className="text-xs dim">reading</p>}
      {error && !(data) && <p className="break-words text-xs text-[var(--color-red)]">{error.message}</p>}

      {data && (
        <>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
            <Fact label="indexed block" value={data.indexedBlock?.toLocaleString() ?? "none"} />
            <Fact label="chain head" value={data.head?.toLocaleString() ?? "no answer"} />
            <Fact label="open tickets" value={data.openTickets} />
            <Fact label="launches" value={data.launches} />
            <Fact label="graduated" value={data.graduated} />
            <Fact label="season" value={data.currentSeason} />
          </div>

          <p className="text-xs dim">
            {data.blocksBehind === null
              ? "the node did not answer, so there is nothing to compare the indexer against."
              : data.blocksBehind <= 0
                ? "indexer is level with the head."
                : `indexer ${data.blocksBehind.toLocaleString()} blocks behind · ${behind(data.blocksBehind)}`}
          </p>

          <div className="flex flex-wrap gap-2 pt-1">
            <Chip on={data.integrations.assistant} label="assistant" />
            <Chip on={data.integrations.art} label="art" />
            <Chip on={data.integrations.relay} label="relay" />
          </div>

          <div className="space-y-1.5 pt-1">
            {CONTRACTS.map((c) => (
              <Row key={c.key} label={c.label} value={<Addr address={data.contracts[c.key]} missing="not deployed" />} />
            ))}
          </div>
          <p className="text-xs dim">
            These are the addresses the API itself is using. If one is empty, that half of the product is dark for
            everyone, not only here.
          </p>
        </>
      )}
    </section>
  );
}
