'use strict';

/**
 * Generate the PNG artwork Homey requires at the exact sizes it validates.
 *
 * Committing binaries that nothing can regenerate is a trap, so the artwork is
 * produced from this script rather than dropped in by hand. It draws a shade
 * over a background in the app's brand colour using nothing but zlib, which
 * keeps the app dependency-free.
 *
 * Usage: node tools/make-images.js
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const BACKGROUND = [0x0f, 0x2b, 0x46]; // deep blue, the app's brand colour
const FABRIC = [0xe8, 0xdd, 0xc8]; // warm off-white, the shade fabric
const PLEAT = [0xc9, 0xb8, 0x9b]; // pleat shadow
const RAIL = [0x2a, 0x2a, 0x2a]; // head and bottom rail

// --- PNG encoding -----------------------------------------------------------

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c;
  }
  return table;
})();

function crc32(buffer) {
  let c = 0xffffffff;
  for (let i = 0; i < buffer.length; i++) {
    c = CRC_TABLE[(c ^ buffer[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([length, body, crc]);
}

/**
 * @param {number} width
 * @param {number} height
 * @param {(x: number, y: number) => number[]} shade RGB for one pixel.
 * @returns {Buffer} A complete 8-bit RGB PNG.
 */
function encodePng(width, height, shade) {
  const stride = width * 3;
  const raw = Buffer.alloc((stride + 1) * height);

  for (let y = 0; y < height; y++) {
    const rowStart = y * (stride + 1);
    raw[rowStart] = 0; // filter type: none
    for (let x = 0; x < width; x++) {
      const [r, g, b] = shade(x, y);
      const offset = rowStart + 1 + x * 3;
      raw[offset] = r;
      raw[offset + 1] = g;
      raw[offset + 2] = b;
    }
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type: truecolour
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// --- artwork ----------------------------------------------------------------

/**
 * A pleated shade hanging two thirds of the way down, drawn in normalised
 * coordinates so one description serves every output size.
 *
 * @param {number} width
 * @param {number} height
 * @returns {(x: number, y: number) => number[]}
 */
function shadeArtwork(width, height) {
  const shortest = Math.min(width, height);
  // Wide artwork would look lost if the shade were sized off the short edge
  // alone, and tall artwork would overflow if it were sized off the long one.
  const shadeWidth = Math.min(width * 0.44, shortest * 0.6);
  const railHeight = Math.max(2, Math.round(shortest * 0.045));
  const fabricHeight = shortest * 0.46;
  const pleatHeight = Math.max(2, shortest * 0.058);

  const left = Math.round((width - shadeWidth) / 2);
  const right = left + shadeWidth;
  // Centre what actually gets drawn: both rails plus the fabric between them.
  const top = Math.round((height - (fabricHeight + railHeight * 2)) / 2);
  const fabricBottom = top + railHeight + fabricHeight;

  return (x, y) => {
    if (x < left || x >= right) return BACKGROUND;

    // Head rail.
    if (y >= top && y < top + railHeight) return RAIL;
    // Bottom rail, drawn where the fabric stops.
    if (y >= fabricBottom && y < fabricBottom + railHeight) return RAIL;

    if (y >= top + railHeight && y < fabricBottom) {
      // Pleats: a darker band at the fold, lighter across the face.
      const intoFabric = y - (top + railHeight);
      const withinPleat = intoFabric % pleatHeight;
      return withinPleat < pleatHeight * 0.22 ? PLEAT : FABRIC;
    }

    return BACKGROUND;
  };
}

function write(file, width, height) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, encodePng(width, height, shadeArtwork(width, height)));
  process.stdout.write(`${file} (${width}x${height})\n`);
}

const root = path.join(__dirname, '..');

// App artwork, at the sizes Homey validates.
write(path.join(root, 'assets/images/small.png'), 250, 175);
write(path.join(root, 'assets/images/large.png'), 500, 350);
write(path.join(root, 'assets/images/xlarge.png'), 1000, 700);

// Driver artwork.
write(path.join(root, 'drivers/shade/assets/images/small.png'), 75, 75);
write(path.join(root, 'drivers/shade/assets/images/large.png'), 500, 500);
write(path.join(root, 'drivers/shade/assets/images/xlarge.png'), 1000, 1000);
