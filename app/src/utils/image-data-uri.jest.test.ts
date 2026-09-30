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
  inspectImageDataUri,
  THUMBNAIL_LIMITS,
} from './image-data-uri'

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
