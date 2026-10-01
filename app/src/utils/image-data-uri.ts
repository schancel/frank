/**
 * Vets an untrusted `data:image/...;base64,...` URI BEFORE it is handed to the browser to decode:
 * any peer can send a catalog or an image, and a tiny file can declare huge dimensions. Nothing
 * here decodes pixels: it bounds the encoded length, then reads the width/height from the
 * format's own header in a bounded base64 prefix (PNG IHDR, GIF logical screen, JPEG SOF, WebP
 * VP8/VP8L/VP8X) and rejects anything over the limits.
 */
import { MAX_MONAD_ENVELOPE_PLAINTEXT_BYTES } from '@frank/cashweb/relay/message-limits'

export interface ImageLimits {
  /** Max length of the whole URI string (the encoded size). */
  maxEncodedLength: number
  maxDimension: number
  maxPixels: number
}

export const THUMBNAIL_LIMITS: ImageLimits = {
  maxEncodedLength: 64 * 1024,
  maxDimension: 512,
  maxPixels: 512 * 512,
}
/** The delivered image also has to fit one relay message, so the protocol constant is the cap. */
export const DELIVERED_IMAGE_LIMITS: ImageLimits = {
  maxEncodedLength: MAX_MONAD_ENVELOPE_PLAINTEXT_BYTES,
  maxDimension: 4096,
  maxPixels: 8_000_000,
}
/** Most catalog entries rendered (same as the bot's own loader limit). */
export const MAX_RENDERED_CATALOG_ENTRIES = 50

export type ImageCheck =
  | { ok: true; width: number; height: number }
  | { ok: false; reason: string }

const URI = /^data:image\/(png|jpeg|gif|webp);base64,([A-Za-z0-9+/]+={0,2})$/
// JPEG headers can sit behind EXIF/ICC segments; 48 KiB of decoded prefix is plenty and bounded.
const PREFIX_BASE64_CHARS = 64 * 1024

function decodePrefix(base64: string): Uint8Array {
  const chunk = base64.slice(0, PREFIX_BASE64_CHARS - (PREFIX_BASE64_CHARS % 4))
  const bin = atob(chunk)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

const u16be = (b: Uint8Array, i: number) => (b[i] << 8) | b[i + 1]
const u16le = (b: Uint8Array, i: number) => b[i] | (b[i + 1] << 8)
const u24le = (b: Uint8Array, i: number) =>
  b[i] | (b[i + 1] << 8) | (b[i + 2] << 16)
const u32be = (b: Uint8Array, i: number) =>
  ((b[i] << 24) | (b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]) >>> 0
const ascii = (b: Uint8Array, i: number, n: number) =>
  String.fromCharCode(...Array.from(b.slice(i, i + n)))

function dimensions(kind: string, b: Uint8Array): [number, number] | undefined {
  if (kind === 'png') {
    if (
      b.length < 24 ||
      u32be(b, 0) !== 0x89504e47 ||
      ascii(b, 12, 4) !== 'IHDR'
    )
      return
    return [u32be(b, 16), u32be(b, 20)]
  }
  if (kind === 'gif') {
    if (b.length < 10 || ascii(b, 0, 4) !== 'GIF8') return
    return [u16le(b, 6), u16le(b, 8)]
  }
  if (kind === 'webp') {
    if (b.length < 25 || ascii(b, 0, 4) !== 'RIFF' || ascii(b, 8, 4) !== 'WEBP')
      return
    const chunk = ascii(b, 12, 4)
    if (chunk === 'VP8X' && b.length >= 30)
      return [u24le(b, 24) + 1, u24le(b, 27) + 1]
    if (chunk === 'VP8L') {
      if (b[20] !== 0x2f) return
      const bits = (b[21] | (b[22] << 8) | (b[23] << 16) | (b[24] << 24)) >>> 0
      return [(bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1]
    }
    if (chunk === 'VP8 ' && b.length >= 30) {
      if (b[23] !== 0x9d || b[24] !== 0x01 || b[25] !== 0x2a) return
      return [u16le(b, 26) & 0x3fff, u16le(b, 28) & 0x3fff]
    }
    return
  }
  // jpeg: walk segments to the first SOFn
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) return
  let i = 2
  while (i + 9 < b.length) {
    if (b[i] !== 0xff) return
    const marker = b[i + 1]
    if (marker === 0xff) {
      i++
      continue
    }
    if (
      marker >= 0xc0 &&
      marker <= 0xcf &&
      ![0xc4, 0xc8, 0xcc].includes(marker)
    ) {
      return [u16be(b, i + 7), u16be(b, i + 5)]
    }
    i += 2 + u16be(b, i + 2)
  }
  return
}

export function inspectImageDataUri(
  uri: unknown,
  limits: ImageLimits,
): ImageCheck {
  if (typeof uri !== 'string') return { ok: false, reason: 'not an image' }
  if (uri.length > limits.maxEncodedLength)
    return { ok: false, reason: 'too large' }
  const match = URI.exec(uri)
  if (!match) return { ok: false, reason: 'not an inline image' }
  let dims: [number, number] | undefined
  try {
    dims = dimensions(match[1], decodePrefix(match[2]))
  } catch {
    dims = undefined
  }
  if (!dims) return { ok: false, reason: 'unreadable image header' }
  const [width, height] = dims
  if (width < 1 || height < 1) return { ok: false, reason: 'empty image' }
  if (
    width > limits.maxDimension ||
    height > limits.maxDimension ||
    width * height > limits.maxPixels
  ) {
    return { ok: false, reason: 'dimensions too large' }
  }
  return { ok: true, width, height }
}
