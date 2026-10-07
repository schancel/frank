/**
 * Utility functions for the post composer: markdown formatting insertion
 * and client-side image compression for forum posts.
 */

export type MarkdownFormatAction =
  | 'bold'
  | 'italic'
  | 'heading'
  | 'quote'
  | 'code'
  | 'bullet'
  | 'link'
  | 'image'

export interface FormatResult {
  text: string
  selectionStart: number
  selectionEnd: number
}

export const MAX_POST_IMAGE_DIMENSION = 800
export const MAX_POST_IMAGE_BYTES = 120 * 1024 // 120 KB (encoded ~160 KB)

export interface PostImageOptions {
  maxDimension?: number
  maxBytes?: number
  quality?: number
}

/**
 * Applies a markdown formatting action to the text given current selection indices.
 */
export function applyMarkdownFormat(
  text: string,
  selectionStart: number,
  selectionEnd: number,
  action: MarkdownFormatAction,
  options?: { url?: string; alt?: string },
): FormatResult {
  const start = Math.max(0, Math.min(selectionStart, text.length))
  const end = Math.max(start, Math.min(selectionEnd, text.length))
  const before = text.slice(0, start)
  const selected = text.slice(start, end)
  const after = text.slice(end)

  switch (action) {
    case 'bold': {
      const placeholder = selected || 'bold text'
      const insertion = `**${placeholder}**`
      const newText = before + insertion + after
      const newStart = before.length + 2
      const newEnd = newStart + placeholder.length
      return { text: newText, selectionStart: newStart, selectionEnd: newEnd }
    }
    case 'italic': {
      const placeholder = selected || 'italic text'
      const insertion = `*${placeholder}*`
      const newText = before + insertion + after
      const newStart = before.length + 1
      const newEnd = newStart + placeholder.length
      return { text: newText, selectionStart: newStart, selectionEnd: newEnd }
    }
    case 'heading': {
      // If at start of line or empty text
      const isStartOfLine = start === 0 || text[start - 1] === '\n'
      const prefix = isStartOfLine ? '### ' : '\n### '
      const placeholder = selected || 'Heading'
      const insertion = `${prefix}${placeholder}`
      const newText = before + insertion + after
      const newStart = before.length + prefix.length
      const newEnd = newStart + placeholder.length
      return { text: newText, selectionStart: newStart, selectionEnd: newEnd }
    }
    case 'quote': {
      const isStartOfLine = start === 0 || text[start - 1] === '\n'
      const prefix = isStartOfLine ? '> ' : '\n> '
      const placeholder = selected || 'Quote'
      const insertion = `${prefix}${placeholder}`
      const newText = before + insertion + after
      const newStart = before.length + prefix.length
      const newEnd = newStart + placeholder.length
      return { text: newText, selectionStart: newStart, selectionEnd: newEnd }
    }
    case 'code': {
      if (selected.includes('\n')) {
        // Multi-line code block
        const isStartOfLine = start === 0 || text[start - 1] === '\n'
        const prefix = isStartOfLine ? '```\n' : '\n```\n'
        const suffix = '\n```\n'
        const placeholder = selected || 'code'
        const insertion = `${prefix}${placeholder}${suffix}`
        const newText = before + insertion + after
        const newStart = before.length + prefix.length
        const newEnd = newStart + placeholder.length
        return { text: newText, selectionStart: newStart, selectionEnd: newEnd }
      }
      const placeholder = selected || 'code'
      const insertion = `\`${placeholder}\``
      const newText = before + insertion + after
      const newStart = before.length + 1
      const newEnd = newStart + placeholder.length
      return { text: newText, selectionStart: newStart, selectionEnd: newEnd }
    }
    case 'bullet': {
      const isStartOfLine = start === 0 || text[start - 1] === '\n'
      const prefix = isStartOfLine ? '- ' : '\n- '
      const placeholder = selected || 'List item'
      const insertion = `${prefix}${placeholder}`
      const newText = before + insertion + after
      const newStart = before.length + prefix.length
      const newEnd = newStart + placeholder.length
      return { text: newText, selectionStart: newStart, selectionEnd: newEnd }
    }
    case 'link': {
      const label = selected || 'link text'
      const url = options?.url || 'https://'
      const insertion = `[${label}](${url})`
      const newText = before + insertion + after
      const newStart = before.length + label.length + 3
      const newEnd = newStart + url.length
      return { text: newText, selectionStart: newStart, selectionEnd: newEnd }
    }
    case 'image': {
      const alt = options?.alt || selected || 'image'
      const url = options?.url || 'https://'
      const isStartOfLine = start === 0 || text[start - 1] === '\n'
      const prefix = isStartOfLine ? '' : '\n'
      const insertion = `${prefix}![${alt}](${url})\n`
      const newText = before + insertion + after
      const newStart = before.length + prefix.length
      const newEnd = newStart + insertion.length - (isStartOfLine ? 1 : 0)
      return { text: newText, selectionStart: newStart, selectionEnd: newEnd }
    }
  }
}

/**
 * Inserts markdown for an image (e.g. data URI or URL) at the cursor position.
 */
