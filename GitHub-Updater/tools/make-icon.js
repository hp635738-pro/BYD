'use strict';

/**
 * ============================================================================
 *  tools/make-icon.js — regenerates assets/icon.ico (and assets/icon.png)
 * ============================================================================
 *  Zero-dependency icon generator: it rasterises the GitHub Updater glyph
 *  (a blue "pull" arrow landing on a green project bar) with 4x4
 *  supersampling and encodes real PNG + multi-size ICO files itself, so the
 *  icon is reproducible with just Node.
 *
 *      npm run icon
 *
 *  The ICO embeds 16/24/32/48/64/128/256 px entries (PNG-compressed), which is
 *  what electron-builder needs — it requires an .ico of at least 256x256.
 * ============================================================================
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const SIZES = [16, 24, 32, 48, 64, 128, 256];
const SAMPLES = 4; // 4x4 supersampling per pixel
const OUT_DIR = path.join(__dirname, '..', 'assets');

/* ----------------------------- colour helpers ---------------------------- */

function hex(value) {
  const n = parseInt(value.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function mix(a, b, t) {
  return [
    a[0] + (b[0] - a[0]) * t,
    a[1] + (b[1] - a[1]) * t,
    a[2] + (b[2] - a[2]) * t
  ];
}

const C = {
  rim: mix(hex('#1e293b'), hex('#3b82f6'), 0.45),
  bgTop: hex('#24344f'),
  bgBottom: hex('#0f172a'),
  arrowTop: hex('#7db4fb'),
  arrowBottom: hex('#2563eb'),
  barTop: hex('#4ade80'),
  barBottom: hex('#16a34a')
};

/* --------------------------- shape primitives ---------------------------- */

/** Signed distance to a rounded box centred at (cx, cy). */
function sdRoundBox(px, py, cx, cy, halfW, halfH, radius) {
  const qx = Math.abs(px - cx) - halfW + radius;
  const qy = Math.abs(py - cy) - halfH + radius;
  const ax = Math.max(qx, 0);
  const ay = Math.max(qy, 0);
  return Math.hypot(ax, ay) + Math.min(Math.max(qx, qy), 0) - radius;
}

/** Point-in-triangle (barycentric signs). */
function inTriangle(px, py, ax, ay, bx, by, cx, cy) {
  const d1 = (px - bx) * (ay - by) - (ax - bx) * (py - by);
  const d2 = (px - cx) * (by - cy) - (bx - cx) * (py - cy);
  const d3 = (px - ax) * (cy - ay) - (cx - ax) * (py - ay);
  const hasNeg = d1 < 0 || d2 < 0 || d3 < 0;
  const hasPos = d1 > 0 || d2 > 0 || d3 > 0;
  return !(hasNeg && hasPos);
}

/* ------------------------------ the artwork ------------------------------ */
/*  Coordinate space: x/y in [-1, 1], y grows downwards, (0,0) = centre.     */

const GY = -0.13; // vertical centring offset for the glyph

function drawPixel(x, y, size) {
  const detailed = size >= 48;

  // --- background: rim + inner panel -------------------------------------
  const rimHalf = 0.9;
  const rimRadius = 0.26;
  const innerHalf = detailed ? 0.865 : 0.9;
  const innerRadius = 0.235;

  if (sdRoundBox(x, y, 0, 0, rimHalf, rimHalf, rimRadius) > 0) return null;

  const t = (y + 1) / 2; // 0 at the top, 1 at the bottom
  const inner = sdRoundBox(x, y, 0, 0, innerHalf, innerHalf, innerRadius);
  let rgb = inner < 0 ? mix(C.bgTop, C.bgBottom, t) : C.rim;

  // --- glyph geometry -----------------------------------------------------
  const shaftHalf = detailed ? 0.105 : 0.135;
  const shaftTop = -0.5 + GY;
  const shaftBottom = 0.02 + GY;
  const headBaseY = -0.06 + GY;
  const headApexY = 0.33 + GY;
  const headHalf = detailed ? 0.33 : 0.38;
  const barHalf = 0.42;
  const barTop = 0.47 + GY;
  const barBottom = 0.62 + GY;

  const inShaft = Math.abs(x) <= shaftHalf && y >= shaftTop && y <= shaftBottom;
  const inHead = inTriangle(x, y, 0, headApexY, -headHalf, headBaseY, headHalf, headBaseY);
  const inBar = sdRoundBox(x, y, 0, (barTop + barBottom) / 2, barHalf, (barBottom - barTop) / 2, 0.07) <= 0;

  const glyphT = (y - (shaftTop)) / (headApexY - shaftTop);

  if (inShaft || inHead) {
    rgb = mix(C.arrowTop, C.arrowBottom, Math.min(Math.max(glyphT, 0), 1));
  } else if (inBar) {
    const barT = (x + barHalf) / (2 * barHalf);
    rgb = mix(C.barTop, C.barBottom, barT * 0.75 + 0.15);
  }

  return rgb;
}

/** Rasterise one size into an RGBA buffer (size*size*4). */
function rasterise(size) {
  const data = Buffer.alloc(size * size * 4);
  const step = 1 / size;
  const sub = 1 / SAMPLES;

  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let hits = 0;

      for (let sy = 0; sy < SAMPLES; sy++) {
        for (let sx = 0; sx < SAMPLES; sx++) {
          // Sample centre, mapped to [-1, 1].
          const x = (px + (sx + 0.5) * sub) * step * 2 - 1;
          const y = (py + (sy + 0.5) * sub) * step * 2 - 1;
          const rgb = drawPixel(x, y, size);
          if (rgb) {
            r += rgb[0];
            g += rgb[1];
            b += rgb[2];
            hits += 1;
          }
        }
      }

      const total = SAMPLES * SAMPLES;
      const idx = (py * size + px) * 4;
      const alpha = Math.round((hits / total) * 255);
      if (alpha > 0) {
        data[idx] = Math.round(r / hits);
        data[idx + 1] = Math.round(g / hits);
        data[idx + 2] = Math.round(b / hits);
      }
      data[idx + 3] = alpha;
    }
  }

  return data;
}

