#!/usr/bin/env node
// Draws the app's icon from one list of shapes, as an SVG and as PNGs: a request path of four hops on a dark tile,
// the third one amber (where it fails), the fourth a hollow ring (never reached).
//
//   node tools/icons.mjs
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { deflateSync } from 'node:zlib';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));

// On a 512 grid. The hops sit inside the 80% circle a maskable icon keeps, so one drawing serves both kinds.
const TILE = '#1c2127';
const SHAPES = [
  { kind: 'bar', x0: 112, x1: 304, y: 256, h: 8, fill: '#e3e6e9' },
  { kind: 'bar', x0: 304, x1: 372, y: 256, h: 8, fill: '#58626d' },
  { kind: 'circle', cx: 112, cy: 256, r: 30, fill: '#e3e6e9' },
  { kind: 'circle', cx: 208, cy: 256, r: 30, fill: '#e3e6e9' },
  { kind: 'circle', cx: 304, cy: 256, r: 46, fill: '#eda54f' },
  { kind: 'ring', cx: 400, cy: 256, r0: 19, r1: 31, fill: '#98a1ab' },
];
export const ICONS = { 'icon-192.png': [192, false], 'icon-512.png': [512, false], 'maskable-512.png': [512, true] };

const rgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
const inTile = (x, y, full) => {
  if (full) return true; // a maskable icon is cropped by the system: it fills the square
  const r = 112;
  const dx = Math.max(r - x, 0, x - (512 - r));
  const dy = Math.max(r - y, 0, y - (512 - r));
  return dx * dx + dy * dy <= r * r;
};
function colourAt(x, y, full) {
  if (!inTile(x, y, full)) return null;
  let c = TILE;
  for (const s of SHAPES) {
    const d2 = s.kind === 'bar' ? null : (x - s.cx) ** 2 + (y - s.cy) ** 2;
    if (s.kind === 'bar' ? x >= s.x0 && x <= s.x1 && Math.abs(y - s.y) <= s.h : s.kind === 'circle' ? d2 <= s.r * s.r : d2 >= s.r0 * s.r0 && d2 <= s.r1 * s.r1) c = s.fill;
  }
  return rgb(c);
}

// RGBA rows, each led by PNG's filter byte 0, sampled 4x4 per pixel for smooth edges.
export function pixels(size, full) {
  const N = 4;
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let r = 0, g = 0, b = 0, n = 0;
      for (let sy = 0; sy < N; sy++) {
        for (let sx = 0; sx < N; sx++) {
          const c = colourAt(((px + (sx + 0.5) / N) * 512) / size, ((py + (sy + 0.5) / N) * 512) / size, full);
          if (c) { r += c[0]; g += c[1]; b += c[2]; n++; }
        }
      }
      const o = py * (size * 4 + 1) + 1 + px * 4;
      if (n) raw.set([Math.round(r / n), Math.round(g / n), Math.round(b / n), Math.round((255 * n) / (N * N))], o);
    }
  }
  return raw;
}

const CRC = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
function chunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'latin1');
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}
export function png(size, full) {
  const head = Buffer.alloc(13);
  head.writeUInt32BE(size, 0);
  head.writeUInt32BE(size, 4);
  head.set([8, 6, 0, 0, 0], 8); // 8 bits, RGBA, deflate, no filter choice, no interlace
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', head), chunk('IDAT', deflateSync(pixels(size, full), { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

export function svg() {
  const body = SHAPES.map((s) => (s.kind === 'bar'
    ? `<rect x="${s.x0}" y="${s.y - s.h}" width="${s.x1 - s.x0}" height="${2 * s.h}" fill="${s.fill}"/>`
    : s.kind === 'circle'
      ? `<circle cx="${s.cx}" cy="${s.cy}" r="${s.r}" fill="${s.fill}"/>`
      : `<circle cx="${s.cx}" cy="${s.cy}" r="${(s.r0 + s.r1) / 2}" fill="none" stroke="${s.fill}" stroke-width="${s.r1 - s.r0}"/>`)).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><rect width="512" height="512" rx="112" fill="${TILE}"/>${body}</svg>\n`;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  mkdirSync(join(root, 'icons'), { recursive: true });
  writeFileSync(join(root, 'icons/icon.svg'), svg());
  for (const [name, [size, full]] of Object.entries(ICONS)) writeFileSync(join(root, 'icons', name), png(size, full));
  console.log(`Wrote icons/icon.svg and ${Object.keys(ICONS).join(', ')}.`);
}
