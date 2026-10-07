export const MAX_AVATAR_DIMENSION = 80
export const MAX_AVATAR_BYTES = 65536
export const DEFAULT_AVATAR_QUALITY = 0.8

export interface AvatarResizeOptions {
  maxDimension?: number
  maxBytes?: number
  quality?: number
}

/**
 * Returns true if an avatar data URL or string exceeds the maximum byte limit.
 */
export function isAvatarTooLarge(
  avatar?: string | null,
  maxBytes = MAX_AVATAR_BYTES,
): boolean {
  if (!avatar) return false
  const len =
    typeof Buffer !== 'undefined'
      ? Buffer.byteLength(avatar, 'utf8')
      : avatar.length
  return len > maxBytes
}

/**
 * Calculates target width and height constrained to maxDimension while preserving aspect ratio.
 */
export function calculateTargetDimensions(
  width: number,
  height: number,
  maxDimension = MAX_AVATAR_DIMENSION,
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
 * Scales an image or canvas down so its maximum width and height do not exceed `maxDimension`.
 * Preserves aspect ratio.
 */
export function resizeImageToCanvas(
  source: HTMLImageElement | HTMLCanvasElement,
  maxDimension = MAX_AVATAR_DIMENSION,
  fillWhiteBackground = false,
): HTMLCanvasElement {
  const naturalWidth =
    (source as HTMLImageElement).naturalWidth || source.width || 0
  const naturalHeight =
    (source as HTMLImageElement).naturalHeight || source.height || 0

  const { width, height } = calculateTargetDimensions(
    naturalWidth,
    naturalHeight,
    maxDimension,
  )

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
 * Export canvas to a compressed data URL (WebP, JPEG, or PNG) staying under `maxBytes`.
 */
export function canvasToCompressedDataUrl(
  canvas: HTMLCanvasElement,
  maxBytes = MAX_AVATAR_BYTES,
  quality = DEFAULT_AVATAR_QUALITY,
): string {
  // 1. Try WebP
  try {
    const webp = canvas.toDataURL('image/webp', quality)
    if (webp.startsWith('data:image/webp') && webp.length <= maxBytes) {
      return webp
    }
  } catch {
    // Canvas or WebP export failed
  }

  // 2. Try JPEG (with white background for any transparent pixels)
  try {
    const jpegCanvas = document.createElement('canvas')
    jpegCanvas.width = canvas.width
    jpegCanvas.height = canvas.height
    const ctx = jpegCanvas.getContext('2d')
    if (ctx) {
      ctx.fillStyle = '#ffffff'
      ctx.fillRect(0, 0, canvas.width, canvas.height)
      ctx.drawImage(canvas, 0, 0)
    }
    const jpeg = jpegCanvas.toDataURL('image/jpeg', quality)
    if (jpeg.startsWith('data:image/jpeg') && jpeg.length <= maxBytes) {
      return jpeg
    }
  } catch {
    // JPEG export failed
  }

  // 3. Try lower qualities (0.6, 0.4, 0.2)
  for (const q of [0.6, 0.4, 0.2]) {
    try {
      const webp = canvas.toDataURL('image/webp', q)
      if (webp.startsWith('data:image/webp') && webp.length <= maxBytes) {
        return webp
      }
    } catch {
      // ignore
    }
    try {
      const lowerJpegCanvas = document.createElement('canvas')
      lowerJpegCanvas.width = canvas.width
      lowerJpegCanvas.height = canvas.height
      const jctx = lowerJpegCanvas.getContext('2d')
      if (jctx) {
        jctx.fillStyle = '#ffffff'
        jctx.fillRect(0, 0, canvas.width, canvas.height)
        jctx.drawImage(canvas, 0, 0)
      }
      const jpeg = lowerJpegCanvas.toDataURL('image/jpeg', q)
      if (jpeg.startsWith('data:image/jpeg') && jpeg.length <= maxBytes) {
        return jpeg
      }
    } catch {
      // ignore
    }
  }

  // 4. Try PNG fallback if small enough
  try {
    const png = canvas.toDataURL('image/png')
    if (png.startsWith('data:image/png') && png.length <= maxBytes) {
      return png
    }
  } catch {
    // ignore
  }

  return ''
}

/**
 * Resizes and compresses an image or canvas so that dimensions are at most `maxDimension`
 * (default 80x80) and data URL is under `maxBytes` (default 65536 bytes).
 */
export function resizeAndCompressImage(
  source: HTMLImageElement | HTMLCanvasElement,
  options?: AvatarResizeOptions,
): string {
  const maxBytes = options?.maxBytes ?? MAX_AVATAR_BYTES
  const maxDim = options?.maxDimension ?? MAX_AVATAR_DIMENSION
  const quality = options?.quality ?? DEFAULT_AVATAR_QUALITY

  let canvas = resizeImageToCanvas(source, maxDim)
  let dataUrl = canvasToCompressedDataUrl(canvas, maxBytes, quality)

  if (dataUrl && dataUrl.length <= maxBytes) {
    return dataUrl
  }

  // Step down dimensions if still too large
  const fallbackDims = [64, 48, 32, 24, 16]
  for (const dim of fallbackDims) {
    if (dim < maxDim) {
      canvas = resizeImageToCanvas(source, dim)
      const next = canvasToCompressedDataUrl(canvas, maxBytes, quality)
      if (next && next.length <= maxBytes) {
        return next
      }
      if (next && (!dataUrl || next.length < dataUrl.length)) {
        dataUrl = next
      }
    }
  }

  return dataUrl && dataUrl.length <= maxBytes ? dataUrl : ''
}

/**
 * Loads a data URL into an image, resizes it using canvas, and exports a compressed data URL.
 */
export function compressAvatarDataUrl(
  dataUrl: string,
  options?: AvatarResizeOptions,
): Promise<string> {
  return new Promise((resolve, reject) => {
    if (typeof Image === 'undefined') {
      resolve(dataUrl)
      return
    }
    if (typeof document !== 'undefined') {
      try {
        const testCanvas = document.createElement('canvas')
        if (!testCanvas.getContext || !testCanvas.getContext('2d')) {
          reject(new Error('Canvas 2D context not available'))
          return
        }
      } catch {
        reject(new Error('Canvas not supported'))
        return
      }
    }
    const img = new Image()
    img.crossOrigin = 'Anonymous'
    let settled = false

    const finish = () => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try {
        const compressed = resizeAndCompressImage(img, options)
        resolve(compressed || dataUrl)
      } catch (err) {
        reject(err)
      }
    }

    const timer = setTimeout(() => {
      if (!settled) {
        settled = true
        reject(new Error('Avatar image compression timed out'))
      }
    }, 1500)

    img.onload = finish
    img.onerror = () => {
      if (!settled) {
        settled = true
        clearTimeout(timer)
        reject(new Error('Failed to load avatar image for compression'))
      }
    }

    img.src = dataUrl
    if (img.complete && (img.naturalWidth !== 0 || img.width !== 0)) {
      finish()
    }
  })
}

/**
 * Reads a File/Blob, resizes it using canvas, and returns a compressed data URL under maxBytes.
 */
export function compressAvatarFile(
  file: Blob | File,
  options?: AvatarResizeOptions,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = evt => {
      const dataUrl = evt.target?.result as string
      if (!dataUrl) {
        reject(new Error('Failed to read avatar file'))
        return
      }
      compressAvatarDataUrl(dataUrl, options).then(resolve, reject)
    }
    reader.onerror = () => {
      reject(new Error('Failed to read avatar file'))
    }
    reader.readAsDataURL(file)
  })
}
