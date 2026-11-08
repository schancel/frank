/**
 * Client-side canvas image downscaling utility.
 *
 * Prevents HTTP 413 Payload Too Large errors on relay POST endpoints by:
 * 1. Constraining image dimensions to a maximum width/height (default: 800px)
 *    while strictly preserving aspect ratio.
 * 2. Re-compressing to WebP or JPEG (default quality: 0.82) targeting < 150KB.
 * 3. Returning the original input untouched if already within constraints.
 */

import { imageDimensions, rasterKindFromHeader } from './image-dimensions'

// Source admission is separate from compressed output and received-message limits.
const MAX_SOURCE_BYTES = 32 * 1024 * 1024
const MAX_SOURCE_PIXELS = 64_000_000
const MAX_SOURCE_EDGE = 32768
const SOURCE_HEADER_BYTES = 256 * 1024

export class ImageSourceError extends Error {
  constructor(
    readonly reason:
      | 'too large'
      | 'unreadable image header'
      | 'empty image'
      | 'dimensions too large',
  ) {
    super(reason)
    this.name = 'ImageSourceError'
  }
}

export const DEFAULT_MAX_DIMENSION = 800
export const DEFAULT_MAX_BYTES = 150 * 1024 // 150 KB (153,600 bytes)
export const DEFAULT_QUALITY = 0.82

export interface ImageResizeOptions {
  maxDimension?: number
  maxBytes?: number
  quality?: number
}

/**
 * Calculates target width and height constrained to maxDimension while preserving aspect ratio.
 */
export function calculateTargetDimensions(
  width: number,
  height: number,
  maxDimension = DEFAULT_MAX_DIMENSION,
): { width: number; height: number } {
  if (width <= 0 || height <= 0) {
    return { width: maxDimension, height: maxDimension }
  }
  if (width <= maxDimension && height <= maxDimension) {
    return { width, height }
  }
  if (width >= height) {
    return {
      width: maxDimension,
      height: Math.max(1, Math.round((height * maxDimension) / width)),
    }
  }
  return {
    width: Math.max(1, Math.round((width * maxDimension) / height)),
    height: maxDimension,
  }
}

/**
 * Calculates the byte size of an image input (File, Blob, or base64 data URL).
 */
export function getImageByteSize(input: File | Blob | string): number {
  if (typeof input !== 'string') {
    return input.size
  }
  const commaIdx = input.indexOf(',')
  if (commaIdx !== -1) {
    const base64 = input.slice(commaIdx + 1)
    const padding = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0
    return Math.max(0, Math.floor((base64.length * 3) / 4) - padding)
  }
  return typeof Buffer !== 'undefined'
    ? Buffer.byteLength(input, 'utf8')
    : input.length
}

/**
 * Draws an HTMLImageElement or HTMLCanvasElement to a new canvas of specified dimensions.
 */
export function drawToCanvas(
  source: HTMLImageElement | HTMLCanvasElement,
  width: number,
  height: number,
  fillWhiteBackground = false,
): HTMLCanvasElement {
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d')
  if (ctx) {
    if (fillWhiteBackground) {
      ctx.fillStyle = '#ffffff'
      ctx.fillRect(0, 0, width, height)
    }
    ctx.drawImage(source, 0, 0, width, height)
  }
  return canvas
}

/**
 * Tries exporting canvas to WebP or JPEG with quality and byte limit checks.
 */
export function canvasToCompressedDataUrl(
  canvas: HTMLCanvasElement,
  maxBytes: number,
  quality: number,
): string | null {
  // 1. Try WebP first
  try {
    const webp = canvas.toDataURL('image/webp', quality)
    if (
      webp.startsWith('data:image/webp') &&
      (webp.length <= maxBytes || getImageByteSize(webp) <= maxBytes)
    ) {
      return webp
    }
  } catch {
    // WebP unsupported or failed
  }

  // 2. Try JPEG (with white background for transparency)
  try {
    const jpegCanvas = drawToCanvas(canvas, canvas.width, canvas.height, true)
    const jpeg = jpegCanvas.toDataURL('image/jpeg', quality)
    if (
      jpeg.startsWith('data:image/jpeg') &&
      (jpeg.length <= maxBytes || getImageByteSize(jpeg) <= maxBytes)
    ) {
      return jpeg
    }
  } catch {
    // JPEG failed
  }

  return null
}

