"use client";

import { useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { API } from "@/lib/config";
import { imageUrl } from "@/lib/format";
import { Artwork } from "@/components/Artwork";

/// The artwork step for both wizards. Three ways in, one thing out: a URL. A file goes to the
/// API's bucket, the AI draws and the bytes go to the same place, and a URL somebody already has
/// is typed straight in. What it deliberately refuses to produce is a data URI, because the launch
/// writes that string into calldata and into its own event, where 40 KB of base64 is tens of
/// millions of gas paid twice.

/// Small enough to be a placeholder somebody meant, big enough that nothing real fits.
const MAX_INLINE = 8 * 1024;

/// The same sentence wherever a data URI is refused, because it is always the same problem.
const TOO_EXPENSIVE =
  "that image is a data URI over 8 KB: stored on chain it would cost a fortune in gas. Upload a file or paste a URL instead.";

/// The server has the real say (UPLOAD_MAX_BYTES); this is here so a phone camera photo is turned
/// away before it is sent rather than after.
const MAX_UPLOAD = 4 * 1024 * 1024;

interface Uploaded { url: string; key: string; bytes: number; contentType: string; deduped: boolean }

class UploadError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

/// XHR rather than fetch, for the one thing fetch cannot do: say how far along the upload is.
function putFile(file: File, onProgress: (pct: number) => void): Promise<Uploaded> {
  return new Promise((resolve, reject) => {
    const body = new FormData();
    body.append("file", file);
    const xhr = new XMLHttpRequest();
    xhr.open("POST", `${API}/uploads/image`);
    xhr.upload.onprogress = (e) => { if (e.lengthComputable) onProgress(Math.round((e.loaded / e.total) * 100)); };
    xhr.onerror = () => reject(new UploadError(0, "the upload did not reach the server"));
    xhr.onload = () => {
      let json: (Uploaded & { error?: string }) | null = null;
      try { json = JSON.parse(xhr.responseText) as Uploaded & { error?: string }; } catch { /* not json */ }
      if (xhr.status >= 200 && xhr.status < 300 && json?.url) resolve(json);
      else reject(new UploadError(xhr.status, json?.error ?? `upload failed: ${xhr.status}`));
    };
    xhr.send(body);
  });
}

/// The AI path hands over bytes it already holds, so it sends them as JSON rather than rebuilding
/// a file around them.
async function putDataUri(dataUri: string): Promise<Uploaded> {
  const res = await fetch(`${API}/uploads/image`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ dataUri }),
  });
  const json = (await res.json().catch(() => null)) as (Uploaded & { error?: string }) | null;
  if (!res.ok || !json?.url) throw new UploadError(res.status, json?.error ?? `upload failed: ${res.status}`);
  return json;
}