/* ------------------------------ PNG encoder ------------------------------ */

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 255] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

function encodePng(width, height, rgba) {
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // filter: none
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0))
  ]);
}

/* ------------------------------ ICO encoder ------------------------------ */

function encodeIco(pngsBySize) {
  const entries = [];
  let offset = 6 + 16 * pngsBySize.length;

  for (const { size, png } of pngsBySize) {
    const entry = Buffer.alloc(16);
    entry[0] = size >= 256 ? 0 : size; // 0 means 256
    entry[1] = size >= 256 ? 0 : size;
    entry[2] = 0;
    entry[3] = 0;
    entry.writeUInt16LE(1, 4); // planes
    entry.writeUInt16LE(32, 6); // bit count
    entry.writeUInt32LE(png.length, 8);
    entry.writeUInt32LE(offset, 12);
    offset += png.length;
    entries.push(entry);
  }

  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(pngsBySize.length, 4);

  return Buffer.concat([header, ...entries, ...pngsBySize.map((e) => e.png)]);
}

/* --------------------------------- main ---------------------------------- */

function build() {
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const pngsBySize = SIZES.map((size) => ({ size, png: encodePng(size, size, rasterise(size)) }));

  const icoPath = path.join(OUT_DIR, 'icon.ico');
  const pngPath = path.join(OUT_DIR, 'icon.png');
  fs.writeFileSync(icoPath, encodeIco(pngsBySize));
  fs.writeFileSync(pngPath, pngsBySize[pngsBySize.length - 1].png);

  const icoSize = fs.statSync(icoPath).size;
  console.log(`Wrote ${path.relative(process.cwd(), icoPath)} (${icoSize} bytes, ${SIZES.join('/')} px)`);
  console.log(`Wrote ${path.relative(process.cwd(), pngPath)}`);
}

if (require.main === module) build();

module.exports = { build, encodeIco, encodePng, rasterise, SIZES, OUT_DIR };
