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

export interface PostAttachment {
  id: string
  name: string
  dataUrl: string
  sizeBytes: number
}

function toggleInlineDelim(
  text: string,
  start: number,
  end: number,
  delim: string,
): FormatResult | null {
  const before = text.slice(0, start)
  const selected = text.slice(start, end)
  const after = text.slice(end)

  // 1. Selection itself starts and ends with delim
  if (
    selected.length >= delim.length * 2 &&
    selected.startsWith(delim) &&
    selected.endsWith(delim)
  ) {
    if (
      delim === '*' &&
      (selected.startsWith('**') || selected.endsWith('**'))
    ) {
      // Don't unwrap bold as italic
    } else {
      const unwrapped = selected.slice(delim.length, -delim.length)
      return {
        text: before + unwrapped + after,
        selectionStart: start,
        selectionEnd: start + unwrapped.length,
      }
    }
  }

  // 2. Selection is immediately surrounded by delim
  if (before.endsWith(delim) && after.startsWith(delim)) {
    if (delim === '*' && (before.endsWith('**') || after.startsWith('**'))) {
      // Don't unwrap bold as italic
    } else {
      const newBefore = before.slice(0, -delim.length)
      const newAfter = after.slice(delim.length)
      return {
        text: newBefore + selected + newAfter,
        selectionStart: newBefore.length,
        selectionEnd: newBefore.length + selected.length,
      }
    }
  }

  // 3. Selection / cursor is inside delim on the current line
  const lineStart = text.lastIndexOf('\n', Math.max(0, start - 1)) + 1
  const nextNewline = text.indexOf('\n', end)
  const lineEnd = nextNewline === -1 ? text.length : nextNewline
  const lineBefore = text.slice(lineStart, start)
  const lineAfter = text.slice(end, lineEnd)

  const openIdxInLine = lineBefore.lastIndexOf(delim)
  const closeIdxInLine = lineAfter.indexOf(delim)

  if (openIdxInLine !== -1 && closeIdxInLine !== -1) {
    if (delim === '*') {
      const isBoldOpen =
        (openIdxInLine > 0 && lineBefore[openIdxInLine - 1] === '*') ||
        (openIdxInLine + 1 < lineBefore.length &&
          lineBefore[openIdxInLine + 1] === '*')
      const isBoldClose =
        (closeIdxInLine > 0 && lineAfter[closeIdxInLine - 1] === '*') ||
        (closeIdxInLine + 1 < lineAfter.length &&
          lineAfter[closeIdxInLine + 1] === '*')
      if (isBoldOpen || isBoldClose) {
        return null
      }
    }
    const openPos = lineStart + openIdxInLine
    const closePos = end + closeIdxInLine

    const newText =
      text.slice(0, openPos) +
      text.slice(openPos + delim.length, closePos) +
      text.slice(closePos + delim.length)

    const offsetBefore = openPos < start ? delim.length : 0
    return {
      text: newText,
      selectionStart: Math.max(openPos, start - offsetBefore),
      selectionEnd: Math.max(openPos, end - offsetBefore),
    }
  }

  return null
}

