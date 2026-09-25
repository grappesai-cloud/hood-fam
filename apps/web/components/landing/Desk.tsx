"use client";

import { useState } from "react";
import { ProvenanceKey } from "@/components/Provenance";
import { PaidColumn } from "./PaidColumn";
import { MigratedColumn } from "./MigratedColumn";
import { TrendingColumn } from "./TrendingColumn";

/// The desk: three columns right under the header, each its own scroll with its header pinned.
/// Money reaching people on the left, the coins that made it to the pool in the middle, what is
/// trading on the right. On a phone the three become tabs over one list; every column stays
/// mounted whichever tab is open, so switching is instant and the stream keeps each one warm.

const TABS = [
  { id: "paid", label: "Paid out" },
  { id: "migrated", label: "Migrated" },
  { id: "trending", label: "Trending" },
] as const;

type Tab = (typeof TABS)[number]["id"];

export function Desk() {
  const [tab, setTab] = useState<Tab>("paid");
  const open = (id: Tab) => (tab === id ? "is-open" : "");

  return (
    <section className="ox-desk" aria-label="The desk">
      <div className="ox-desk-tabs" role="tablist" aria-label="Desk columns">
        {TABS.map((item) => (
          <button
            key={item.id}
            type="button"
            role="tab"
            aria-selected={tab === item.id}
            className={tab === item.id ? "active" : ""}
            onClick={() => setTab(item.id)}
          >
            {item.label}
          </button>
        ))}
      </div>
      <div className="ox-desk-grid">
        <PaidColumn className={open("paid")} />
        <MigratedColumn className={open("migrated")} />
        <TrendingColumn className={open("trending")} />
      </div>
      <ProvenanceKey />
    </section>
  );
}
