#!/usr/bin/env node
/**
 * Generate build/icon.png (512×512) from the Fermat logo colours.
 *
 * Requires only Node.js built-ins (zlib). Run once before packaging:
 *   node scripts/generate-icons.js
 *
 * electron-builder will derive .icns (macOS) and .ico (Windows) from
 * the PNG automatically on macOS (via sips + iconutil) and on Windows.
 */

'use strict';

const fs   = require('fs');
const path = require('path');
const zlib = require('zlib');

const SIZE = 512;

// ─── CRC32 (needed for PNG chunks) ─────────────────────────────────────────

function makeCrcTable() {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
}
const CRC_TABLE = makeCrcTable();

function crc32(buf) {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++)
    crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ buf[i]) & 0xff];
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len  = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const tb   = Buffer.from(type, 'ascii');
  const crcn = Buffer.alloc(4); crcn.writeUInt32BE(crc32(Buffer.concat([tb, data])));
  return Buffer.concat([len, tb, data, crcn]);
}

// ─── Pixel generator ────────────────────────────────────────────────────────
// Catppuccin: blue #89b4fa → lavender #b4befe → mauve #cba6f7 (diagonal gradient)
// Rounded-rect mask so it looks like the actual app icon.

function lerp(a, b, t) { return Math.round(a + (b - a) * t); }

const R = 80; // corner radius (in a 512-px square)

// Check if pixel (x,y) is inside a rounded rectangle centred at (SIZE/2, SIZE/2)
function insideRoundRect(x, y) {
  const margin = 20;
  const x0 = margin, y0 = margin, x1 = SIZE - margin, y1 = SIZE - margin;
  const r  = R;
  if (x < x0 || x > x1 || y < y0 || y > y1) return false;
  // corner checks
  if (x < x0 + r && y < y0 + r) return dist(x, y, x0+r, y0+r) <= r;
  if (x > x1 - r && y < y0 + r) return dist(x, y, x1-r, y0+r) <= r;
  if (x < x0 + r && y > y1 - r) return dist(x, y, x0+r, y1-r) <= r;
  if (x > x1 - r && y > y1 - r) return dist(x, y, x1-r, y1-r) <= r;
  return true;
}
function dist(x, y, cx, cy) {
  const dx = x - cx, dy = y - cy;
  return Math.sqrt(dx*dx + dy*dy);
}

// Build raw RGBA scanlines (with PNG filter byte 0 prepended)
const rows = [];
for (let y = 0; y < SIZE; y++) {
  const row = Buffer.alloc(1 + SIZE * 4); // filter + RGBA
  row[0] = 0; // no filter
  for (let x = 0; x < SIZE; x++) {
    const inside = insideRoundRect(x, y);
    let pr, pg, pb, pa;
    if (!inside) {
      pr = pg = pb = pa = 0; // transparent outside
    } else {
      const t = (x + y) / (2 * (SIZE - 1)); // diagonal 0→1

      let r, g, b;
      if (t < 0.55) {
        const s = t / 0.55;
        r = lerp(0x89, 0xb4, s);
        g = lerp(0xb4, 0xbe, s);
        b = lerp(0xfa, 0xfe, s);
      } else {
        const s = (t - 0.55) / 0.45;
        r = lerp(0xb4, 0xcb, s);
        g = lerp(0xbe, 0xa6, s);
        b = lerp(0xfe, 0xf7, s);
      }

      // Subtle highlight at top edge
      const topFade = Math.max(0, 1 - y / (SIZE * 0.25));
      r = Math.min(255, r + Math.round(30 * topFade));
      g = Math.min(255, g + Math.round(30 * topFade));
      b = Math.min(255, b + Math.round(30 * topFade));

      pr = r; pg = g; pb = b; pa = 255;
    }
    const base = 1 + x * 4;
    row[base]     = pr;
    row[base + 1] = pg;
    row[base + 2] = pb;
    row[base + 3] = pa;
  }
  rows.push(row);
}

const imageData  = Buffer.concat(rows);
const compressed = zlib.deflateSync(imageData, { level: 9 });

// ─── Assemble PNG ────────────────────────────────────────────────────────────

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(SIZE, 0); // width
ihdr.writeUInt32BE(SIZE, 4); // height
ihdr[8]  = 8; // bit depth
ihdr[9]  = 6; // colour type RGBA
ihdr[10] = 0; // compression
ihdr[11] = 0; // filter
ihdr[12] = 0; // interlace

const png = Buffer.concat([
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), // PNG signature
  chunk('IHDR', ihdr),
  chunk('IDAT', compressed),
  chunk('IEND', Buffer.alloc(0)),
]);

// ─── Write ───────────────────────────────────────────────────────────────────

const buildDir = path.join(__dirname, '..', 'build');
if (!fs.existsSync(buildDir)) fs.mkdirSync(buildDir, { recursive: true });

const outPath = path.join(buildDir, 'icon.png');
fs.writeFileSync(outPath, png);
console.log(`Generated ${outPath} (${SIZE}×${SIZE}, ${png.length} bytes)`);