/**
 * Applies a markdown formatting action to the text given current selection indices.
 * If the selection is already formatted with the target action, toggles it off.
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
      const toggled = toggleInlineDelim(text, start, end, '**')
      if (toggled) return toggled
      const placeholder = selected || 'bold text'
      const insertion = `**${placeholder}**`
      const newText = before + insertion + after
      const newStart = before.length + 2
      const newEnd = newStart + placeholder.length
      return { text: newText, selectionStart: newStart, selectionEnd: newEnd }
    }
    case 'italic': {
      const toggled = toggleInlineDelim(text, start, end, '*')
      if (toggled) return toggled
      const placeholder = selected || 'italic text'
      const insertion = `*${placeholder}*`
      const newText = before + insertion + after
      const newStart = before.length + 1
      const newEnd = newStart + placeholder.length
      return { text: newText, selectionStart: newStart, selectionEnd: newEnd }
    }
    case 'heading': {
      // 1. If selection starts with heading prefix
      const selMatch = selected.match(/^(#{1,6}\s+)/)
      if (selMatch) {
        const unwrapped = selected.slice(selMatch[0].length)
        return {
          text: before + unwrapped + after,
          selectionStart: start,
          selectionEnd: start + unwrapped.length,
        }
      }
      // 2. If before ends with heading prefix
      const beforeMatch = before.match(/(\n?#{1,6}\s+)$/)
      if (beforeMatch) {
        const newBefore = before.slice(0, -beforeMatch[0].length)
        return {
          text: newBefore + selected + after,
          selectionStart: newBefore.length,
          selectionEnd: newBefore.length + selected.length,
        }
      }
      // 3. If current line starts with heading prefix and selection is on it
      const lineStart = text.lastIndexOf('\n', Math.max(0, start - 1)) + 1
      const nextNewline = text.indexOf('\n', end)
      const lineEnd = nextNewline === -1 ? text.length : nextNewline
      const line = text.slice(lineStart, lineEnd)
      const lineMatch = line.match(/^(#{1,6}\s+)/)
      if (lineMatch && (start > lineStart || end === start)) {
        const removed = lineMatch[0].length
        const newLine = line.slice(removed)
        const newText = text.slice(0, lineStart) + newLine + text.slice(lineEnd)
        return {
          text: newText,
          selectionStart: Math.max(lineStart, start - removed),
          selectionEnd: Math.max(lineStart, end - removed),
        }
      }
      // Otherwise insert heading
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
      // 1. If selection starts with quote prefix
      const selMatch = selected.match(/^(>\s*)/)
      if (selMatch) {
        const unwrapped = selected.slice(selMatch[0].length)
        return {
          text: before + unwrapped + after,
          selectionStart: start,
          selectionEnd: start + unwrapped.length,
        }
      }
      // 2. If before ends with quote prefix
      const beforeMatch = before.match(/(\n?>\s*)$/)
      if (beforeMatch) {
        const newBefore = before.slice(0, -beforeMatch[0].length)
        return {
          text: newBefore + selected + after,
          selectionStart: newBefore.length,
          selectionEnd: newBefore.length + selected.length,
        }
      }
      // 3. If current line starts with quote prefix and selection is on it
      const lineStart = text.lastIndexOf('\n', Math.max(0, start - 1)) + 1
      const nextNewline = text.indexOf('\n', end)
      const lineEnd = nextNewline === -1 ? text.length : nextNewline
      const line = text.slice(lineStart, lineEnd)
      const lineMatch = line.match(/^(>\s*)/)
      if (lineMatch && (start > lineStart || end === start)) {
        const removed = lineMatch[0].length
        const newLine = line.slice(removed)
        const newText = text.slice(0, lineStart) + newLine + text.slice(lineEnd)
        return {
          text: newText,
          selectionStart: Math.max(lineStart, start - removed),
          selectionEnd: Math.max(lineStart, end - removed),
        }
      }
      // Otherwise insert quote
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
        if (
          selected.startsWith('```') &&
          selected.endsWith('```') &&
          selected.length >= 6
        ) {
          const unwrapped = selected
            .replace(/^```[^\n]*\n?/, '')
            .replace(/\n?```$/, '')
          return {
            text: before + unwrapped + after,
            selectionStart: start,
            selectionEnd: start + unwrapped.length,
          }
        }
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
      const toggled = toggleInlineDelim(text, start, end, '`')
      if (toggled) return toggled
      const placeholder = selected || 'code'
      const insertion = `\`${placeholder}\``
      const newText = before + insertion + after
      const newStart = before.length + 1
      const newEnd = newStart + placeholder.length
      return { text: newText, selectionStart: newStart, selectionEnd: newEnd }
    }
    case 'bullet': {
      // 1. If selection starts with bullet prefix
      const selMatch = selected.match(/^([-*+]\s+)/)
      if (selMatch) {
        const unwrapped = selected.slice(selMatch[0].length)
        return {
          text: before + unwrapped + after,
          selectionStart: start,
          selectionEnd: start + unwrapped.length,
        }
      }
      // 2. If before ends with bullet prefix
      const beforeMatch = before.match(/(\n?[-*+]\s+)$/)
      if (beforeMatch) {
        const newBefore = before.slice(0, -beforeMatch[0].length)
        return {
          text: newBefore + selected + after,
          selectionStart: newBefore.length,
          selectionEnd: newBefore.length + selected.length,
        }
      }
      // 3. If current line starts with bullet prefix and selection is on it
      const lineStart = text.lastIndexOf('\n', Math.max(0, start - 1)) + 1
      const nextNewline = text.indexOf('\n', end)
      const lineEnd = nextNewline === -1 ? text.length : nextNewline
      const line = text.slice(lineStart, lineEnd)
      const lineMatch = line.match(/^([-*+]\s+)/)
      if (lineMatch && (start > lineStart || end === start)) {
        const removed = lineMatch[0].length
        const newLine = line.slice(removed)
        const newText = text.slice(0, lineStart) + newLine + text.slice(lineEnd)
        return {
          text: newText,
          selectionStart: Math.max(lineStart, start - removed),
          selectionEnd: Math.max(lineStart, end - removed),
        }
      }
      // Otherwise insert bullet
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
 * Replaces attachment references like `![alt](attachment:1)` with their full data URIs.
 */
