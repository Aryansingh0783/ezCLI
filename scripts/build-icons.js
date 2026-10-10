'use strict';

/**
 * Rasterize docs/icon.svg into the PNG and ICO sizes Electron needs.
 * Runs once from `npm run icons`; the generated files are committed.
 */

const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const ROOT = path.resolve(__dirname, '..');
const svg = fs.readFileSync(path.join(ROOT, 'docs', 'icon.svg'));
const outDir = path.join(ROOT, 'docs', 'icons');
fs.mkdirSync(outDir, { recursive: true });

const sizes = [16, 24, 32, 48, 64, 128, 256, 512];

async function main() {
  const buffers = {};
  for (const size of sizes) {
    const png = await sharp(svg, { density: 384 })
      .resize(size, size)
      .png()
      .toBuffer();
    const file = path.join(outDir, `icon-${size}.png`);
    fs.writeFileSync(file, png);
    buffers[size] = png;
    console.log(`  wrote ${path.relative(ROOT, file)}`);
  }

  // Primary PNG the Electron window uses on Linux and in-app.
  fs.writeFileSync(path.join(ROOT, 'docs', 'icon.png'), buffers[512]);
  console.log('  wrote docs/icon.png');

  // Multi-size .ico for the Windows installer. ICO is just a header +
  // a directory of embedded PNG or BMP entries, so we hand-build one
  // rather than pull in another dependency.
  const icoSizes = [16, 24, 32, 48, 64, 128, 256];
  const entries = icoSizes.map((s) => ({ size: s, png: buffers[s] }));
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2); // 1 = icon
  header.writeUInt16LE(entries.length, 4);

  const dir = Buffer.alloc(16 * entries.length);
  const images = [];
  let offset = 6 + dir.length;
  entries.forEach((e, i) => {
    const base = i * 16;
    dir.writeUInt8(e.size === 256 ? 0 : e.size, base + 0);
    dir.writeUInt8(e.size === 256 ? 0 : e.size, base + 1);
    dir.writeUInt8(0, base + 2); // palette
    dir.writeUInt8(0, base + 3); // reserved
    dir.writeUInt16LE(1, base + 4); // color planes
    dir.writeUInt16LE(32, base + 6); // bits per pixel
    dir.writeUInt32LE(e.png.length, base + 8);
    dir.writeUInt32LE(offset, base + 12);
    offset += e.png.length;
    images.push(e.png);
  });

  const ico = Buffer.concat([header, dir, ...images]);
  fs.writeFileSync(path.join(ROOT, 'docs', 'icon.ico'), ico);
  console.log('  wrote docs/icon.ico');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
