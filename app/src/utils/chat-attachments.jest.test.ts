/** @jest-environment jsdom */
import {
  CHAT_IMAGE_TARGET,
  composeChatItems,
  fitsOneMessage,
  inlinePositions,
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
      { type: 'image', image: a.dataUrl },
      { type: 'image', image: b.dataUrl },
    ])
  })

  it('sends just the pictures when there is no text', () => {
    expect(composeChatItems('  \n', [a, b])).toEqual([
      { type: 'image', image: a.dataUrl },
      { type: 'image', image: b.dataUrl },
    ])
  })

  it('sends plain text as one text item', () => {
    expect(composeChatItems('hello', [], null)).toEqual([
      { type: 'text', text: 'hello' },
    ])
  })
})

describe('the size of one message', () => {
  it('counts the UTF-8 bytes of the text, each data URI, and an allowance per item', () => {
    expect(sentMessageBytes('', [])).toBe(0)
    expect(sentMessageBytes('hé\u{1F600}', [])).toBe(
      7 + SENT_ITEM_ALLOWANCE_BYTES,
    )
    expect(
      sentMessageBytes('abc', [
        attachment('1', 'A'.repeat(100)),
        attachment('2', 'B'.repeat(50)),
      ]),
    ).toBe(3 + 100 + 50 + 3 * SENT_ITEM_ALLOWANCE_BYTES)
  })

  it('accepts a message exactly at the bound and refuses one byte more', () => {
    const room = MAX_SENT_MESSAGE_BYTES - 3 * SENT_ITEM_ALLOWANCE_BYTES - 5
    const pictures = [
      attachment('1', 'A'.repeat(room - 1000)),
      attachment('2', 'B'.repeat(1000)),
    ]
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
    { type: 'image' as const, image: png(2, 2) },
    { type: 'image' as const, image: gif(3, 3) },
    { type: 'image' as const, image: png(9000, 9000) },
  ]

  it('are those that pass vetting, identified by position among the image items', () => {
    expect(shownAttachments(items).map(a => [a.id, a.dataUrl])).toEqual([
      ['1', png(2, 2)],
      ['2', gif(3, 3)],
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
      { type: 'image', image: png(2, 2) },
      { type: 'image', image: gif(3, 3) },
    ])
    expect(preview).toEqual({ photos: 2, text: 'before after' })
    expect(picturePreviewText(preview!, t)).toBe('2 photos before after')
  })

  it('is the count alone for pictures with no text', () => {
    const preview = picturePreview([{ type: 'image', image: png(2, 2) }])
    expect(picturePreviewText(preview!, t)).toBe('Photo')
  })

  it('is absent for a message with no picture, whose text is left as written', () => {
    expect(
      picturePreview([{ type: 'text', text: '![a](attachment:1)' }]),
    ).toBeUndefined()
  })
})
