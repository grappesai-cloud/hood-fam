import { createHash } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import multipart from "@fastify/multipart";
import { HeadObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";

/// Token art has to end up as a URL. A launch writes its image string into calldata and into the
/// launch event, so a 40 KB base64 data URI there is tens of millions of gas paid for something a
/// link does better. The bytes land here instead and the chain only ever carries the link.
///
/// Deliberately not behind the admin token: a creator about to launch is not an operator. What it
/// deliberately does not do is transform, re-encode or resize anything; the object is exactly the
/// bytes that were sent, addressed by their own hash.

const DEFAULT_MAX_BYTES = 4 * 1024 * 1024;
/// How many bytes this process will put in the bucket in a day, over every caller.
/// @dev The route is deliberately open, so the per-IP limit is a speed bump rather than a budget:
///      an address in a header is not an identity, and a bucket bill is not a rate. This is the
///      backstop that turns "somebody is looping it" from a cost into a 503.
const DEFAULT_DAY_BYTES = 2 * 1024 * 1024 * 1024;

const maxBytes = () => Number(process.env.UPLOAD_MAX_BYTES ?? DEFAULT_MAX_BYTES);
const dayBytes = () => Number(process.env.UPLOAD_MAX_BYTES_PER_DAY ?? DEFAULT_DAY_BYTES);

let day = { started: Date.now(), written: 0 };

/// Counts only what actually reached the bucket: a re-upload of the same image is one object and
/// costs nothing, so it should not spend the budget either.
function spend(bytes: number): boolean {
  const now = Date.now();
  if (now - day.started > 24 * 60 * 60 * 1000) day = { started: now, written: 0 };
  if (day.written + bytes > dayBytes()) return false;
  day.written += bytes;
  return true;
}

/// The one sentence a caller gets when this deployment has no bucket. Storage being off is a
/// configuration state, not a fault: the wizard falls back to the artwork URL field.
const OFF =
  "uploads are off: this deployment has no object storage configured, so paste an artwork URL instead";

/// Which of the five R2 settings are required. Booleans only, so /health can say whether a deploy
/// is wired without ever echoing a key.
export const storageConfigured = () =>
  Boolean(
    process.env.R2_ENDPOINT &&
      process.env.R2_BUCKET &&
      process.env.R2_ACCESS_KEY_ID &&
      process.env.R2_SECRET_ACCESS_KEY &&
      process.env.R2_PUBLIC_BASE,
  );

/// Bad input from a caller, not a bug. Everything else falls through to Fastify's error handler.
class UploadError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

// ---------------------------------------------------------------- the type is in the bytes

const ascii = (b: Uint8Array, from: number, to: number) => Buffer.from(b.subarray(from, to)).toString("latin1");

/// The content-type header and the filename are both things a caller types, so neither decides
/// anything here. The first bytes are not, so they do. Anything we cannot name is refused rather
/// than stored as some default, because an unnamed object served back is somebody else's exploit.
function sniff(b: Uint8Array): { contentType: string; ext: string } | null {
  if (b.length >= 8 && ascii(b, 0, 8) === "\x89PNG\r\n\x1a\n") return { contentType: "image/png", ext: ".png" };
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return { contentType: "image/jpeg", ext: ".jpg" };
  if (b.length >= 12 && ascii(b, 0, 4) === "RIFF" && ascii(b, 8, 12) === "WEBP") return { contentType: "image/webp", ext: ".webp" };
  if (b.length >= 6 && (ascii(b, 0, 6) === "GIF87a" || ascii(b, 0, 6) === "GIF89a")) return { contentType: "image/gif", ext: ".gif" };
  return null;
}

// ---------------------------------------------------------------- the bucket

let s3: S3Client | null = null;

/// Built once, on the first upload rather than at boot, so an API with no bucket starts and serves
/// everything else exactly as it did before.
function client(): S3Client {
  if (!s3) {
    s3 = new S3Client({
      region: process.env.R2_REGION ?? "auto",
      endpoint: process.env.R2_ENDPOINT!,
      // R2 and MinIO both serve path style; virtual-hosted style is the SDK default and needs the
      // bucket to be a DNS label, which a bucket name with a dot in it is not.
      forcePathStyle: true,
      credentials: {
        accessKeyId: process.env.R2_ACCESS_KEY_ID!,
        secretAccessKey: process.env.R2_SECRET_ACCESS_KEY!,
      },
    });
  }
  return s3;
}

const publicUrl = (key: string) => `${process.env.R2_PUBLIC_BASE!.replace(/\/+$/, "")}/${key}`;

const isMissing = (e: unknown) => {
  const err = e as { name?: string; $metadata?: { httpStatusCode?: number } };
  return err?.name === "NotFound" || err?.name === "NoSuchKey" || err?.$metadata?.httpStatusCode === 404;
};

/// The key is the content hash, so the same image uploaded twice is one object and a re-upload is a
/// HeadObject and nothing else. That also means an object can never be replaced by different bytes
/// under the same key, which is why it is safe to cache it forever.
async function store(bytes: Buffer, kind: { contentType: string; ext: string }) {
  const key = `tokens/${createHash("sha256").update(bytes).digest("hex")}${kind.ext}`;
  const bucket = process.env.R2_BUCKET!;
  let deduped = true;
  try {
    await client().send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
  } catch (e) {
    if (!isMissing(e)) throw e;
    if (!spend(bytes.length)) {
      throw new UploadError(503, "uploads are paused for today: this deployment has written its daily limit to storage");
    }
    deduped = false;
    // R2 has no ACLs: what makes the object readable is the bucket's public base, not a header.
    await client().send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: bytes,
        ContentType: kind.contentType,
        CacheControl: "public, max-age=31536000, immutable",
      }),
    );
  }
  return { url: publicUrl(key), key, bytes: bytes.length, contentType: kind.contentType, deduped };
}