/** Admit a local source before any full read; unknown formats retain byte-only admission.
 * SVG/AVIF/HEIC pixel and decode-memory budgets remain unproved.
 */
export function readImageFile(input: File | Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    if (
      !Number.isFinite(input.size) ||
      input.size < 0 ||
      input.size > MAX_SOURCE_BYTES
    ) {
      reject(new ImageSourceError('too large'))
      return
    }
    if (input.type && !input.type.startsWith('image/')) {
      reject(new Error('File is not a valid image'))
      return
    }
    if (typeof FileReader === 'undefined') {
      reject(new Error('FileReader not available'))
      return
    }
    let settled = false
    const reader = new FileReader()
    const clear = () => {
      clearTimeout(timer)
      reader.onload = null
      reader.onerror = null
      reader.onabort = null
    }
    const fail = (error: Error) => {
      if (settled) return
      settled = true
      clear()
      if (reader.readyState === 1) reader.abort()
      reject(error)
    }
    const timer = setTimeout(
      () => fail(new Error('Image file reading timed out')),
      1500,
    )
    const readFull = () => {
      if (settled) return
      reader.onload = event => {
        if (settled) return
        const result = event.target?.result
        if (typeof result !== 'string' || !result) {
          fail(new Error('Failed to read image file'))
          return
        }
        settled = true
        clear()
        resolve(result)
      }
      try {
        reader.readAsDataURL(input)
      } catch {
        fail(new Error('Failed to read image file'))
      }
    }
    reader.onerror = () => fail(new Error('Failed to read image file'))
    reader.onabort = () => fail(new Error('Image file reading aborted'))
    const declaredKind = /^image\/(png|jpeg|gif|webp)$/.exec(input.type)?.[1]
    reader.onload = event => {
      if (settled) return
      const result = event.target?.result
      if (!(result instanceof ArrayBuffer)) {
        fail(new ImageSourceError('unreadable image header'))
        return
      }
      const bytes = new Uint8Array(result)
      const kind = declaredKind ?? rasterKindFromHeader(bytes)
      if (!kind) {
        readFull()
        return
      }
      const dims = imageDimensions(kind, bytes)
      if (!dims) {
        fail(new ImageSourceError('unreadable image header'))
        return
      }
      if (dims[0] < 1 || dims[1] < 1) {
        fail(new ImageSourceError('empty image'))
        return
      }
      if (
        dims[0] > MAX_SOURCE_EDGE ||
        dims[1] > MAX_SOURCE_EDGE ||
        dims[0] * dims[1] > MAX_SOURCE_PIXELS
      ) {
        fail(new ImageSourceError('dimensions too large'))
        return
      }
      readFull()
    }
    try {
      reader.readAsArrayBuffer(
        input.slice(0, Math.min(input.size, SOURCE_HEADER_BYTES)),
      )
    } catch {
      fail(new Error('Failed to read image header'))
    }
  })
}

/** The untrusted File path must wait for actual load, never the string shortcut. */
function loadImageSource(
  input: string,
  trustedString: boolean,
): Promise<{ img: HTMLImageElement; rawDataUrl: string }> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.crossOrigin = 'Anonymous'
    let settled = false
    let fallbackTimer: ReturnType<typeof setTimeout> | undefined
    const clear = () => {
      clearTimeout(timeout)
      clearTimeout(fallbackTimer)
      img.onload = null
      img.onerror = null
    }
    const fail = (error: Error) => {
      if (settled) return
      settled = true
      clear()
      img.src = ''
      reject(error)
    }
    const timeout = setTimeout(
      () => fail(new Error('Image decoding timed out')),
      1500,
    )
    const finish = () => {
      if (settled) return
      settled = true
      clear()
      // Keep the successfully loaded source until the caller finishes compression.
      resolve({ img, rawDataUrl: input })
    }
    if (trustedString && input.length <= 40 * 1024) {
      fallbackTimer = setTimeout(finish, 50)
    }
    img.onload = finish
    img.onerror = () => fail(new Error('Failed to decode image'))
    try {
      img.src = input
      if (img.complete && (img.naturalWidth !== 0 || img.width !== 0)) finish()
    } catch {
      fail(new Error('Failed to decode image'))
    }
  })
}

