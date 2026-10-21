#!/usr/bin/env node
// Safari toolbar icons: the transparent brand mark recoloured into a real colour.
//
// Safari draws a greyscale (single-ink) toolbar icon as a mask and tints it with the system
// accent colour on a highlight square when the extension is active on the page; an icon with real
// colour is drawn as-is. The other browsers keep the transparent ink icon.
//
// Source:  src/assets/brand-plainspoken/raster/plainspoken-transparent-{16,32,64,128}.png
// Output:  src/assets/brand-plainspoken/raster/plainspoken-safari-toolbar-{16,32,64,128}.png
// Colour:  SAFARI_TOOLBAR_COLOR below (Carnelian, the default signet theme's primary).
// Published as icons/extension-safari-*.png by config/brands.json `publicIcons`; the Safari
// manifest (src-bex/manifests.ts SAFARI_EXTENSION_ICONS) names them.
//
// Regenerate (from app/):  node scripts/generate-safari-toolbar-icons.cjs
// Check (jest):           src-bex/safari-toolbar-icons.jest.test.ts compares the committed
//                         outputs with a fresh run of tintPng.
const fs = require('node:fs')
const path = require('node:path')
const zlib = require('node:zlib')

const SAFARI_TOOLBAR_COLOR = '#C8431E'
const SIZES = [16, 32, 64, 128]
const RASTER_DIR = path.join(
  __dirname,
  '..',
  'src',
  'assets',
  'brand-plainspoken',
  'raster',
)
const sourcePath = size =>
  path.join(RASTER_DIR, `plainspoken-transparent-${size}.png`)
const outputPath = size =>
  path.join(RASTER_DIR, `plainspoken-safari-toolbar-${size}.png`)

const SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c >>> 0
})
function crc32(buf) {
  let c = 0xffffffff
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function chunk(type, data) {
  const out = Buffer.alloc(12 + data.length)
  out.writeUInt32BE(data.length, 0)
  out.write(type, 4, 'ascii')
  data.copy(out, 8)
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length)
  return out
}

/** Decodes an 8-bit, non-interlaced RGBA PNG into { width, height, rgba }. */
function decodeRgbaPng(png) {
  if (!png.subarray(0, 8).equals(SIGNATURE)) throw new Error('not a PNG')
  let offset = 8
  let width = 0
  let height = 0
  const idat = []
  while (offset < png.length) {
    const length = png.readUInt32BE(offset)
    const type = png.toString('ascii', offset + 4, offset + 8)
    const data = png.subarray(offset + 8, offset + 8 + length)
    if (type === 'IHDR') {
      width = data.readUInt32BE(0)
      height = data.readUInt32BE(4)
      const [bitDepth, colorType, , , interlace] = data.subarray(8, 13)
      if (bitDepth !== 8 || colorType !== 6 || interlace !== 0) {
        throw new Error('expected an 8-bit non-interlaced RGBA PNG')
      }
    } else if (type === 'IDAT') {
      idat.push(data)
    }
    offset += 12 + length
  }
  const raw = zlib.inflateSync(Buffer.concat(idat))
  const stride = width * 4
  const rgba = Buffer.alloc(stride * height)
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1))
    for (let x = 0; x < stride; x++) {
      const a = x >= 4 ? rgba[y * stride + x - 4] : 0
      const b = y > 0 ? rgba[(y - 1) * stride + x] : 0
      const c = x >= 4 && y > 0 ? rgba[(y - 1) * stride + x - 4] : 0
      let predictor
      if (filter === 0) predictor = 0
      else if (filter === 1) predictor = a
      else if (filter === 2) predictor = b
      else if (filter === 3) predictor = (a + b) >> 1
      else if (filter === 4) {
        const p = a + b - c
        const pa = Math.abs(p - a)
        const pb = Math.abs(p - b)
        const pc = Math.abs(p - c)
        predictor = pa <= pb && pa <= pc ? a : pb <= pc ? b : c
      } else throw new Error(`bad PNG filter ${filter}`)
      rgba[y * stride + x] = (line[x] + predictor) & 0xff
    }
  }
  return { width, height, rgba }
}

function encodeRgbaPng({ width, height, rgba }) {
  const stride = width * 4
  const raw = Buffer.alloc((stride + 1) * height)
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride)
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr.set([8, 6, 0, 0, 0], 8)
  return Buffer.concat([
    SIGNATURE,
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

/** Every pixel takes `hex`; its alpha (the mark's shape and anti-aliasing) is kept. */
function tintPng(png, hex) {
  const [r, g, b] = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16))
  const image = decodeRgbaPng(png)
  for (let i = 0; i < image.rgba.length; i += 4) {
    image.rgba[i] = image.rgba[i + 3] ? r : 0
    image.rgba[i + 1] = image.rgba[i + 3] ? g : 0
    image.rgba[i + 2] = image.rgba[i + 3] ? b : 0
  }
  return encodeRgbaPng(image)
}

module.exports = {
  SAFARI_TOOLBAR_COLOR,
  SIZES,
  sourcePath,
  outputPath,
  decodeRgbaPng,
  tintPng,
}

if (require.main === module) {
  for (const size of SIZES) {
    fs.writeFileSync(
      outputPath(size),
      tintPng(fs.readFileSync(sourcePath(size)), SAFARI_TOOLBAR_COLOR),
    )
    console.log(path.relative(process.cwd(), outputPath(size)))
  }
}
