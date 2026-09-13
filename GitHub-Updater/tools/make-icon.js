'use strict';

/**
 * ============================================================================
 *  tools/make-icon.js — regenerates assets/icon.png (Linux app icon)
 * ============================================================================
 *  Ubuntu/AppImage builds use a PNG icon: `build.linux.icon` points at
 *  assets/icon.png and electron-builder derives every hicolor size it needs
 *  (16…512 px) from it, for both the AppImage and the .deb. The old
 *  multi-size Windows .ico is gone — nothing in the project consumes it.
 *
 *  Two sources, in order of preference:
 *
 *   1. Brand logo   — if assets/logo.png exists AND ImageMagick (`convert`) is
 *      on the PATH, the BYD wordmark is re-tinted to silver and placed on the
 *      dark rounded card, then written as a 512x512 PNG.
 *
 *   2. Built-in glyph — a zero-dependency rasteriser (blue pull-arrow onto a
 *      green bar) used only when no logo is present, so the icon can always be
 *      regenerated with just Node.
 *
 *  If assets/logo.png exists but ImageMagick is NOT installed, the existing
 *  committed icon.png is left untouched (a warning is printed) so a bare
 *  `npm run icon` can never destroy the brand icon.
 *
 *      npm run icon
 * ============================================================================
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { execFileSync, spawnSync } = require('child_process');

/** electron-builder needs >= 256x256; 512 keeps HiDPI Ubuntu desktops crisp. */
const MASTER_SIZE = 512;
const SAMPLES = 4; // 4x4 supersampling per pixel (glyph fallback only)
const OUT_DIR = path.join(__dirname, '..', 'assets');
const LOGO_PATH = path.join(OUT_DIR, 'logo.png');
const ICON_PATH = path.join(OUT_DIR, 'icon.png');

/* ----------------------------- colour helpers ---------------------------- */

function hex(value) {
  const n = parseInt(value.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function mix(a, b, t) {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
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

/* ==============================  PNG encoder  ============================== */

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
  ihdr[8] = 8;
  ihdr[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0))
  ]);
}

/** Read width/height out of a PNG's IHDR chunk. */
function pngSize(file) {
  const head = Buffer.alloc(24);
  const fd = fs.openSync(file, 'r');
  try {
    fs.readSync(fd, head, 0, 24, 0);
  } finally {
    fs.closeSync(fd);
  }
  return { width: head.readUInt32BE(16), height: head.readUInt32BE(20) };
}

/* ========================  Source 1: brand logo  ========================== */

function hasConvert() {
  try {
    const r = spawnSync('convert', ['-version'], { encoding: 'utf8' });
    return r.status === 0;
  } catch {
    return false;
  }
}

function runConvert(args) {
  execFileSync('convert', args, { stdio: ['ignore', 'pipe', 'pipe'] });
}

/** Build the master PNG from assets/logo.png using ImageMagick. */
function buildMasterFromLogo(logoPath, masterPath, tmp, size = MASTER_SIZE) {
  const s = (n) => String(Math.round((n * size) / 256));
  const mask = path.join(tmp, 'mask.png');
  const fill = path.join(tmp, 'fill.png');
  const logoLight = path.join(tmp, 'logo_light.png');
  const rim = path.join(tmp, 'rim.png');
  const grad = path.join(tmp, 'grad.png');
  const cardMask = path.join(tmp, 'cardmask.png');
  const card = path.join(tmp, 'card.png');
  const cardRimmed = path.join(tmp, 'card_rimmed.png');
  const logoS = path.join(tmp, 'logo_s.png');

  // Re-tint the (dark) wordmark to a light silver gradient using its alpha.
  runConvert([logoPath, '-alpha', 'extract', mask]);
  runConvert(['-size', `${size}x${size}`, 'gradient:#f8fafc-#8ea3bd', fill]);
  runConvert([fill, mask, '-compose', 'copyopacity', '-composite', logoLight]);

  // Dark rounded card with a blue rim.
  runConvert([
    '-size', `${size}x${size}`, 'xc:none', '-fill', '#3b6ea5',
    '-draw', `roundrectangle ${s(2)},${s(2)} ${size - s(3)},${size - s(3)} ${s(58)},${s(58)}`, rim
  ]);
  runConvert(['-size', `${size}x${size}`, 'gradient:#24344f-#0d1526', grad]);
  runConvert([
    '-size', `${size}x${size}`, 'xc:none', '-fill', 'white',
    '-draw', `roundrectangle ${s(7)},${s(7)} ${size - s(8)},${size - s(8)} ${s(52)},${s(52)}`, cardMask
  ]);
  runConvert([grad, cardMask, '-compose', 'copyopacity', '-composite', card]);
  runConvert([rim, card, '-compose', 'over', '-composite', cardRimmed]);

  runConvert([logoLight, '-resize', `${s(186)}x`, logoS]);
  runConvert([cardRimmed, logoS, '-gravity', 'center', '-compose', 'over', '-composite', masterPath]);
}

