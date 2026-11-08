/** Bounded header probes only; no pixel decoding or runtime dependencies. */
const u16be = (b: Uint8Array, i: number) => (b[i] << 8) | b[i + 1]
const u16le = (b: Uint8Array, i: number) => b[i] | (b[i + 1] << 8)
const u24le = (b: Uint8Array, i: number) =>
  b[i] | (b[i + 1] << 8) | (b[i + 2] << 16)
const u32be = (b: Uint8Array, i: number) =>
  ((b[i] << 24) | (b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]) >>> 0
const ascii = (b: Uint8Array, i: number, n: number) =>
  String.fromCharCode(...Array.from(b.slice(i, i + n)))

export function imageDimensions(
  kind: string,
  b: Uint8Array,
): [number, number] | undefined {
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
