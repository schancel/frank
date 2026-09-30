// Strict UTF-8 (README C6) without TextEncoder/TextDecoder so behaviour does not depend on the
// host runtime: no overlong forms, no surrogates, nothing above U+10FFFF.

/** Returns true when bytes[start, end) is well-formed shortest-form UTF-8. */
export function isValidUtf8(
  b: Uint8Array,
  start: number,
  end: number,
): boolean {
  let i = start
  while (i < end) {
    const c = b[i]
    if (c < 0x80) {
      i += 1
    } else if (c >= 0xc2 && c <= 0xdf) {
      if (i + 1 >= end || (b[i + 1] & 0xc0) !== 0x80) return false
      i += 2
    } else if (c >= 0xe0 && c <= 0xef) {
      if (i + 2 >= end) return false
      const c1 = b[i + 1]
      const c2 = b[i + 2]
      if ((c1 & 0xc0) !== 0x80 || (c2 & 0xc0) !== 0x80) return false
      if (c === 0xe0 && c1 < 0xa0) return false // overlong
      if (c === 0xed && c1 >= 0xa0) return false // surrogate
      i += 3
    } else if (c >= 0xf0 && c <= 0xf4) {
      if (i + 3 >= end) return false
      const c1 = b[i + 1]
      if (
        (c1 & 0xc0) !== 0x80 ||
        (b[i + 2] & 0xc0) !== 0x80 ||
        (b[i + 3] & 0xc0) !== 0x80
      ) {
        return false
      }
      if (c === 0xf0 && c1 < 0x90) return false // overlong
      if (c === 0xf4 && c1 >= 0x90) return false // above U+10FFFF
      i += 4
    } else {
      return false // 0x80..0xc1, 0xf5..0xff
    }
  }
  return true
}

/** Decodes bytes already known to be valid UTF-8. */
export function utf8Decode(b: Uint8Array, start: number, end: number): string {
  let out = ''
  let chunk: number[] = []
  let i = start
  while (i < end) {
    const c = b[i]
    let cp: number
    if (c < 0x80) {
      cp = c
      i += 1
    } else if (c < 0xe0) {
      cp = ((c & 0x1f) << 6) | (b[i + 1] & 0x3f)
      i += 2
    } else if (c < 0xf0) {
      cp = ((c & 0x0f) << 12) | ((b[i + 1] & 0x3f) << 6) | (b[i + 2] & 0x3f)
      i += 3
    } else {
      cp =
        ((c & 0x07) << 18) |
        ((b[i + 1] & 0x3f) << 12) |
        ((b[i + 2] & 0x3f) << 6) |
        (b[i + 3] & 0x3f)
      i += 4
    }
    if (cp >= 0x10000) {
      cp -= 0x10000
      chunk.push(0xd800 + (cp >> 10), 0xdc00 + (cp & 0x3ff))
    } else {
      chunk.push(cp)
    }
    if (chunk.length >= 4096) {
      out += String.fromCharCode(...chunk)
      chunk = []
    }
  }
  if (chunk.length) out += String.fromCharCode(...chunk)
  return out
}

/** Encodes a JS string; throws on a lone surrogate (not well-formed text). */
export function utf8Encode(s: string): Uint8Array {
  const out: number[] = []
  for (let i = 0; i < s.length; i++) {
    let cp = s.charCodeAt(i)
    if (cp >= 0xd800 && cp <= 0xdbff) {
      const lo = i + 1 < s.length ? s.charCodeAt(i + 1) : 0
      if (lo < 0xdc00 || lo > 0xdfff)
        throw new RangeError('lone surrogate in text')
      cp = 0x10000 + ((cp - 0xd800) << 10) + (lo - 0xdc00)
      i++
    } else if (cp >= 0xdc00 && cp <= 0xdfff) {
      throw new RangeError('lone surrogate in text')
    }
    if (cp < 0x80) {
      out.push(cp)
    } else if (cp < 0x800) {
      out.push(0xc0 | (cp >> 6), 0x80 | (cp & 0x3f))
    } else if (cp < 0x10000) {
      out.push(0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f))
    } else {
      out.push(
        0xf0 | (cp >> 18),
        0x80 | ((cp >> 12) & 0x3f),
        0x80 | ((cp >> 6) & 0x3f),
        0x80 | (cp & 0x3f),
      )
    }
  }
  return Uint8Array.from(out)
}
