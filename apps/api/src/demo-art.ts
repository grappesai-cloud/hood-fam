import { createHash } from "node:crypto";
import { deflateSync } from "node:zlib";

/// Artwork for the demo world, drawn here rather than fetched.
///
/// A board full of empty frames says nothing about how the product looks, and the art models cost
/// money and a key. These are deterministic identicons: the same symbol always draws the same
/// picture, so re-seeding a demo does not churn the bucket, and the bytes are a real PNG that goes
/// through the same upload path, the same sniffing and the same content-addressed key as a
/// creator's own file.
///
/// The encoder is the smallest PNG that is still a PNG: one IHDR, one IDAT of raw 8 bit RGB
/// scanlines with the no-op filter, one IEND. No dependency draws 256 squares better than this.

const SIZE = 256;
const GRID = 8;
const CELL = SIZE / GRID;

// The house palette, plus the accents a token is allowed to be.
const INK: RGB = [11, 13, 14];
const LIME: RGB = [215, 252, 117];
const ACCENTS: RGB[] = [
  [120, 190, 255], [255, 138, 128], [186, 140, 255], [255, 197, 97],
  [96, 226, 182], [255, 128, 191], [140, 160, 255], [244, 244, 240],
];

type RGB = [number, number, number];

const crcTable = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(bytes: Buffer): number {
  let c = 0xffffffff;
  for (const b of bytes) c = crcTable[(c ^ b) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, body: Buffer): Buffer {
  const head = Buffer.alloc(4);
  head.writeUInt32BE(body.length, 0);
  const typed = Buffer.concat([Buffer.from(type, "latin1"), body]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typed), 0);
  return Buffer.concat([head, typed, crc]);
}

/// `pixels` is SIZE * SIZE * 3 bytes, row major.
function encodePng(pixels: Buffer): Buffer {
  const stride = SIZE * 3;
  const raw = Buffer.alloc((stride + 1) * SIZE);
  for (let y = 0; y < SIZE; y++) {
    raw[y * (stride + 1)] = 0; // filter: none
    pixels.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(SIZE, 0);
  ihdr.writeUInt32BE(SIZE, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 2;  // colour type: truecolour
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/// Every token gets the same treatment: a dark field, a symmetric block pattern in one accent, one
/// lime cell so the picture belongs to this site, and a hairline frame so it reads as a tile rather
/// than as a hole in the page.
export function tokenArt(symbol: string): Buffer {
  const hash = createHash("sha256").update(`hood.fam demo art:${symbol.toUpperCase()}`).digest();
  const accent = ACCENTS[hash[0]! % ACCENTS.length]!;
  const pixels = Buffer.alloc(SIZE * SIZE * 3);

  const put = (x: number, y: number, c: RGB) => {
    const i = (y * SIZE + x) * 3;
    pixels[i] = c[0]; pixels[i + 1] = c[1]; pixels[i + 2] = c[2];
  };

  // The field: the house black, lifted very slightly towards the accent down the picture.
  for (let y = 0; y < SIZE; y++) {
    const t = y / SIZE;
    const bg: RGB = [
      Math.round(INK[0] + (accent[0] - INK[0]) * 0.07 * t),
      Math.round(INK[1] + (accent[1] - INK[1]) * 0.07 * t),
      Math.round(INK[2] + (accent[2] - INK[2]) * 0.07 * t),
    ];
    for (let x = 0; x < SIZE; x++) put(x, y, bg);
  }

  // The pattern: half the grid decided by the hash, mirrored, so it always has an axis and never
  // looks like noise. One cell in the house colour, chosen by the same hash.
  const limeCell = hash[1]! % (GRID * (GRID / 2));
  let cell = 0;
  for (let gy = 0; gy < GRID; gy++) {
    for (let gx = 0; gx < GRID / 2; gx++, cell++) {
      const on = (hash[2 + (cell % 28)]! >> (cell % 7)) & 1;
      if (!on) continue;
      const colour = cell === limeCell ? LIME : accent;
      const inset = cell % 5 === 0 ? 6 : 2; // a few cells breathe, so the block is not a wall
      for (let y = gy * CELL + inset; y < (gy + 1) * CELL - inset; y++) {
        for (let x = gx * CELL + inset; x < (gx + 1) * CELL - inset; x++) {
          put(x, y, colour);
          put(SIZE - 1 - x, y, colour);
        }
      }
    }
  }

  // The frame, one pixel of the accent at a tenth strength.
  const edge: RGB = [
    Math.round(INK[0] + (accent[0] - INK[0]) * 0.35),
    Math.round(INK[1] + (accent[1] - INK[1]) * 0.35),
    Math.round(INK[2] + (accent[2] - INK[2]) * 0.35),
  ];
  for (let i = 0; i < SIZE; i++) {
    put(i, 0, edge); put(i, SIZE - 1, edge); put(0, i, edge); put(SIZE - 1, i, edge);
  }

  return encodePng(pixels);
}