/**
 * Compresses an image element using canvas downscaling and progressive quality / scale step-downs.
 */
export function compressImageElement(
  img: HTMLImageElement | HTMLCanvasElement,
  options?: ImageResizeOptions,
): string {
  const maxDim = options?.maxDimension ?? DEFAULT_MAX_DIMENSION
  const maxBytes = options?.maxBytes ?? DEFAULT_MAX_BYTES
  const initialQuality = options?.quality ?? DEFAULT_QUALITY

  const naturalWidth = (img as HTMLImageElement).naturalWidth || img.width || 0
  const naturalHeight =
    (img as HTMLImageElement).naturalHeight || img.height || 0

  const { width: targetWidth, height: targetHeight } =
    calculateTargetDimensions(naturalWidth, naturalHeight, maxDim)

  // Progressive step-down strategy if initial quality exceeds byte budget
  const steps = [
    { scale: 1.0, quality: initialQuality },
    { scale: 1.0, quality: 0.7 },
    { scale: 0.85, quality: 0.65 },
    { scale: 0.7, quality: 0.55 },
    { scale: 0.5, quality: 0.45 },
    { scale: 0.35, quality: 0.35 },
  ]

  let bestDataUrl: string | null = null

  for (const step of steps) {
    const w = Math.max(1, Math.round(targetWidth * step.scale))
    const h = Math.max(1, Math.round(targetHeight * step.scale))
    const canvas = drawToCanvas(img, w, h)
    const result = canvasToCompressedDataUrl(canvas, maxBytes, step.quality)
    if (result) {
      return result
    }

    // Keep track of smallest candidate
    try {
      const candidate =
        canvas.toDataURL('image/webp', step.quality) ||
        canvas.toDataURL('image/jpeg', step.quality)
      if (
        candidate &&
        (!bestDataUrl || candidate.length < bestDataUrl.length)
      ) {
        bestDataUrl = candidate
      }
    } catch {
      // ignore canvas export failure
    }
  }

  if (bestDataUrl) {
    return bestDataUrl
  }

  throw new Error('Image exceeds size limit and could not be compressed')
}

/**
 * Downscales and compresses an image (File, Blob, or base64 data URL) client-side.
 *
 * If dimensions are already within `maxDimension` (default 800px) and byte size is
 * already within `maxBytes` (default 150KB), the original data URL is returned
 * without re-compression to avoid quality degradation.
 *
 * Otherwise, downscales using an HTML canvas to fit within constraints and re-compresses
 * with WebP (or JPEG fallback) at the specified quality (default 0.82).
 */
export async function downscaleImage(
  input: File | Blob | string,
  options?: ImageResizeOptions,
): Promise<string> {
  const maxDim = options?.maxDimension ?? DEFAULT_MAX_DIMENSION
  const maxBytes = options?.maxBytes ?? DEFAULT_MAX_BYTES

  // Admission precedes even DOM/canvas probing and non-browser fallback reads.
  const isInputString = typeof input === 'string'
  const dataUrl = typeof input === 'string' ? input : await readImageFile(input)
  if (typeof document === 'undefined' || typeof Image === 'undefined') {
    return dataUrl
  }
  try {
    const testCanvas = document.createElement('canvas')
    if (!testCanvas.getContext || !testCanvas.getContext('2d')) return dataUrl
  } catch {
    if (isInputString) return dataUrl
  }

  const { img, rawDataUrl } = await loadImageSource(dataUrl, isInputString)

  const naturalWidth = img.naturalWidth || img.width || 0
  const naturalHeight = img.naturalHeight || img.height || 0
  const rawSize = getImageByteSize(rawDataUrl)
  const inputSize = isInputString ? input.length : input.size

  // If already within all constraints, return original without re-compressing
  const withinDimensionConstraints =
    naturalWidth <= maxDim && naturalHeight <= maxDim
  const withinByteConstraints = rawSize <= maxBytes && inputSize <= maxBytes

  if (withinDimensionConstraints && withinByteConstraints) {
    return isInputString ? input : rawDataUrl
  }

  return compressImageElement(img, options)
}

/** Alias for downscaleImage */
export const resizeImage = downscaleImage
