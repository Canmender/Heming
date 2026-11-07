#!/usr/bin/env node
/**
 * 生成桌宠托盘图标（32×32 PNG，透明底、细线圆环）。
 *
 * 为什么用代码生成而不是塞一个二进制文件进仓库：
 * - 项目视觉规范是「细线 SVG 1.5px、无 emoji」，图标需要按这条规范画；
 * - 二进制文件在 diff 里看不见，改一次就说不清"为什么长这样"；
 * - 32×32 的托盘图标用代码画只有几十行，重生成成本远低于维护一个来源不明的 png。
 *
 * 用法：node scripts/make-widget-tray-icon.mjs
 * 产物：packages/desktop/assets/widget-tray.png
 */
import { deflateSync } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SIZE = 32;
/** 圆环半径与线宽：按 32px 画布调，线宽 2 在 100% 缩放下最接近「细线」观感。 */
const RADIUS = 11;
const STROKE = 2.4;
/** 圆环内的小圆点（"瞳孔"），让图标在缩到 16px 时仍可辨认。 */
const DOT_RADIUS = 3.2;
/** 线色：与界面正文同族的深灰，避免纯黑在浅色托盘上过重。 */
const INK = [58, 58, 58];

const CENTER = (SIZE - 1) / 2;

/** 圆环/圆点的覆盖率（抗锯齿）：距离落在边缘半像素内做线性过渡。 */
function coverage(dist, inner, outer) {
  if (dist <= inner) return 1;
  if (dist >= outer) return 0;
  return (outer - dist) / (outer - inner);
}

function buildPixels() {
  const rows = [];
  for (let y = 0; y < SIZE; y++) {
    const row = Buffer.alloc(1 + SIZE * 4);
    row[0] = 0; // PNG 滤波类型：None
    for (let x = 0; x < SIZE; x++) {
      const dx = x - CENTER;
      const dy = y - CENTER;
      const dist = Math.hypot(dx, dy);

      const ring = coverage(Math.abs(dist - RADIUS), STROKE / 2 - 0.5, STROKE / 2 + 0.5);
      const dot = coverage(dist, DOT_RADIUS - 0.5, DOT_RADIUS + 0.5);
      const alpha = Math.max(ring, dot);

      const offset = 1 + x * 4;
      row[offset] = INK[0];
      row[offset + 1] = INK[1];
      row[offset + 2] = INK[2];
      row[offset + 3] = Math.round(Math.min(1, alpha) * 255);
    }
    rows.push(row);
  }
  return Buffer.concat(rows);
}

/* ───────────────────────────── PNG 编码 ───────────────────────────── */

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
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, "ascii");
  const body = Buffer.concat([typeBuf, data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

function encodePng(raw) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(SIZE, 0);
  ihdr.writeUInt32BE(SIZE, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type: RGBA
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, "..", "packages", "desktop", "assets");
const outFile = join(outDir, "widget-tray.png");
mkdirSync(outDir, { recursive: true });
const png = encodePng(buildPixels());
writeFileSync(outFile, png);
console.log(`[widget-tray] ${outFile} (${SIZE}×${SIZE}, ${png.length} bytes)`);
