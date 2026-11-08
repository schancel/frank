import { MAX_MONAD_ENVELOPE_PLAINTEXT_BYTES } from '@frank/cashweb/relay/message-limits'

import {
  gif,
  jpeg,
  png,
  webpL,
  webpLossy,
  webpX,
  b64,
  ascii,
} from './image-data-uri.fixtures'
import {
  DELIVERED_IMAGE_LIMITS,
  inspectImageBytes,
  inspectImageDataUri,
  THUMBNAIL_LIMITS,
} from './image-data-uri'
import { imageDimensions } from './image-dimensions'

describe('shared header parser and received policy', () => {
  it.each([
    ['png', png(320, 200)],
    ['gif', gif(320, 200)],
    ['jpeg', jpeg(320, 200)],
    ['webp', webpX(320, 200)],
    ['webp', webpL(320, 200)],
    ['webp', webpLossy(320, 200)],
  ])('keeps %s byte and URI inspection equivalent', (kind, uri) => {
    const bytes = new Uint8Array(Buffer.from(uri.split(',')[1], 'base64'))
    expect(imageDimensions(kind, bytes)).toEqual([320, 200])
    expect(inspectImageBytes(bytes, `image/${kind}`)).toEqual(
      inspectImageDataUri(uri, DELIVERED_IMAGE_LIMITS),
    )
    for (const length of [0, 2, 9]) {
      const truncated = bytes.subarray(0, length)
      expect(imageDimensions(kind, truncated)).toBeUndefined()
      expect(inspectImageBytes(truncated, `image/${kind}`).ok).toBe(false)
    }
  })

  it('keeps the received 48 KiB header budget distinct from source admission', () => {
    const uri = jpeg(320, 200, 60 * 1024)
    const bytes = new Uint8Array(Buffer.from(uri.split(',')[1], 'base64'))
    expect(imageDimensions('jpeg', bytes)).toEqual([320, 200])
    expect(inspectImageBytes(bytes, 'image/jpeg').ok).toBe(false)
    expect(inspectImageDataUri(uri, DELIVERED_IMAGE_LIMITS).ok).toBe(false)
  })
})

describe('inspectImageDataUri', () => {
  it.each([
    ['png', png(320, 200)],
    ['gif', gif(320, 200)],
    ['jpeg (SOF behind an EXIF segment)', jpeg(320, 200)],
    ['webp VP8X', webpX(320, 200)],
    ['webp VP8L', webpL(320, 200)],
    ['webp VP8', webpLossy(320, 200)],
  ])('reads the declared size of a %s without decoding it', (_n, uri) => {
    expect(inspectImageDataUri(uri, DELIVERED_IMAGE_LIMITS)).toEqual({
      ok: true,
      width: 320,
      height: 200,
    })
  })

  it.each([
    ['png', png(60000, 60000)],
    ['gif', gif(60000, 60000)],
    ['jpeg', jpeg(60000, 60000)],
    ['webp VP8X', webpX(16000, 16000)],
    ['webp VP8L', webpL(16000, 16000)],
  ])('rejects a tiny %s that declares huge dimensions', (_n, uri) => {
    expect(uri.length).toBeLessThan(1000)
    expect(inspectImageDataUri(uri, DELIVERED_IMAGE_LIMITS)).toEqual({
      ok: false,
      reason: 'dimensions too large',
    })
  })

  it('applies a pixel budget as well as a per-side bound', () => {
    expect(
      inspectImageDataUri(png(4096, 4096), DELIVERED_IMAGE_LIMITS).ok,
    ).toBe(false) // 16.7 MP
    expect(
      inspectImageDataUri(png(4000, 2000), DELIVERED_IMAGE_LIMITS).ok,
    ).toBe(true) // 8 MP
    expect(inspectImageDataUri(png(4097, 10), DELIVERED_IMAGE_LIMITS).ok).toBe(
      false,
    )
  })

  it('thumbnails are held to a much smaller bound than delivered images', () => {
    expect(inspectImageDataUri(png(96, 64), THUMBNAIL_LIMITS).ok).toBe(true)
    expect(inspectImageDataUri(png(2000, 2000), THUMBNAIL_LIMITS).ok).toBe(
      false,
    )
  })

  it('caps the encoded length: 64 KiB for a thumbnail, the protocol constant for a delivery', () => {
    const pad = (n: number) => png(10, 10) + 'A'.repeat(n)
    expect(
      inspectImageDataUri(
        pad(THUMBNAIL_LIMITS.maxEncodedLength),
        THUMBNAIL_LIMITS,
      ),
    ).toEqual({
      ok: false,
      reason: 'too large',
    })
    const big = pad(MAX_MONAD_ENVELOPE_PLAINTEXT_BYTES)
    expect(inspectImageDataUri(big, DELIVERED_IMAGE_LIMITS)).toEqual({
      ok: false,
      reason: 'too large',
    })
  })

  it.each([
    ['a remote URL', 'https://tracker.example/x.png'],
    ['svg', 'data:image/svg+xml;base64,PHN2Zz4='],
    ['html', 'data:text/html;base64,PGh0bWw+'],
    ['non-base64', 'data:image/png;base64,***'],
    ['a non-string', 42],
    ['a header too short to read', 'data:image/png;base64,iVBORw0KGgo='],
    [
      'a png without IHDR',
      `data:image/png;base64,${b64(new Array(40).fill(1))}`,
    ],
    [
      'a webp that is not RIFF/WEBP',
      `data:image/webp;base64,${b64([
        ...ascii('RIFF'),
        0,
        0,
        0,
        0,
        ...ascii('WAVE'),
        ...new Array(30).fill(0),
      ])}`,
    ],
    ['a zero-size png', png(0, 10)],
  ])('rejects %s', (_n, uri) => {
    expect(inspectImageDataUri(uri, DELIVERED_IMAGE_LIMITS).ok).toBe(false)
  })
})
