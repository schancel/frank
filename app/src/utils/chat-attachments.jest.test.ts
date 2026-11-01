/** @jest-environment jsdom */
import { testBlob } from '../../../packages/wallet/message-item-plugins/blob/blob.testutil'
import {
  CHAT_IMAGE_TARGET,
  composeChatItems,
  fitsOneMessage,
  inlinePositions,
  messageTooLargeText,
  picturePreview,
  picturePreviewText,
  prepareChatImage,
  sentMessageBytes,
  shownAttachments,
} from './chat-attachments'
import {
  MAX_SENT_MESSAGE_BYTES,
  SENT_IMAGE_LIMITS,
  SENT_ITEM_ALLOWANCE_BYTES,
} from './image-data-uri'
import { gif, png } from './image-data-uri.fixtures'
import { compressPostImage, type PostAttachment } from './post-editor'

jest.mock('./post-editor', () => ({
  ...jest.requireActual('./post-editor'),
  compressPostImage: jest.fn(),
}))
const compress = jest.mocked(compressPostImage)

const attachment = (id: string, dataUrl: string): PostAttachment => ({
  id,
  name: `${id}.png`,
  dataUrl,
  sizeBytes: dataUrl.length,
})

describe('prepareChatImage', () => {
  const file = new File(['x'], 'cat.png', { type: 'image/png' })
  beforeEach(() => compress.mockReset())

  it('downscales with the forum compressor towards the chat target and accepts the result', async () => {
    compress.mockResolvedValue({ dataUrl: png(640, 480), name: 'cat.png' })
    await expect(prepareChatImage(file)).resolves.toEqual({
      ok: true,
      name: 'cat.png',
      dataUrl: png(640, 480),
    })
    expect(compress).toHaveBeenCalledWith(file, CHAT_IMAGE_TARGET)
  })

  it.each([
    [
      'still too large after downscaling',
      png(10, 10) + 'A'.repeat(SENT_IMAGE_LIMITS.maxEncodedLength),
      'reasonTooLarge',
    ],
    ['too many pixels', png(9000, 9000), 'reasonDimensionsTooLarge'],
    [
      'a type the recipient will not show',
      'data:image/svg+xml;base64,AAAA',
      'reasonNotInline',
    ],
  ])('refuses a picture that is %s', async (_n, dataUrl, reasonKey) => {
    compress.mockResolvedValue({ dataUrl, name: 'cat.png' })
    await expect(prepareChatImage(file)).resolves.toEqual({
      ok: false,
      name: 'cat.png',
      reasonKey,
    })
  })

  it('refuses a file the compressor cannot read', async () => {
    compress.mockRejectedValue(new Error('File is not a valid image'))
    await expect(prepareChatImage(file)).resolves.toMatchObject({
      ok: false,
      reasonKey: 'reasonNotAnImage',
    })
  })
})

describe('composeChatItems', () => {
  const a = attachment('2', png(2, 2))
  const b = attachment('5', gif(3, 3))

  it('sends the reply, the text, then the pictures, with references renumbered to their order', () => {
    expect(
      composeChatItems(
        'x ![second](attachment:5) y ![first](attachment:2) ![gone](attachment:9)',
        [a, b],
        'digest',
      ),
    ).toEqual([
      { type: 'reply', payloadDigest: 'digest' },
      {
        type: 'text',
        text: 'x ![second](attachment:2) y ![first](attachment:1) ![gone](attachment:9)',
      },
      testBlob(a.dataUrl),
      testBlob(b.dataUrl),
    ])
  })

  it('sends just the pictures when there is no text', () => {
    expect(composeChatItems('  \n', [a, b])).toEqual([
      testBlob(a.dataUrl),
      testBlob(b.dataUrl),
    ])
  })

  it('sends plain text as one text item', () => {
    expect(composeChatItems('hello', [], null)).toEqual([
      { type: 'text', text: 'hello' },
    ])
  })
})

