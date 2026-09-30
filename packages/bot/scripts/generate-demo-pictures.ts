/**
 * Regenerates the bundled demo catalog (`../demo-catalog/`): three original, neutral,
 * procedurally drawn pictures (no third-party artwork, no photographs) plus a small thumbnail of
 * each, and the `manifest.json` that lists them. Deterministic: rerunning produces identical
 * bytes. Only needed if you want to change the bundled art; a seller swaps content by pointing
 * `VENDOR_BOT_CATALOG_DIR` at their own directory instead (see `../README.md`).
 *
 *   cd packages/bot && yarn tsx scripts/generate-demo-pictures.ts
 */
import { mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import { deflateSync } from 'zlib'

type Rgb = [number, number, number]
type Painter = (x: number, y: number) => Rgb

const mix = (a: Rgb, b: Rgb, t: number): Rgb => {
  const k = Math.min(1, Math.max(0, t))
  return [
    a[0] + (b[0] - a[0]) * k,
    a[1] + (b[1] - a[1]) * k,
    a[2] + (b[2] - a[2]) * k,
  ]
}
/** Smooth 0..1 coverage for an edge at signed distance `d` pixels (anti-aliasing). */
const cover = (d: number) => Math.min(1, Math.max(0, 0.5 - d))

// Scenes are functions of normalised coordinates (u, v in 0..1, v down) so the thumbnail is the
// same picture at a smaller size.
const SCENES: Record<string, (u: number, v: number, px: number) => Rgb> = {
  sunrise(u, v, px) {
    let c = mix([250, 190, 110], [70, 60, 130], v * 1.3)
    const sun = Math.hypot((u - 0.62) * 1.5, v - 0.52) - 0.16
    c = mix(c, [255, 240, 190], cover(sun / px))
    const hill1 = 0.68 + 0.06 * Math.sin(u * 6.5 + 0.8)
    c = mix(c, [60, 50, 110], cover((hill1 - v) / px))
    const hill2 = 0.8 + 0.05 * Math.sin(u * 9 + 2.4)
    c = mix(c, [32, 28, 74], cover((hill2 - v) / px))
    return c
  },
  waves(u, v) {
    const base = mix([20, 90, 150], [10, 30, 80], v)
    const band = Math.sin(v * 38 + Math.sin(u * 7) * 2.2)
    return mix(base, [120, 210, 230], Math.max(0, band) * 0.35)
  },
  rings(u, v, px) {
    const d = Math.hypot((u - 0.5) * 1.5, v - 0.5)
    let c = mix([30, 140, 130], [15, 60, 80], d * 1.6)
    const ring = Math.abs(((d * 9) % 1) - 0.5) - 0.32
    c = mix(c, [235, 225, 170], cover(ring / (px * 9)) * 0.85)
    return c
  },
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c >>> 0
})
function crc32(buf: Buffer): number {
  let c = 0xffffffff
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function crc(buf: Buffer): Buffer {
  const out = Buffer.alloc(4)
  out.writeUInt32BE(crc32(buf))
  return out
}
function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  return Buffer.concat([len, body, crc(body)])
}

/** Minimal 8-bit RGB PNG encoder (Sub filter, max zlib compression). */
function encodePng(width: number, height: number, paint: Painter): Buffer {
  const stride = width * 3
  const raw = Buffer.alloc((stride + 1) * height)
  const prev = Buffer.alloc(stride)
  const row = Buffer.alloc(stride)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const [r, g, b] = paint(x, y)
      row[x * 3] = Math.round(r)
      row[x * 3 + 1] = Math.round(g)
      row[x * 3 + 2] = Math.round(b)
    }
    raw[y * (stride + 1)] = 1 // Sub
    for (let i = 0; i < stride; i++) {
      const left = i >= 3 ? row[i - 3] : 0
      raw[y * (stride + 1) + 1 + i] = (row[i] - left) & 0xff
    }
    row.copy(prev)
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 2 // RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

const OUT = join(__dirname, '..', 'demo-catalog')
const FULL = { w: 480, h: 320 }
const THUMB = { w: 96, h: 64 }

const ITEMS = [
  {
    itemId: 'sunrise',
    description: 'Sunrise over hills (generated demo picture)',
    priceWei: '50000000000000000', // 0.05 MON
  },
  {
    itemId: 'waves',
    description: 'Blue waves (generated demo picture)',
    priceWei: '50000000000000000',
  },
  {
    itemId: 'rings',
    description: 'Concentric rings (generated demo picture)',
    priceWei: '100000000000000000', // 0.1 MON
  },
]

mkdirSync(OUT, { recursive: true })
for (const item of ITEMS) {
  const scene = SCENES[item.itemId]
  const draw = (size: { w: number; h: number }) =>
    encodePng(size.w, size.h, (x, y) =>
      scene((x + 0.5) / size.w, (y + 0.5) / size.h, 1 / size.h),
    )
  writeFileSync(join(OUT, `${item.itemId}.png`), draw(FULL))
  writeFileSync(join(OUT, `${item.itemId}-thumb.png`), draw(THUMB))
}
writeFileSync(
  join(OUT, 'manifest.json'),
  JSON.stringify(
    {
      items: ITEMS.map(i => ({
        ...i,
        image: `${i.itemId}.png`,
        thumbnail: `${i.itemId}-thumb.png`,
      })),
    },
    null,
    2,
  ) + '\n',
)
console.log(`wrote ${ITEMS.length} pictures + thumbnails to ${OUT}`)