/// The same bucket, for a caller that already holds the bytes and is not an HTTP request: the demo
/// seeder. It sniffs like every other path, so nothing reaches the bucket under a type it cannot
/// prove, and it is content addressed like every other path, so seeding twice stores once.
export async function storeImage(bytes: Buffer) {
  if (!storageConfigured()) throw new Error(OFF);
  const kind = sniff(bytes);
  if (!kind) throw new Error("those bytes are not a PNG, JPEG, WebP or GIF");
  return store(bytes, kind);
}

// ---------------------------------------------------------------- the two ways bytes arrive

/// A browser's file picker. The cap is counted as the stream runs, so an oversized upload is cut
/// off at the limit instead of being held in memory first and measured afterwards.
async function fromMultipart(req: FastifyRequest, max: number): Promise<Buffer> {
  const part = await req.file({ limits: { fileSize: max, files: 1 } });
  if (!part) throw new UploadError(400, "no file in the request");
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    for await (const chunk of part.file) {
      total += chunk.length;
      if (total > max) throw new UploadError(413, tooBig(max));
      chunks.push(chunk as Buffer);
    }
  } catch (e) {
    if (e instanceof UploadError) throw e;
    if ((e as { code?: string }).code === "FST_REQ_FILE_TOO_LARGE") throw new UploadError(413, tooBig(max));
    throw e;
  }
  if (part.file.truncated) throw new UploadError(413, tooBig(max));
  if (!total) throw new UploadError(400, "that file is empty");
  return Buffer.concat(chunks);
}

/// The AI path, which already holds the bytes and would otherwise have to turn them back into a
/// file to hand them over. The route's bodyLimit refuses an oversized body before Fastify buffers
/// it, so the base64 envelope is capped on the wire and the decoded bytes are capped again here.
function fromJson(req: FastifyRequest, max: number): Buffer {
  const body = (req.body ?? {}) as { dataUri?: unknown };
  if (typeof body.dataUri !== "string" || !body.dataUri) {
    throw new UploadError(400, "send a file field, or a JSON body with a dataUri");
  }
  const match = /^data:[a-z0-9.+/-]*;base64,(.*)$/is.exec(body.dataUri);
  const base64 = match ? match[1]! : body.dataUri;
  const bytes = Buffer.from(base64, "base64");
  if (!bytes.length) throw new UploadError(400, "that dataUri decoded to nothing");
  if (bytes.length > max) throw new UploadError(413, tooBig(max));
  return bytes;
}

const tooBig = (max: number) => `that image is over the ${(max / (1024 * 1024)).toFixed(1)} MiB limit`;

// ---------------------------------------------------------------- the route

export async function registerUploads(app: FastifyInstance) {
  const max = maxBytes();
  // throwFileSizeLimit off on purpose: busboy then truncates the file stream and still drains the
  // request, so an oversized upload gets a clean 413 instead of a reset socket halfway through.
  await app.register(multipart, {
    throwFileSizeLimit: false,
    limits: { fileSize: max, files: 1, fields: 4 },
  });

  app.post(
    "/uploads/image",
    {
      // Tighter than the global limiter, the way the admin routes are, and nothing else: an upload
      // happens once per launch, and a creator has no token to present.
      config: { rateLimit: { max: 20, timeWindow: "1 minute" } },
      // base64 inflates by four thirds; the slack is the JSON envelope around it.
      bodyLimit: Math.ceil((max * 4) / 3) + 1024,
    },
    async (req: FastifyRequest, reply: FastifyReply) => {
      if (!storageConfigured()) return reply.code(501).send({ error: OFF });
      try {
        const bytes = req.isMultipart() ? await fromMultipart(req, max) : fromJson(req, max);
        const kind = sniff(bytes);
        if (!kind) return reply.code(415).send({ error: "that is not a PNG, JPEG, WebP or GIF" });
        return await store(bytes, kind);
      } catch (e) {
        if (e instanceof UploadError) return reply.code(e.status).send({ error: e.message });
        if ((e as { code?: string }).code === "FST_ERR_CTP_BODY_TOO_LARGE") {
          return reply.code(413).send({ error: tooBig(max) });
        }
        req.log.error({ err: e }, "upload failed");
        return reply.code(502).send({ error: "the bucket did not take that image" });
      }
    },
  );
}
