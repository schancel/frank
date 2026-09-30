/** Test-only builders of minimal image headers (no pixel data). */
export const b64 = (bytes: number[]) => Buffer.from(bytes).toString('base64')
const be32 = (n: number) => [
  (n >>> 24) & 255,
  (n >>> 16) & 255,
  (n >>> 8) & 255,
  n & 255,
]
const le16 = (n: number) => [n & 255, (n >> 8) & 255]
export const ascii = (s: string) => Array.from(s).map(c => c.charCodeAt(0))

export const png = (w: number, h: number) =>
  `data:image/png;base64,${b64([
    0x89,
    0x50,
    0x4e,
    0x47,
    0x0d,
    0x0a,
    0x1a,
    0x0a,
    ...be32(13),
    ...ascii('IHDR'),
    ...be32(w),
    ...be32(h),
    8,
    2,
    0,
    0,
    0,
  ])}`
export const gif = (w: number, h: number) =>
  `data:image/gif;base64,${b64([
    ...ascii('GIF89a'),
    ...le16(w),
    ...le16(h),
    0,
    0,
    0,
  ])}`
// SOI, an APP1 segment of 300 bytes (EXIF-like) BEFORE the SOF0 that carries the size.
export const jpeg = (w: number, h: number) =>
  `data:image/jpeg;base64,${b64([
    0xff,
    0xd8,
    0xff,
    0xe1,
    0x01,
    0x2c,
    ...new Array(298).fill(0),
    0xff,
    0xc0,
    0x00,
    0x11,
    8,
    (h >> 8) & 255,
    h & 255,
    (w >> 8) & 255,
    w & 255,
    3,
    1,
    0x22,
    0,
    2,
    0x11,
    1,
    3,
    0x11,
    1,
  ])}`
const le24 = (n: number) => [n & 255, (n >> 8) & 255, (n >> 16) & 255]
export const webpX = (w: number, h: number) =>
  `data:image/webp;base64,${b64([
    ...ascii('RIFF'),
    0,
    0,
    0,
    0,
    ...ascii('WEBP'),
    ...ascii('VP8X'),
    10,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    ...le24(w - 1),
    ...le24(h - 1),
  ])}`
export const webpL = (w: number, h: number) => {
  const bits = ((w - 1) | ((h - 1) << 14)) >>> 0
  return `data:image/webp;base64,${b64([
    ...ascii('RIFF'),
    0,
    0,
    0,
    0,
    ...ascii('WEBP'),
    ...ascii('VP8L'),
    5,
    0,
    0,
    0,
    0x2f,
    bits & 255,
    (bits >> 8) & 255,
    (bits >> 16) & 255,
    (bits >>> 24) & 255,
    0,
    0,
    0,
  ])}`
}
export const webpLossy = (w: number, h: number) =>
  `data:image/webp;base64,${b64([
    ...ascii('RIFF'),
    0,
    0,
    0,
    0,
    ...ascii('WEBP'),
    ...ascii('VP8 '),
    10,
    0,
    0,
    0,
    0,
    0,
    0,
    0x9d,
    0x01,
    0x2a,
    ...le16(w),
    ...le16(h),
  ])}`
