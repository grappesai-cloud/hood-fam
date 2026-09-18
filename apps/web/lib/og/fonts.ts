import extraBold from "./Inter-ExtraBold.ttf";
import regular from "./Inter-Regular.ttf";

/// The two weights the share card is drawn in.
///
/// `next/og` rasterises with satori, which needs the font bytes: it cannot reach the browser's
/// Arial, and it synthesises nothing, so a card asking for weight 800 with only a regular face
/// loaded comes out at regular. Both faces are in the repo and baked into the bundle by the `.ttf`
/// rule in `next.config.mjs`, because an unfurl is a crawler waiting on one request: a font that
/// is a network hop or a resolved path away is one more thing that can take the card down with
/// it. Inter, subset to Latin: near enough to the Arial the site renders in, small enough to sit
/// in a git tree.
export interface ShareFont {
  name: string;
  data: Buffer;
  weight: 400 | 800;
  style: "normal";
}

let decoded: ShareFont[] | undefined;

export function shareFonts(): ShareFont[] {
  decoded ??= [
    { name: "Inter", data: Buffer.from(regular, "base64"), weight: 400, style: "normal" },
    { name: "Inter", data: Buffer.from(extraBold, "base64"), weight: 800, style: "normal" },
  ];
  return decoded;
}

/// The fonts, or nothing at all. `next/og` falls back to a bundled face of its own when it is
/// handed no font list, which is a duller card but still a card, and a card beats a 500.
export function shareFontsOrNone(): ShareFont[] | undefined {
  try {
    return shareFonts();
  } catch {
    return undefined;
  }
}
