// Genera los íconos PNG y SVG de la PWA sin dependencias (zlib de Node).
// Uso: npm run icons -w app
import { writeFileSync, mkdirSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const out = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'public', 'icons');
mkdirSync(out, { recursive: true });

const BG = [200, 16, 46];
const WHITE = [245, 246, 248];
const DARK = [17, 20, 24];

// Geometría en coordenadas 0..1 (mismo diseño en SVG y PNG).
const POLE = { x0: 0.27, x1: 0.305, y0: 0.24, y1: 0.78 };
const FLAG = { x0: 0.305, x1: 0.74, y0: 0.26, y1: 0.56, cols: 6, rows: 4 };

function colorAt(x, y, rounded) {
  if (rounded) {
    const r = 0.2;
    const cx = Math.min(Math.max(x, r), 1 - r);
    const cy = Math.min(Math.max(y, r), 1 - r);
    if ((x - cx) ** 2 + (y - cy) ** 2 > r * r) return null;
  }
  if (x >= POLE.x0 && x < POLE.x1 && y >= POLE.y0 && y < POLE.y1) return WHITE;
  if (x >= FLAG.x0 && x < FLAG.x1 && y >= FLAG.y0 && y < FLAG.y1) {
    const i = Math.floor(((x - FLAG.x0) / (FLAG.x1 - FLAG.x0)) * FLAG.cols);
    const j = Math.floor(((y - FLAG.y0) / (FLAG.y1 - FLAG.y0)) * FLAG.rows);
    return (i + j) % 2 === 0 ? WHITE : DARK;
  }
  return BG;
}

function crc32(buf) {
  let c;
  let crc = 0xffffffff;
  for (const b of buf) {
    c = (crc ^ b) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

function png(size, { rounded = false, scale = 1 } = {}) {
  const SS = 4; // supermuestreo para suavizar bordes
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let py = 0; py < size; py++) {
    raw[py * (size * 4 + 1)] = 0;
    for (let px = 0; px < size; px++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          let x = (px + (sx + 0.5) / SS) / size;
          let y = (py + (sy + 0.5) / SS) / size;
          // scale < 1 achica el dibujo hacia el centro (zona segura de íconos "maskable").
          const fx = 0.5 + (x - 0.5) / scale;
          const fy = 0.5 + (y - 0.5) / scale;
          const inner = colorAt(fx, fy, false);
          const c = rounded ? colorAt(x, y, true) && inner : inner;
          if (!c) continue;
          r += c[0]; g += c[1]; b += c[2]; a += 255;
        }
      }
      const n = SS * SS;
      const o = py * (size * 4 + 1) + 1 + px * 4;
      const cov = a / n;
      raw[o] = cov ? Math.round((r / n) * (255 / cov)) : 0;
      raw[o + 1] = cov ? Math.round((g / n) * (255 / cov)) : 0;
      raw[o + 2] = cov ? Math.round((b / n) * (255 / cov)) : 0;
      raw[o + 3] = Math.round(cov);
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bits
  ihdr[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function svg() {
  const hex = (c) => '#' + c.map((v) => v.toString(16).padStart(2, '0')).join('');
  const s = 512;
  const cells = [];
  const cw = ((FLAG.x1 - FLAG.x0) / FLAG.cols) * s;
  const ch = ((FLAG.y1 - FLAG.y0) / FLAG.rows) * s;
  for (let j = 0; j < FLAG.rows; j++) {
    for (let i = 0; i < FLAG.cols; i++) {
      const fill = (i + j) % 2 === 0 ? WHITE : DARK;
      cells.push(
        `<rect x="${(FLAG.x0 * s + i * cw).toFixed(2)}" y="${(FLAG.y0 * s + j * ch).toFixed(2)}" width="${cw.toFixed(2)}" height="${ch.toFixed(2)}" fill="${hex(fill)}"/>`,
      );
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${s} ${s}">
<rect width="${s}" height="${s}" rx="${0.2 * s}" fill="${hex(BG)}"/>
<rect x="${POLE.x0 * s}" y="${POLE.y0 * s}" width="${((POLE.x1 - POLE.x0) * s).toFixed(2)}" height="${((POLE.y1 - POLE.y0) * s).toFixed(2)}" fill="${hex(WHITE)}"/>
${cells.join('\n')}
</svg>
`;
}

writeFileSync(path.join(out, 'icon-192.png'), png(192, { rounded: true }));
writeFileSync(path.join(out, 'icon-512.png'), png(512, { rounded: true }));
writeFileSync(path.join(out, 'icon-maskable-512.png'), png(512, { scale: 0.8 }));
writeFileSync(path.join(out, 'apple-touch-icon.png'), png(180));
writeFileSync(path.join(out, 'icon.svg'), svg());
console.log('Íconos generados en', out);