describe('the size of one message', () => {
  it('counts UTF-8 text and actual decoded attachment bytes plus framing', () => {
    expect(sentMessageBytes('', [])).toBe(0)
    expect(sentMessageBytes('hé\u{1F600}', [])).toBe(
      7 + SENT_ITEM_ALLOWANCE_BYTES,
    )
    expect(
      sentMessageBytes('abc', [
        attachment(
          '1',
          'data:application/octet-stream;base64,' +
            Buffer.alloc(100).toString('base64'),
        ),
        attachment(
          '2',
          'data:application/octet-stream;base64,' +
            Buffer.alloc(50).toString('base64'),
        ),
      ]),
    ).toBe(3 + 100 + 50 + 3 * SENT_ITEM_ALLOWANCE_BYTES)
  })

  it('accepts a message exactly at the bound and refuses one byte more', () => {
    const count = 16
    const room =
      MAX_SENT_MESSAGE_BYTES - (count + 1) * SENT_ITEM_ALLOWANCE_BYTES - 5
    const one = Math.floor(room / count)
    const pictures = Array.from({ length: count }, (_, index) =>
      attachment(
        String(index),
        'data:application/octet-stream;base64,' +
          Buffer.alloc(
            index === count - 1 ? room - one * (count - 1) : one,
          ).toString('base64'),
      ),
    )
    expect(fitsOneMessage('hello', pictures)).toBe(true)
    expect(fitsOneMessage('hello!', pictures)).toBe(false)
  })

  it('lets one picture alone be as large as the per-picture limit', () => {
    expect(
      fitsOneMessage('', [
        attachment('1', 'A'.repeat(SENT_IMAGE_LIMITS.maxEncodedLength)),
      ]),
    ).toBe(true)
  })
})

describe('the pictures of a received message', () => {
  const items = [
    {
      type: 'text' as const,
      text: '![a](attachment:2) ![b](attachment:3) ![c](attachment:7)',
    },
    testBlob(png(2, 2)),
    testBlob(gif(3, 3)),
    testBlob(png(9000, 9000)),
  ]

  it('are those that pass vetting, identified by position among the image items', () => {
    expect(shownAttachments(items).map(a => [a.id, a.data])).toEqual([
      ['1', testBlob(png(2, 2)).data],
      ['2', testBlob(gif(3, 3)).data],
    ])
  })

  it('are inline only when referenced and shown: not the refused one, not a missing one', () => {
    expect([...inlinePositions(items, shownAttachments(items))]).toEqual([2])
  })
})

describe('the preview of a message with pictures', () => {
  const t = (key: string, params?: Record<string, unknown>) =>
    key === 'chatImage.onePhoto' ? 'Photo' : `${params?.count} photos`

  it('counts the pictures and drops the attachment references from the text', () => {
    const preview = picturePreview([
      {
        type: 'text',
        text: 'before ![a](attachment:1)\nafter ![b](attachment:2)',
      },
      testBlob(png(2, 2)),
      testBlob(gif(3, 3)),
    ])
    expect(preview).toEqual({ photos: 2, text: 'before after' })
    expect(picturePreviewText(preview!, t)).toBe('2 photos before after')
  })

  it('is the count alone for pictures with no text', () => {
    const preview = picturePreview([testBlob(png(2, 2))])
    expect(picturePreviewText(preview!, t)).toBe('Photo')
  })

  it('is absent for a message with no picture, whose text is left as written', () => {
    expect(
      picturePreview([{ type: 'text', text: '![a](attachment:1)' }]),
    ).toBeUndefined()
  })
})

