// Drives the MCP server over stdio against the fork, the way an agent would: import an anvil key
// into the encrypted keystore, unlock it, read a token, quote, trade, and print a direct launch.
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";

const env = Object.fromEntries(readFileSync("/tmp/hood-fork.env", "utf8").trim().split("\n").map((l) => l.split("=")));
const p = spawn("node", ["packages/mcp/dist/index.js"], {
  env: { ...process.env, ...env, HOOD_RPC: "http://127.0.0.1:8545", HOOD_API: "http://127.0.0.1:8099",
    HOOD_KEYSTORE: "/tmp/hood-mcp-keystore.json", AGENT_MODE: "1" },
  stdio: ["pipe", "pipe", "pipe"],
});
let buf = "", next = 1; const pending = new Map();
p.stdout.on("data", (d) => {
  buf += d;
  const lines = buf.split("\n"); buf = lines.pop();
  for (const line of lines) { if (!line.trim()) continue; const m = JSON.parse(line); if (pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } }
});
p.stderr.on("data", (d) => process.stderr.write(d));
const call = (method, params) => new Promise((res) => { const id = next++; pending.set(id, res); p.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n"); });
const tool = async (name, args) => {
  const r = await call("tools/call", { name, arguments: args });
  const text = r.result?.content?.map((c) => c.text ?? "[image]").join("\n") ?? JSON.stringify(r);
  let failed = r.result?.isError;
  // a wallet left in the keystore by an earlier run is not a failure of the tool under test
  if (failed && name === "hood_wallet_import" && text.includes("already exists")) failed = false;
  console.log(`\n== ${name} ${failed ? "FAILED" : "ok"} ==\n${text.slice(0, 700)}`);
  if (failed) process.exitCode = 1;
  return text;
};

await call("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "harness", version: "1" } });
const tokens = JSON.parse(await tool("hood_get_deployments", { limit: 5 }));
const curveToken = tokens.tokens.find((t) => t.mode === "curve")?.token;
const directToken = tokens.tokens.find((t) => t.mode === "direct")?.token;

await tool("hood_wallet_import", { label: "bob", privateKey: "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a", password: "correct horse battery" });
await tool("hood_wallet_unlock", { label: "bob", password: "correct horse battery" });
await tool("hood_get_token", { token: curveToken });
await tool("hood_direct_info", { token: directToken });
await tool("hood_quote", { token: directToken, side: "buy", amount: "0.1" });
await tool("hood_supported_chains", { token: curveToken });
await tool("hood_launch_token", { name: "Agent Curve", symbol: "AGNT", feeModel: "buyback", firstBuy: "0.1" });
await tool("hood_plan_direct_launch", { name: "Agent Direct", symbol: "AGNTD", openValuation: 10, bondValuation: 100 });
await tool("hood_launch_direct", { name: "Agent Direct", symbol: "AGNTD", openValuation: 10, bondValuation: 100, firstBuy: "0.1" });
await tool("hood_get_creator_fees", { token: curveToken });
await tool("hood_claim_dividends", { token: directToken, account: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8" });
p.kill();
console.log("\nMCP HARNESS DONE", process.exitCode ? "(with failures)" : "(all ok)");
