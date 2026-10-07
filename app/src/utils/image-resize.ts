/**
 * Client-side canvas image downscaling utility.
 *
 * Prevents HTTP 413 Payload Too Large errors on relay POST endpoints by:
 * 1. Constraining image dimensions to a maximum width/height (default: 800px)
 *    while strictly preserving aspect ratio.
 * 2. Re-compressing to WebP or JPEG (default quality: 0.82) targeting < 150KB.
 * 3. Returning the original input untouched if already within constraints.
 */

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

/**
 * Loads an image from a File, Blob, or base64 data URL into an HTMLImageElement.
 */
function loadImageSource(
  input: File | Blob | string,
): Promise<{ img: HTMLImageElement; rawDataUrl: string }> {
  return new Promise((resolve, reject) => {
    if (typeof Image === 'undefined') {
      reject(new Error('Image constructor not available in environment'))
      return
    }

    const img = new Image()
    img.crossOrigin = 'Anonymous'
    let settled = false

    const timeout = setTimeout(() => {
      if (!settled) {
        settled = true
        reject(new Error('Image decoding timed out'))
      }
    }, 1500)

    const finish = (dataUrl: string) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      resolve({ img, rawDataUrl: dataUrl })
    }

    img.onerror = () => {
      if (!settled) {
        settled = true
        clearTimeout(timeout)
        reject(new Error('Failed to decode image'))
      }
    }

    if (typeof input === 'string') {
      const fallbackTimer = setTimeout(() => {
        if (!settled && input.length <= 40 * 1024) {
          finish(input)
        }
      }, 50)

      img.onload = () => {
        clearTimeout(fallbackTimer)
        finish(input)
      }
      img.onerror = () => {
        clearTimeout(fallbackTimer)
        if (!settled) {
          settled = true
          clearTimeout(timeout)
          reject(new Error('Failed to decode image'))
        }
      }
      img.src = input
      if (img.complete && (img.naturalWidth !== 0 || img.width !== 0)) {
        clearTimeout(fallbackTimer)
        finish(input)
      }
    } else {
      if (input.type && !input.type.startsWith('image/')) {
        settled = true
        clearTimeout(timeout)
        reject(new Error('File is not a valid image'))
        return
      }

      if (typeof FileReader === 'undefined') {
        settled = true
        clearTimeout(timeout)
        reject(new Error('FileReader not available'))
        return
      }

      const reader = new FileReader()
      reader.onload = evt => {
        const dataUrl = evt.target?.result as string
        if (!dataUrl) {
          if (!settled) {
            settled = true
            clearTimeout(timeout)
            reject(new Error('Failed to read image file'))
          }
          return
        }

        const fallbackTimer = setTimeout(() => {
          if (!settled && dataUrl.length <= 40 * 1024) {
            finish(dataUrl)
          }
        }, 50)

        img.onload = () => {
          clearTimeout(fallbackTimer)
          finish(dataUrl)
        }
        img.onerror = () => {
          clearTimeout(fallbackTimer)
          if (!settled) {
            settled = true
            clearTimeout(timeout)
            reject(new Error('Failed to decode image'))
          }
        }
        img.src = dataUrl
        if (img.complete && (img.naturalWidth !== 0 || img.width !== 0)) {
          clearTimeout(fallbackTimer)
          finish(dataUrl)
        }
      }
      reader.onerror = () => {
        if (!settled) {
          settled = true
          clearTimeout(timeout)
          reject(new Error('Failed to read image file'))
        }
      }
      reader.readAsDataURL(input)
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

  // Fast path for non-browser/non-DOM environments
  if (typeof document === 'undefined' || typeof Image === 'undefined') {
    if (typeof input === 'string') return input
    if (typeof FileReader !== 'undefined') {
      return new Promise((resolve, reject) => {
        const reader = new FileReader()
        reader.onload = evt => resolve((evt.target?.result as string) || '')
        reader.onerror = reject
        reader.readAsDataURL(input)
      })
    }
    return ''
  }

  // Fast path if Canvas 2D context is unavailable in current environment
  try {
    const testCanvas = document.createElement('canvas')
    if (!testCanvas.getContext || !testCanvas.getContext('2d')) {
      if (typeof input === 'string') return input
      if (typeof FileReader !== 'undefined') {
        return new Promise((resolve, reject) => {
          const reader = new FileReader()
          reader.onload = evt => resolve((evt.target?.result as string) || '')
          reader.onerror = reject
          reader.readAsDataURL(input)
        })
      }
      return ''
    }
  } catch {
    if (typeof input === 'string') return input
  }

  const { img, rawDataUrl } = await loadImageSource(input)

  const naturalWidth = img.naturalWidth || img.width || 0
  const naturalHeight = img.naturalHeight || img.height || 0
  const rawSize = getImageByteSize(rawDataUrl)
  const isInputString = typeof input === 'string'
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