export function insertImageMarkdown(
  text: string,
  selectionStart: number,
  selectionEnd: number,
  alt: string,
  src: string,
): FormatResult {
  const start = Math.max(0, Math.min(selectionStart, text.length))
  const end = Math.max(start, Math.min(selectionEnd, text.length))
  const before = text.slice(0, start)
  const after = text.slice(end)

  const needsLeadingNewline = start > 0 && text[start - 1] !== '\n'
  const needsTrailingNewline = after.length > 0 && after[0] !== '\n'

  const leading = needsLeadingNewline ? '\n' : ''
  const trailing = needsTrailingNewline ? '\n' : '\n'
  const sanitizedAlt = (alt || 'image').replace(/[[\]]/g, '')
  const insertion = `${leading}![${sanitizedAlt}](${src})${trailing}`

  const newText = before + insertion + after
  const newCursor = before.length + insertion.length
  return {
    text: newText,
    selectionStart: newCursor,
    selectionEnd: newCursor,
  }
}

/**
 * Calculates target width and height constrained to maxDimension while preserving aspect ratio.
 */
export function calculateTargetDimensions(
  width: number,
  height: number,
  maxDimension = MAX_POST_IMAGE_DIMENSION,
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
 * Draws image onto a scaled canvas.
 */
export function drawToCanvas(
  source: HTMLImageElement | HTMLCanvasElement,
  width: number,
  height: number,
): HTMLCanvasElement {
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d')
  if (ctx) {
    ctx.drawImage(source, 0, 0, width, height)
  }
  return canvas
}

/**
 * Tries exporting canvas to WebP or JPEG under maxBytes.
 */
export function canvasToDataUrl(
  canvas: HTMLCanvasElement,
  maxBytes: number,
  quality: number,
): string | null {
  // Try WebP first
  try {
    const webp = canvas.toDataURL('image/webp', quality)
    if (webp.startsWith('data:image/webp') && webp.length <= maxBytes) {
      return webp
    }
  } catch {
    // webp unsupported or failed
  }

  // Try JPEG with white background
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
    // jpeg failed
  }

  return null
}

/**
 * Compresses an image element to a data URL fitting within maxBytes and maxDimension.
 */
export function compressImageElement(
  img: HTMLImageElement | HTMLCanvasElement,
  options?: PostImageOptions,
): string {
  const maxDim = options?.maxDimension ?? MAX_POST_IMAGE_DIMENSION
  const maxBytes = options?.maxBytes ?? MAX_POST_IMAGE_BYTES
  const initialQuality = options?.quality ?? 0.82

  const naturalWidth = (img as HTMLImageElement).naturalWidth || img.width || 0
  const naturalHeight =
    (img as HTMLImageElement).naturalHeight || img.height || 0

  const { width: targetWidth, height: targetHeight } =
    calculateTargetDimensions(naturalWidth, naturalHeight, maxDim)

  const steps = [
    { scale: 1.0, quality: initialQuality },
    { scale: 1.0, quality: 0.65 },
    { scale: 0.75, quality: 0.65 },
    { scale: 0.5, quality: 0.55 },
    { scale: 0.35, quality: 0.45 },
  ]

  let bestDataUrl: string | null = null

  for (const step of steps) {
    const w = Math.max(1, Math.round(targetWidth * step.scale))
    const h = Math.max(1, Math.round(targetHeight * step.scale))
    const canvas = drawToCanvas(img, w, h)
    const result = canvasToDataUrl(canvas, maxBytes, step.quality)
    if (result) {
      return result
    }
    // Fallback attempt: if even lower quality doesn't hit maxBytes, track smallest
    try {
      const candidate = canvas.toDataURL('image/jpeg', step.quality)
      if (
        !bestDataUrl ||
        (candidate && candidate.length < bestDataUrl.length)
      ) {
        bestDataUrl = candidate
      }
    } catch {
      // ignore
    }
  }

  if (bestDataUrl && bestDataUrl.length <= maxBytes) {
    return bestDataUrl
  }

  // If still too large, return best candidate if available, else throw
  if (bestDataUrl && bestDataUrl.length <= maxBytes * 1.5) {
    return bestDataUrl
  }

  throw new Error('Image exceeds size limit for forum posts')
}

/**
 * Compresses a File or Blob image for inclusion in a post.
 */
export function compressPostImage(
  file: File | Blob,
  options?: PostImageOptions,
): Promise<{ dataUrl: string; name: string }> {
  const fileName = 'name' in file ? file.name : 'image.png'
  return new Promise((resolve, reject) => {
    if (!file.type.startsWith('image/')) {
      reject(new Error('File is not a valid image'))
      return
    }

    const reader = new FileReader()
    reader.onload = evt => {
      const rawUrl = evt.target?.result as string
      if (!rawUrl) {
        reject(new Error('Failed to read image file'))
        return
      }

      // If already small enough (e.g. tiny PNG/GIF/JPEG <= 40KB), use as is
      const maxBytes = options?.maxBytes ?? MAX_POST_IMAGE_BYTES
      if (rawUrl.length <= Math.min(maxBytes, 40 * 1024)) {
        resolve({ dataUrl: rawUrl, name: fileName })
        return
      }

      const img = new Image()
      let settled = false

      const finish = () => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        try {
          const compressed = compressImageElement(img, options)
          resolve({ dataUrl: compressed, name: fileName })
        } catch (err) {
          reject(err)
        }
      }

      const timer = setTimeout(() => {
        if (!settled) {
          settled = true
          reject(new Error('Image processing timed out'))
        }
      }, 3000)

      img.onload = finish
      img.onerror = () => {
        if (!settled) {
          settled = true
          clearTimeout(timer)
          reject(new Error('Failed to decode image'))
        }
      }

      img.src = rawUrl
      if (img.complete && (img.naturalWidth !== 0 || img.width !== 0)) {
        finish()
      }
    }

    reader.onerror = () => {
      reject(new Error('Failed to read image file'))
    }

    reader.readAsDataURL(file)
  })
}