export function ArtworkPicker({ value, onChange, symbol, ai, promptHint }: {
  value: string;
  onChange: (v: string) => void;
  symbol: string;
  /// The curve wizard draws; the direct one does not, and neither grows a button it never had.
  ai?: boolean;
  promptHint?: string;
}) {
  // What this deployment can actually do. Asked up front, because a button that cannot work is
  // worse than no button: the old version offered an upload, took the click, and then printed the
  // reason in red underneath as though something had gone wrong.
  const { data: health } = useQuery({
    queryKey: ["health"],
    queryFn: () => api<{ integrations: { storage: boolean; art: boolean } }>("/health"),
    staleTime: 60_000,
  });
  const canUpload = health?.integrations.storage ?? false;
  const canDraw = Boolean(ai) && (health?.integrations.art ?? false);
  const known = health !== undefined;

  const fileInput = useRef<HTMLInputElement>(null);
  const [prompt, setPrompt] = useState("");
  const [busy, setBusy] = useState<"" | "uploading" | "drawing">("");
  const [pct, setPct] = useState(0);
  const [note, setNote] = useState<{ kind: "error" | "warn" | "done"; text: string } | null>(null);
  const [over, setOver] = useState(false);

  async function take(file: File) {
    if (file.size > MAX_UPLOAD) {
      return setNote({ kind: "error", text: `that file is ${(file.size / 1024 / 1024).toFixed(1)} MB, and the limit is 4 MB` });
    }
    setNote(null);
    setBusy("uploading");
    setPct(0);
    try {
      const up = await putFile(file, setPct);
      onChange(up.url);
      setNote({ kind: "done", text: up.deduped ? "stored already, reused" : `stored, ${(up.bytes / 1024).toFixed(0)} KB` });
    } catch (e) {
      // Including the 501: a file has no fallback worth taking, and the API's own sentence already
      // says the URL field still works.
      setNote({ kind: "error", text: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy("");
    }
  }

  async function generate() {
    setNote(null);
    setBusy("drawing");
    try {
      const res = await fetch("/api/image", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ prompt: prompt || promptHint || "token logo" }),
      });
      const json = (await res.json()) as { dataUri?: string; error?: string };
      if (!res.ok || !json.dataUri) throw new Error(json.error ?? "generation failed");

      setBusy("uploading");
      setPct(0);
      try {
        const up = await putDataUri(json.dataUri);
        onChange(up.url);
        setNote({ kind: "done", text: up.deduped ? "stored already, reused" : `stored, ${(up.bytes / 1024).toFixed(0)} KB` });
      } catch (e) {
        // Storage off: the drawing is still good, so it can go on chain as data, but only if it is
        // small enough that the gas is a rounding error rather than the whole launch.
        if (e instanceof UploadError && e.status === 501) {
          if (json.dataUri.length > MAX_INLINE) throw new Error(TOO_EXPENSIVE);
          onChange(json.dataUri);
          setNote({ kind: "warn", text: "uploads are off here, so this image goes on chain as data and costs extra gas." });
        } else throw e;
      }
    } catch (e) {
      setNote({ kind: "error", text: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy("");
    }
  }

  /// The manual path is a URL field, not an anything field: a pasted data URI is the same expensive
  /// mistake whether a model drew it or a person copied it out of a browser.
  function typed(v: string) {
    if (v.startsWith("data:") && v.length > MAX_INLINE) return setNote({ kind: "error", text: TOO_EXPENSIVE });
    setNote(null);
    onChange(v);
  }

  const status =
    busy === "uploading" ? `uploading ${pct}%`
    : busy === "drawing" ? "drawing"
    : null;

  return (
    <div
      onDragOver={(e) => { if (!canUpload) return; e.preventDefault(); setOver(true); }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        if (!canUpload) return;
        e.preventDefault();
        setOver(false);
        const file = e.dataTransfer.files[0];
        if (file) void take(file);
      }}
      className={`art-picker${canUpload ? " droppable" : ""}${over ? " over" : ""}`}
    >
      <div className="art-preview">
        <Artwork src={imageUrl(value)} symbol={symbol || "?"} size={104} rounded="rounded-none" />
      </div>

      <div className="art-controls">
        {canUpload && (
          <div className="art-drop">
            <button type="button" className="btn btn-ghost" disabled={Boolean(busy)} onClick={() => fileInput.current?.click()}>
              Choose a file
            </button>
            <span>or drop one here. PNG, JPEG, WebP or GIF, up to 4 MB.</span>
            <input ref={fileInput} type="file" accept="image/png,image/jpeg,image/webp,image/gif" className="hidden"
              onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; if (f) void take(f); }} />
          </div>
        )}

        {canDraw && (
          <div className="art-generate">
            <input className="input" placeholder={promptHint ? `Describe it, or leave it: ${promptHint}` : "Describe it"}
              value={prompt} onChange={(e) => setPrompt(e.target.value)} />
            <button type="button" className="btn btn-ghost" disabled={Boolean(busy)} onClick={generate}>
              {busy === "drawing" ? "Drawing" : "Draw one"}
            </button>
          </div>
        )}

        <label className="field">
          <span className="field-label">{canUpload ? "Or paste a link" : "Link to the picture"}</span>
          <input className="input" placeholder="https://" value={value} onChange={(e) => typed(e.target.value)} />
          <span className="field-note">
            {!known ? "Checking what this deployment can store."
              : canUpload ? "Only the link is written on chain, so keep the picture somewhere that stays up."
              : "This deployment stores no files, so the picture lives wherever you host it. Only the link is written on chain."}
          </span>
        </label>

        {status && <p className="art-note mono">{status}</p>}
        {!status && note && (
          <p className={note.kind === "error" ? "art-note bad" : note.kind === "warn" ? "art-note warn" : "art-note good"}>
            {note.text}
          </p>
        )}
      </div>
    </div>
  );
}
