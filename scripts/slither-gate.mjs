#!/usr/bin/env node
// The static analysis gate: fails on a Slither finding nobody has read yet.
//
//   slither . <flags> --json slither.json; node scripts/slither-gate.mjs slither.json
//   node scripts/slither-gate.mjs slither.json --write     after reading the new ones
//
// Every finding in docs/slither-baseline.json has a verdict in docs/SECURITY.md. Slither's own
// triage database keys a finding by its line numbers, so any edit above it in the same file would
// turn a read finding into a new one; here a finding is its detector, the contract and function it
// sits in, and the statement it points at, which only change when the code in question does.

import { readFileSync, writeFileSync } from "node:fs";

const BASELINE = new URL("../docs/slither-baseline.json", import.meta.url);
const [file, flag] = process.argv.slice(2);
if (!file) {
  console.error("usage: slither-gate.mjs <slither.json> [--write]");
  process.exit(2);
}

const report = JSON.parse(readFileSync(file, "utf8"));
if (!report.success) {
  console.error("slither did not finish:", report.error);
  process.exit(1);
}

function where(e) {
  const f = e.type_specific_fields ?? {};
  if (e.type === "function") return `${f.parent?.name}.${f.signature ?? e.name}`;
  if (f.parent) return `${where(f.parent)}:${e.name}`;
  return e.name;
}

function key(r) {
  const [first, second] = r.elements;
  const at = second?.type === "node" ? ` @ ${second.name.replace(/\s+/g, " ")}` : "";
  return `${r.check} | ${where(first)}${at}`;
}

const found = {};
for (const r of report.results?.detectors ?? []) found[key(r)] = (found[key(r)] ?? 0) + 1;

if (flag === "--write") {
  const sorted = Object.fromEntries(Object.entries(found).sort(([a], [b]) => a.localeCompare(b)));
  writeFileSync(BASELINE, JSON.stringify(sorted, null, 2) + "\n");
  console.log(`baseline written: ${Object.keys(sorted).length} findings`);
  process.exit(0);
}

const baseline = JSON.parse(readFileSync(BASELINE, "utf8"));
const unread = Object.entries(found).filter(([k, n]) => n > (baseline[k] ?? 0));
const gone = Object.keys(baseline).filter((k) => !(k in found));

if (gone.length) console.log(`${gone.length} baseline finding(s) no longer reported; rewrite the baseline to drop them.`);
if (unread.length) {
  console.error(`${unread.length} finding(s) with no verdict in docs/SECURITY.md:`);
  for (const [k] of unread) console.error(`  ${k}`);
  process.exit(1);
}
console.log(`${Object.values(found).reduce((a, b) => a + b, 0)} findings, all read`);