describe('a text longer than one text item holds', () => {
  const byteLength = (text: string) => new TextEncoder().encode(text).length

  it('is sent as consecutive text items that join to the text byte for byte, before the pictures', () => {
    const a = attachment('7', png(2, 2))
    const text = '\u{1F600} é ![x](attachment:7) '.repeat(40_000)
    const items = composeChatItems(text, [a], 'digest')
    expect(items[0]).toEqual({ type: 'reply', payloadDigest: 'digest' })
    expect(items[items.length - 1]).toEqual(testBlob(a.dataUrl))
    const texts = items.flatMap(item =>
      item.type === 'text' ? [item.text] : [],
    )
    expect(texts.length).toBeGreaterThan(1)
    for (const piece of texts)
      expect(byteLength(piece)).toBeLessThanOrEqual(262_144)
    expect(texts.join('')).toBe(text.replaceAll('attachment:7', 'attachment:1'))
  })

  it('counts an allowance for each text item it travels as', () => {
    const text = 'x'.repeat(262_144 * 2 + 1)
    expect(sentMessageBytes(text, [])).toBe(
      text.length + 3 * SENT_ITEM_ALLOWANCE_BYTES,
    )
  })

  it('fits up to the bound of one sealed message, and one byte more is refused', () => {
    // 32 text items at most for this many bytes.
    const room = MAX_SENT_MESSAGE_BYTES - 32 * SENT_ITEM_ALLOWANCE_BYTES
    expect(fitsOneMessage('x'.repeat(room), [])).toBe(true)
    expect(fitsOneMessage('x'.repeat(room + 1), [])).toBe(false)
    // The bound is what a direct message carries less its fields, far above the old 500 KiB.
    expect(MAX_SENT_MESSAGE_BYTES).toBeGreaterThan(8_000_000)
    expect(MAX_SENT_MESSAGE_BYTES).toBeLessThan(8 * 1024 * 1024)
  })

  it('is refused with the limit and its size named', () => {
    const t = jest.fn(
      (key: string, params?: Record<string, unknown>) =>
        `${key} ${params?.limit} ${params?.size}`,
    )
    expect(messageTooLargeText('x'.repeat(9 * 1024 * 1024), [], t)).toBe(
      'chatInput.messageTooLarge 8.0 MiB 9.0 MiB',
    )
  })

  it('shows a picture inline whose reference is cut between two text items', () => {
    const items = [
      { type: 'text' as const, text: 'see ![a](attach' },
      { type: 'text' as const, text: 'ment:1) here' },
      testBlob(png(2, 2)),
    ]
    expect([...inlinePositions(items, shownAttachments(items))]).toEqual([1])
    expect(picturePreview(items)).toEqual({ photos: 1, text: 'see here' })
  })
})

describe('the number of items of one message', () => {
  it('holds as many pictures as a message has items for, besides its text, a reply and a wakeup card', () => {
    const pictures = (n: number) =>
      Array.from({ length: n }, (_, i) =>
        attachment(String(i), 'A'.repeat(100)),
      )
    // 256 items at most (MAX_MESSAGE_ITEMS_TOTAL): one text item, a reply, a wakeup card.
    expect(fitsOneMessage('hi', pictures(253))).toBe(true)
    expect(fitsOneMessage('hi', pictures(254))).toBe(false)
    expect(fitsOneMessage('', pictures(254))).toBe(true)
    // A long text's pieces count too.
    expect(fitsOneMessage('x'.repeat(262_145), pictures(252))).toBe(true)
    expect(fitsOneMessage('x'.repeat(262_145), pictures(253))).toBe(false)
  })
})

it('prepares an ordinary binary file and composes exact bytes with its MIME type', async () => {
  const data = Uint8Array.of(0, 255, 128)
  const file = new File([data], 'notes.bin', {
    type: 'application/octet-stream',
  })
  Object.defineProperty(file, 'arrayBuffer', { value: async () => data.buffer })
  const prepared = await prepareChatImage(file)
  if (!prepared.ok) throw new Error('expected accepted file')
  const items = composeChatItems('', [
    {
      id: '1',
      name: prepared.name,
      dataUrl: prepared.dataUrl,
      sizeBytes: data.length,
    },
  ])
  expect(items).toEqual([
    { type: 'blob', mimeType: 'application/octet-stream', data },
  ])
  expect(shownAttachments(items)).toEqual([])
})
it('refuses an oversized binary file before reading its bytes', async () => {
  const file = new File([new Uint8Array(524289)], 'large.bin', {
    type: 'application/octet-stream',
  })
  const read = jest.fn()
  Object.defineProperty(file, 'arrayBuffer', { value: read })
  expect(await prepareChatImage(file)).toMatchObject({
    ok: false,
    reasonKey: 'reasonTooLarge',
  })
  expect(read).not.toHaveBeenCalled()
})

it('shows a file reference as its name while the opaque file gets its own download card', () => {
  const items = composeChatItems('![report](attachment:1)', [
    {
      id: '1',
      name: 'report.bin',
      dataUrl: 'data:application/octet-stream;base64,AP+A',
      sizeBytes: 3,
    },
  ])
  expect(items[0]).toEqual({ type: 'text', text: 'report' })
  expect(items[1]).toEqual({
    type: 'blob',
    mimeType: 'application/octet-stream',
    data: Uint8Array.of(0, 255, 128),
  })
})