export function expandAttachmentTokens(
  text: string,
  attachments: readonly PostAttachment[],
): string {
  if (!text || attachments.length === 0) return text
  const map = new Map<string, string>()
  for (const att of attachments) {
    map.set(att.id, att.dataUrl)
  }
  return text.replace(
    /!\[(.*?)\]\(attachment:([a-zA-Z0-9_-]+)\)/g,
    (match, alt, id) => {
      const dataUrl = map.get(id)
      if (dataUrl) {
        return `![${alt}](${dataUrl})`
      }
      return match
    },
  )
}

/**
 * Extracts data URIs from `![alt](data:image/...)` markdown tags, replaces them with
 * `![alt](attachment:ID)`, and returns the cleaned text along with the extracted attachments.
 */
export function tokenizeAttachmentDataUrls(
  text: string,
  existingAttachments: readonly PostAttachment[] = [],
): {
  text: string
  attachments: PostAttachment[]
} {
  const attachments: PostAttachment[] = [...existingAttachments]
  let nextIdNum = attachments.reduce((max, a) => {
    const n = parseInt(a.id, 10)
    return isNaN(n) ? max : Math.max(max, n)
  }, 0)

  const newText = text.replace(
    /!\[(.*?)\]\((data:image\/[^;]+;base64,[A-Za-z0-9+/=]+)\)/g,
    (_match, alt, dataUrl) => {
      const existing = attachments.find(a => a.dataUrl === dataUrl)
      if (existing) {
        return `![${alt || existing.name}](attachment:${existing.id})`
      }
      nextIdNum += 1
      const id = String(nextIdNum)
      const name = alt || `image-${id}`
      const base64Part = dataUrl.split(',')[1] || ''
      const sizeBytes = Math.round((base64Part.length * 3) / 4)
      attachments.push({ id, name, dataUrl, sizeBytes })
      return `![${name}](attachment:${id})`
    },
  )

  return { text: newText, attachments }
}

/**
 * Formats byte count to a readable human string (e.g. 45.2 KB).
 */
export function formatAttachmentSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const kb = bytes / 1024
  if (kb < 1024) return `${kb.toFixed(1)} KB`
  const mb = kb / 1024
  return `${mb.toFixed(1)} MB`
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
