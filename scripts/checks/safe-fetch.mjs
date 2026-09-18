#!/usr/bin/env node
/// The address checks that stand between a creator's artwork URL and our own network.
///
/// A launch's image is metadata a stranger wrote on chain, and the share card fetches it server
/// side. Everything that makes that safe is a list of ranges and a couple of refusals, which is
/// exactly the kind of code that rots quietly, so it is checked rather than trusted. The module is
/// TypeScript inside the app, so this compiles that one file to a temp directory and runs it.
///
/// Usage: node scripts/checks/safe-fetch.mjs

import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const out = mkdtempSync(join(tmpdir(), "hood-safe-fetch-"));

execFileSync(
  "npx",
  ["tsc", "apps/web/lib/og/safe-fetch.ts", "--outDir", out, "--module", "nodenext",
   "--target", "es2022", "--moduleResolution", "nodenext", "--skipLibCheck"],
  { cwd: ROOT, stdio: "inherit" },
);

const { isPublicAddress, fetchPublicBytes } = await import(pathToFileURL(join(out, "safe-fetch.js")).href);

let failed = 0;
const check = (ok, label, detail = "") => {
  if (!ok) { failed++; console.log(`  FAIL  ${label}${detail ? `   ${detail}` : ""}`); }
  else console.log(`  ok    ${label}${detail ? `   ${detail}` : ""}`);
};

const PRIVATE = [
  "127.0.0.1", "10.1.2.3", "172.16.0.1", "172.31.255.255", "192.168.1.1", "169.254.169.254",
  "100.64.0.1", "0.0.0.0", "224.0.0.1", "255.255.255.255", "198.18.0.1",
  "::1", "::", "fd00::1", "fc00::1", "fe80::1", "ff02::1", "::ffff:127.0.0.1", "::ffff:10.0.0.1",
];
const PUBLIC = ["1.1.1.1", "8.8.8.8", "93.184.216.34", "2606:4700:4700::1111", "::ffff:8.8.8.8"];

check(PRIVATE.every((a) => !isPublicAddress(a)), "every private, loopback, link local and reserved address is refused",
  `${PRIVATE.length} of them, including the cloud metadata address`);
check(PUBLIC.every((a) => isPublicAddress(a)), "public addresses are allowed", `${PUBLIC.length} of them`);
check(!isPublicAddress("not an address"), "a string that is not an address is not an address");

const refuses = async (url, label) =>
  check((await fetchPublicBytes(url, { timeoutMs: 1500, maxBytes: 1000 })) === undefined, label, url);

await refuses("http://example.com/a.png", "plain http is refused, so a card cannot be a downgrade");
await refuses("https://127.0.0.1/a.png", "an IP literal is refused before any connection");
await refuses("https://localhost/a.png", "a name that resolves to loopback is refused");
await refuses("ipfs://bafy/whatever", "a scheme we do not fetch is refused");

console.log(failed === 0 ? "\nsafe-fetch: all checks passed" : `\nsafe-fetch: ${failed} failed`);
process.exit(failed ? 1 : 0);
