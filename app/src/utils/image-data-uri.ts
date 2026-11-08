/**
 * Vets an untrusted `data:image/...;base64,...` URI BEFORE it is handed to the browser to decode:
 * any peer can send a catalog or an image, and a tiny file can declare huge dimensions. Nothing
 * here decodes pixels: it bounds the encoded length, then reads the width/height from the
 * format's own header in a bounded base64 prefix (PNG IHDR, GIF logical screen, JPEG SOF, WebP
 * VP8/VP8L/VP8X) and rejects anything over the limits.
 */
import { imageDimensions } from './image-dimensions'
import { MAX_MONAD_ENVELOPE_PLAINTEXT_BYTES } from '@frank/cashweb/relay/message-limits'
import {
  DIRECT_MESSAGE_ITEM_ALLOWANCE_BYTES,
  MAX_SEALED_MESSAGE_CONTENT_BYTES,
} from '@frank/wallet/chain/direct-message-limits'
import { MAX_BLOB_BYTES } from '@frank/wallet/message-item-plugins/blob/codec'

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
/**
 * What this app puts in one direct message: the UTF-8 bytes of the text plus the data URIs of
 * its pictures (they travel byte for byte), plus `SENT_ITEM_ALLOWANCE_BYTES` for each of those
 * items. The text travels as as many text items as it needs (a text item holds at most 256 KiB;
 * `textItemsOf`). The bound is what one sealed message carries with its note to self
 * (`MAX_SEALED_MESSAGE_CONTENT_BYTES`, from the codec's 8 MiB of direct-message ciphertext). The
 * wallet refuses a sealed send whose note to self would not fit before it pays
 * (`requireSelfCopyFits`); the composer refuses it before Send.
 */
export const MAX_SENT_MESSAGE_BYTES = MAX_SEALED_MESSAGE_CONTENT_BYTES
/** Framing counted for each text or image item (measured: 44 bytes for an image, 25 for text). */
export const SENT_ITEM_ALLOWANCE_BYTES = DIRECT_MESSAGE_ITEM_ALLOWANCE_BYTES
/** One picture: at most what an image item holds (its plugin's 512 KiB, less the item's own
 * framing, counted as one allowance), and what a recipient's app will show. */
export const SENT_IMAGE_LIMITS: ImageLimits = {
  maxEncodedLength: 4 * Math.ceil(MAX_BLOB_BYTES / 3) + 64,
  maxDimension: DELIVERED_IMAGE_LIMITS.maxDimension,
  maxPixels: DELIVERED_IMAGE_LIMITS.maxPixels,
}

/** `inspectImageDataUri` reasons -> `chatImage.*` message keys. */
export const IMAGE_REASON_KEYS: Record<string, string> = {
  'not an image': 'reasonNotAnImage',
  'too large': 'reasonTooLarge',
  'not an inline image': 'reasonNotInline',
  'unreadable image header': 'reasonUnreadableHeader',
  'empty image': 'reasonEmpty',
  'dimensions too large': 'reasonDimensionsTooLarge',
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
    dims = imageDimensions(match[1], decodePrefix(match[2]))
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

/** Native peer bytes are inspected before any browser decoder or object URL receives them. */
export function inspectImageBytes(
  data: unknown,
  mimeType: unknown,
  limits: ImageLimits = DELIVERED_IMAGE_LIMITS,
): ImageCheck {
  if (
    !(data instanceof Uint8Array) ||
    typeof mimeType !== 'string' ||
    !/^image\/(png|jpeg|gif|webp)$/.test(mimeType)
  )
    return { ok: false, reason: 'not an inline image' }
  if (data.length > MAX_BLOB_BYTES) return { ok: false, reason: 'too large' }
  const dims = imageDimensions(mimeType.slice(6), data.subarray(0, 48 * 1024))
  if (!dims) return { ok: false, reason: 'unreadable image header' }
  const [width, height] = dims
  if (width < 1 || height < 1) return { ok: false, reason: 'empty image' }
  if (
    width > limits.maxDimension ||
    height > limits.maxDimension ||
    width * height > limits.maxPixels
  )
    return { ok: false, reason: 'dimensions too large' }
  return { ok: true, width, height }
}