function buildFromLogo(size = MASTER_SIZE) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'byd-icon-'));
  const masterPath = path.join(tmp, 'master.png');
  buildMasterFromLogo(LOGO_PATH, masterPath, tmp, size);

  fs.copyFileSync(masterPath, ICON_PATH);
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`Wrote assets/icon.png from logo.png (${size}x${size} PNG)`);
}

/* ===================  Source 2: built-in glyph (fallback)  ================ */

function sdRoundBox(px, py, cx, cy, halfW, halfH, radius) {
  const qx = Math.abs(px - cx) - halfW + radius;
  const qy = Math.abs(py - cy) - halfH + radius;
  const ax = Math.max(qx, 0);
  const ay = Math.max(qy, 0);
  return Math.hypot(ax, ay) + Math.min(Math.max(qx, qy), 0) - radius;
}

function inTriangle(px, py, ax, ay, bx, by, cx, cy) {
  const d1 = (px - bx) * (ay - by) - (ax - bx) * (py - by);
  const d2 = (px - cx) * (by - cy) - (bx - cx) * (py - cy);
  const d3 = (px - ax) * (cy - ay) - (cx - ax) * (py - ay);
  const hasNeg = d1 < 0 || d2 < 0 || d3 < 0;
  const hasPos = d1 > 0 || d2 > 0 || d3 > 0;
  return !(hasNeg && hasPos);
}

const GY = -0.13;

function drawPixel(x, y, size) {
  const detailed = size >= 48;
  const rimHalf = 0.9;
  const rimRadius = 0.26;
  const innerHalf = detailed ? 0.865 : 0.9;
  const innerRadius = 0.235;

  if (sdRoundBox(x, y, 0, 0, rimHalf, rimHalf, rimRadius) > 0) return null;

  const t = (y + 1) / 2;
  const inner = sdRoundBox(x, y, 0, 0, innerHalf, innerHalf, innerRadius);
  let rgb = inner < 0 ? mix(C.bgTop, C.bgBottom, t) : C.rim;

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

  const glyphT = (y - shaftTop) / (headApexY - shaftTop);

  if (inShaft || inHead) rgb = mix(C.arrowTop, C.arrowBottom, Math.min(Math.max(glyphT, 0), 1));
  else if (inBar) {
    const barT = (x + barHalf) / (2 * barHalf);
    rgb = mix(C.barTop, C.barBottom, barT * 0.75 + 0.15);
  }

  return rgb;
}

function rasterise(size) {
  const data = Buffer.alloc(size * size * 4);
  const step = 1 / size;
  const sub = 1 / SAMPLES;
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let r = 0, g = 0, b = 0, hits = 0;
      for (let sy = 0; sy < SAMPLES; sy++) {
        for (let sx = 0; sx < SAMPLES; sx++) {
          const x = (px + (sx + 0.5) * sub) * step * 2 - 1;
          const y = (py + (sy + 0.5) * sub) * step * 2 - 1;
          const rgb = drawPixel(x, y, size);
          if (rgb) { r += rgb[0]; g += rgb[1]; b += rgb[2]; hits += 1; }
        }
      }
      const idx = (py * size + px) * 4;
      const alpha = Math.round((hits / (SAMPLES * SAMPLES)) * 255);
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

function buildGlyph(size = MASTER_SIZE) {
  fs.writeFileSync(ICON_PATH, encodePng(size, size, rasterise(size)));
  console.log(`Wrote assets/icon.png from the built-in glyph (${size}x${size} PNG)`);
}

/* --------------------------------- main ---------------------------------- */

function build() {
  fs.mkdirSync(OUT_DIR, { recursive: true });

  if (fs.existsSync(LOGO_PATH)) {
    if (hasConvert()) {
      buildFromLogo();
    } else {
      console.warn('assets/logo.png found but ImageMagick "convert" is not on PATH.');
      console.warn('Leaving the committed icon.png untouched. Install it with: sudo apt install imagemagick');
    }
    return;
  }

  buildGlyph();
}

if (require.main === module) build();

module.exports = { build, buildFromLogo, buildGlyph, encodePng, rasterise, pngSize, MASTER_SIZE, OUT_DIR, LOGO_PATH, ICON_PATH };
