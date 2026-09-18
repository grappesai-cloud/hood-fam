// Token art storage against a running API: the 501 when there is no bucket, and when there is one,
// the magic-byte check, the size cap, the content-addressed key and the public URL.
//
//   API=http://127.0.0.1:8099 node scripts/e2e/uploads.mjs
//
// Whether storage is on is read from the API's own /health, not from this shell: the API may be on
// another machine. Nothing here needs a token; an upload is not an admin route. Every object it
// stores is a handful of random pixels under tokens/<sha256>.png, and it stores at most one per run.

import { createHash, randomBytes } from "node:crypto";
import { deflateSync } from "node:zlib";

const API = process.env.API ?? "http://127.0.0.1:8099";

let failed = 0;
const ok = (msg) => console.log("ok  ", msg);
const skip = (msg) => console.log("skip", msg);
const check = (cond, msg) => { if (cond) ok(msg); else { failed++; console.error("FAIL:", msg); } };
const must = (cond, msg) => { if (!cond) { console.error("FAIL:", msg); process.exit(1); } ok(msg); };

const done = () => {
  if (failed) { console.error(`\n${failed} check(s) failed`); process.exit(1); }
  console.log("\nall checks passed");
  process.exit(0);
};

// ---- a PNG nobody has uploaded before, so the dedup answer means something ----

const CRC = Int32Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c;
});
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
};
function png(size = 8) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 2; // 8 bits per channel, truecolour
  const rows = [];
  for (let y = 0; y < size; y++) rows.push(Buffer.concat([Buffer.from([0]), randomBytes(size * 3)]));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr), chunk("IDAT", deflateSync(Buffer.concat(rows))), chunk("IEND", Buffer.alloc(0)),
  ]);
}

// ---- the two ways to post ----

const read = async (r) => ({ status: r.status, body: await r.json().catch(() => null) });

async function postFile(bytes, filename = "art.png", type = "image/png") {
  const form = new FormData();
  form.append("file", new Blob([bytes], { type }), filename);
  try {
    return await read(await fetch(`${API}/uploads/image`, { method: "POST", body: form }));
  } catch (e) {
    // the server can cut an oversized upload off mid-send; that is a refusal too
    return { status: 0, body: null, aborted: String(e?.cause?.message ?? e?.message ?? e) };
  }
}

const postDataUri = async (bytes, type = "image/png") =>
  read(await fetch(`${API}/uploads/image`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ dataUri: `data:${type};base64,${Buffer.from(bytes).toString("base64")}` }),
  }));

// ---- 1. is storage on ----

const health = await read(await fetch(`${API}/health`));
must(health.status === 200 && health.body?.ok === true, "GET /health is ok");
check(typeof health.body.integrations?.storage === "boolean",
  `health.integrations.storage = ${health.body.integrations?.storage}`);
const on = health.body.integrations?.storage === true;

// ---- 2. storage off: one plain sentence, and the URL field still works ----

if (!on) {
  const off = await postDataUri(png());
  check(off.status === 501, `POST /uploads/image with no bucket is 501 (got ${off.status})`);
  const msg = off.body?.error ?? "";
  check(typeof msg === "string" && /uploads are off/i.test(msg) && /url/i.test(msg),
    `it says so in one sentence: "${msg}"`);
  const offFile = await postFile(png());
  check(offFile.status === 501, `the multipart path is 501 too (got ${offFile.status})`);
  console.log("\nstorage is off on this API, so the stored paths were not exercised");
  done();
}

// ---- 3. a file, then the same bytes again ----

const bytes = png();
const sha = createHash("sha256").update(bytes).digest("hex");

const first = await postFile(bytes);
must(first.status === 200 && first.body?.url, `POST /uploads/image stored ${first.body?.bytes} bytes at ${first.body?.url}`);
check(first.body.key === `tokens/${sha}.png`, `the key is the content hash: ${first.body.key}`);
check(first.body.contentType === "image/png", `contentType = ${first.body.contentType}`);
check(first.body.bytes === bytes.length, `bytes = ${first.body.bytes} (sent ${bytes.length})`);
check(first.body.deduped === false, "the first upload of new bytes is not deduped");

const second = await postDataUri(bytes);
must(second.status === 200 && second.body?.url, "the same image again, over the JSON dataUri path");
check(second.body.url === first.body.url, `the same URL both times: ${second.body.url}`);
check(second.body.deduped === true, "the second upload says deduped: true");

// ---- 4. what it refuses ----

const text = Buffer.from("this is not a png, it only says it is\n".repeat(4));
const lying = await postFile(text, "art.png", "image/png");
check(lying.status === 415, `a text file named art.png is refused on its bytes, not its name (${lying.status})`);
check(/png/i.test(lying.body?.error ?? ""), `it says which types it takes: "${lying.body?.error}"`);

const huge = Buffer.concat([bytes, randomBytes(4 * 1024 * 1024)]);
const big = await postFile(huge);
check(big.status === 413 || big.status === 0,
  big.status === 0 ? `a ${(huge.length / 1024 / 1024).toFixed(1)} MiB upload was cut off (${big.aborted})`
    : `a ${(huge.length / 1024 / 1024).toFixed(1)} MiB upload is 413: "${big.body?.error}"`);

const empty = await postDataUri(Buffer.alloc(0));
check(empty.status === 400, `an empty body is 400 (${empty.status})`);

// ---- 5. the URL is really there ----

try {
  const head = await fetch(first.body.url, { method: "HEAD" });
  check(head.ok, `HEAD ${first.body.url} is ${head.status}`);
  check(head.headers.get("content-type")?.startsWith("image/"),
    `it is served as ${head.headers.get("content-type")}`);
  const cache = head.headers.get("cache-control") ?? "";
  check(/max-age=\d{5,}/.test(cache), `and cached long, since the key is the hash: ${cache || "(no cache-control)"}`);
} catch (e) {
  skip(`HEAD ${first.body.url} did not resolve from here (${e?.cause?.message ?? e?.message}); is R2_PUBLIC_BASE public?`);
}

done();
