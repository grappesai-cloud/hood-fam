import { randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { Address } from "viem";

/// Everything that reaches the page below is a string an agent chose, and an agent reads token
/// names, descriptions and error messages off a public chain. A label carrying a script tag would
/// run on a page that holds the user's wallet, next to a transaction it could rewrite before they
/// sign it. So: text is escaped, calldata has to look like calldata, and the JSON the page needs
/// cannot close the script tag it sits in.
const escapeHtml = (text: string) =>
  text.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

const escapeJson = (value: unknown) =>
  JSON.stringify(value).replace(/</g, "\\u003c").replace(/>/g, "\\u003e").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");

const HEX = /^0x[0-9a-fA-F]*$/;

/// The browser signer. A private key is not the only way to sign: the agent prepares the
/// transaction, the human opens one local page and signs it in their own wallet. Nothing about
/// the key ever reaches the model, which is the point.
export interface PendingTx {
  id: string;
  to: Address;
  data: `0x${string}`;
  value: string;
  chainId: number;
  label: string;
  status: "pending" | "sent" | "rejected";
  hash?: string;
  error?: string;
}

const PAGE = (tx: PendingTx) => `<!doctype html>
<html><head><meta charset="utf-8"><title>hood.fam signer</title>
<style>
 :root{color-scheme:dark}
 body{background:#0b0d0e;color:#e8eae9;font:15px/1.5 ui-sans-serif,system-ui,sans-serif;margin:0;
      display:grid;place-items:center;min-height:100vh;padding:16px}
 .card{max-width:520px;width:100%;background:#121516;border:1px solid #232829;border-radius:14px;padding:22px}
 h1{font-size:18px;margin:0 0 4px} p{color:#9aa3a1;margin:6px 0}
 code{background:#0b0d0e;border:1px solid #232829;border-radius:6px;padding:2px 6px;font-size:12px;word-break:break-all}
 button{margin-top:16px;width:100%;padding:12px;border-radius:10px;border:0;background:#c6f24e;color:#0b0d0e;
        font-weight:650;font-size:15px;cursor:pointer}
 button:disabled{opacity:.5;cursor:default}
 .row{display:flex;justify-content:space-between;gap:12px;padding:8px 0;border-bottom:1px solid #1c2021}
 .ok{color:#c6f24e}.err{color:#ff6b6b}
</style></head><body><div class="card">
<h1>${escapeHtml(tx.label)}</h1>
<p>Sign in your own wallet. This page runs on your machine.</p>
<div class="row"><span>to</span><code>${escapeHtml(tx.to)}</code></div>
<div class="row"><span>value</span><code>${escapeHtml(tx.value)} wei</code></div>
<div class="row"><span>chain</span><code>${tx.chainId.toFixed(0)}</code></div>
<button id="go">Connect and sign</button>
<p id="out"></p>
</div><script>
const tx = ${escapeJson({ to: tx.to, data: tx.data, value: "0x" + BigInt(tx.value).toString(16), chainId: tx.chainId })};
const out = document.getElementById("out");
document.getElementById("go").onclick = async () => {
  const p = window.ethereum;
  if (!p) { out.className="err"; out.textContent="No wallet in this browser."; return; }
  try {
    const [from] = await p.request({ method: "eth_requestAccounts" });
    const want = "0x" + tx.chainId.toString(16);
    if (await p.request({ method: "eth_chainId" }) !== want) {
      await p.request({ method: "wallet_switchEthereumChain", params: [{ chainId: want }] });
    }
    const hash = await p.request({ method: "eth_sendTransaction",
      params: [{ from, to: tx.to, data: tx.data, value: tx.value }] });
    out.className="ok"; out.textContent = "sent: " + hash;
    await fetch("/done", { method:"POST", headers:{"content-type":"application/json"},
      body: JSON.stringify({ id: ${escapeJson(tx.id)}, hash }) });
  } catch (e) {
    out.className="err"; out.textContent = e.message ?? String(e);
    await fetch("/done", { method:"POST", headers:{"content-type":"application/json"},
      body: JSON.stringify({ id: ${escapeJson(tx.id)}, error: e.message ?? String(e) }) });
  }
};
</script></body></html>`;

export class WebSigner {
  private server?: Server;
  private port = 0;
  private txs = new Map<string, PendingTx>();

  async open(tx: Omit<PendingTx, "id" | "status">): Promise<PendingTx> {
    if (!HEX.test(tx.data)) throw new Error("calldata must be 0x followed by hex, and nothing else");
    if (!/^0x[0-9a-fA-F]{40}$/.test(tx.to)) throw new Error("the recipient must be an address");
    if (!/^\d+$/.test(String(tx.value))) throw new Error("value must be a whole number of wei");
    const id = randomBytes(16).toString("hex");
    const pending: PendingTx = { ...tx, id, status: "pending" };
    this.txs.set(id, pending);
    await this.ensureServer();
    return pending;
  }

  get(id: string) {
    return this.txs.get(id);
  }

  url(id: string) {
    return `http://127.0.0.1:${this.port}/sign/${id}`;
  }

  private ensureServer(): Promise<void> {
    if (this.server) return Promise.resolve();
    return new Promise((resolve) => {
      this.server = createServer((req, res) => {
        const url = new URL(req.url ?? "/", "http://127.0.0.1");
        if (req.method === "GET" && url.pathname.startsWith("/sign/")) {
          const tx = this.txs.get(url.pathname.slice(6));
          if (!tx) { res.writeHead(404).end("unknown transaction"); return; }
          res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(PAGE(tx));
          return;
        }
        if (req.method === "POST" && url.pathname === "/done") {
          let body = "";
          req.on("data", (c) => (body += c));
          req.on("end", () => {
            try {
              const { id, hash, error } = JSON.parse(body) as { id: string; hash?: string; error?: string };
              const tx = this.txs.get(id);
              if (tx) {
                tx.status = hash ? "sent" : "rejected";
                tx.hash = hash;
                tx.error = error;
              }
            } catch { /* the page is the only caller; a malformed body is not worth a crash */ }
            res.writeHead(204).end();
          });
          return;
        }
        res.writeHead(404).end();
      });
      this.server.listen(0, "127.0.0.1", () => {
        const addr = this.server!.address();
        this.port = typeof addr === "object" && addr ? addr.port : 0;
        resolve();
      });
    });
  }
}
