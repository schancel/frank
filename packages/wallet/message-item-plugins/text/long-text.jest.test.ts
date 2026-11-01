import { testBlob } from '../blob/blob.testutil'
import type { MessageItem } from '@frank/cashweb/types/messages'
import { MAX_TEXT_STRING_BYTES } from '@frank/codec'

import {
  registryWith,
  standaloneDecodeContext,
} from '../shared/plugin-contract.testutil'
import {
  joinConsecutiveTextItems,
  joinConsecutiveTextItemsIndexed,
  splitLongTextItems,
  splitTextByUtf8Bytes,
  textItemsOf,
  utf8ByteLength,
} from './long-text'
import { initTextPlugin } from './plugin'
import {
  MAX_SEALED_MESSAGE_CONTENT_BYTES,
  sealedMessageOverLimit,
} from '../../chain/direct-message-limits'

const bytes = (text: string) => new TextEncoder().encode(text).length
const registry = registryWith('text', initTextPlugin)

/** Every piece fits, none ends inside a code point, and the pieces are the text byte for byte. */
function expectPieces(text: string, pieces: string[], max: number) {
  expect(pieces.join('')).toBe(text)
  expect(
    Buffer.concat(pieces.map(piece => Buffer.from(piece, 'utf8'))).equals(
      Buffer.from(text, 'utf8'),
    ),
  ).toBe(true)
  for (const piece of pieces) {
    expect(bytes(piece)).toBeLessThanOrEqual(max)
    // A lone surrogate at either end would mean a code point was cut in two.
    expect(piece).not.toMatch(/^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/)
  }
}

describe('utf8ByteLength', () => {
  it.each([
    ['', 0],
    ['abc', 3],
    ['é', 2],
    ['€', 3],
    ['\u{1F600}', 4],
    ['a\u{1F600}é€', 10],
    ['\uD800', 3],
    ['\uDC00x', 4],
  ])('counts %j as TextEncoder writes it', (text, expected) => {
    expect(utf8ByteLength(text)).toBe(expected)
    expect(utf8ByteLength(text)).toBe(bytes(text))
  })
})

describe('splitTextByUtf8Bytes', () => {
  it('keeps a text that fits as one piece, and the empty text as one empty piece', () => {
    expect(splitTextByUtf8Bytes('hello')).toEqual(['hello'])
    expect(splitTextByUtf8Bytes('')).toEqual([''])
    const full = 'x'.repeat(MAX_TEXT_STRING_BYTES)
    expect(splitTextByUtf8Bytes(full)).toEqual([full])
  })

  it('splits ASCII with no space or line break exactly at the limit', () => {
    const text = 'x'.repeat(MAX_TEXT_STRING_BYTES * 2 + 5)
    const pieces = splitTextByUtf8Bytes(text)
    expect(pieces.map(bytes)).toEqual([
      MAX_TEXT_STRING_BYTES,
      MAX_TEXT_STRING_BYTES,
      5,
    ])
    expectPieces(text, pieces, MAX_TEXT_STRING_BYTES)
  })

  it('splits an exact multiple of the limit into full pieces and no empty one', () => {
    const text = 'y'.repeat(MAX_TEXT_STRING_BYTES * 3)
    const pieces = splitTextByUtf8Bytes(text)
    expect(pieces.map(bytes)).toEqual([
      MAX_TEXT_STRING_BYTES,
      MAX_TEXT_STRING_BYTES,
      MAX_TEXT_STRING_BYTES,
    ])
  })

  it.each([
    ['two-byte', 'é'],
    ['three-byte', '€'],
    ['four-byte (a surrogate pair)', '\u{1F600}'],
  ])(
    'never cuts a %s character that straddles the limit',
    (_name, char) => {
      // One ASCII byte first, so a character of every width straddles a 16-byte limit.
      for (let lead = 0; lead < 4; lead++) {
        const text = 'a'.repeat(lead) + char.repeat(40)
        const pieces = splitTextByUtf8Bytes(text, 16)
        expectPieces(text, pieces, 16)
        // Each piece is as full as a whole character allows.
        for (const piece of pieces.slice(0, -1))
          expect(bytes(piece)).toBeGreaterThan(16 - bytes(char))
      }
    },
  )

  it('ends a piece after a line break, else a space, near the limit', () => {
    const line = 'word '.repeat(10_000) + '\n'
    const text = line.repeat(20)
    const pieces = splitTextByUtf8Bytes(text)
    expectPieces(text, pieces, MAX_TEXT_STRING_BYTES)
    for (const piece of pieces.slice(0, -1)) {
      expect(piece.endsWith('\n') || piece.endsWith(' ')).toBe(true)
      expect(bytes(piece)).toBeGreaterThan(MAX_TEXT_STRING_BYTES - 4096)
    }
    const spaces = ('a'.repeat(99) + ' ').repeat(6_000)
    for (const piece of splitTextByUtf8Bytes(spaces).slice(0, -1))
      expect(piece.endsWith(' ')).toBe(true)
  })

  it('splits the largest text a sealed message carries, mixed widths, byte for byte', () => {
    const unit = 'ab é € \u{1F600}\n'
    const text = unit.repeat(Math.floor((8 * 1024 * 1024) / bytes(unit)))
    const pieces = splitTextByUtf8Bytes(text)
    expectPieces(text, pieces, MAX_TEXT_STRING_BYTES)
    expect(pieces.length).toBe(Math.ceil(bytes(text) / (MAX_TEXT_STRING_BYTES - 4096)))
  })

  it('refuses a limit that cannot hold one code point', () => {
    expect(() => splitTextByUtf8Bytes('abc', 3)).toThrow(RangeError)
  })
})

describe('textItemsOf', () => {
  it('gives text items the text plugin encodes, one past the limit refused', () => {
    const text = '\u{1F600}'.repeat(MAX_TEXT_STRING_BYTES / 2) // 512 KiB
    const items = textItemsOf(text)
    expect(items.length).toBe(2)
    for (const item of items) expect(() => registry.encodeItem(item)).not.toThrow()
    expect(() => registry.encodeItem({ type: 'text', text })).toThrow(
      /longer than 262144/,
    )
    // Encoded and decoded, the items join to the text byte for byte.
    const decoded = items.map(item => {
      const result = registry.decodeItem(
        'text',
        registry.encodeItem(item).bytes,
        standaloneDecodeContext(),
      )
      if (result.kind !== 'item') throw new Error('expected a decoded text item')
      return result.item as MessageItem
    })
    const joined = joinConsecutiveTextItems(decoded)
    expect(joined).toHaveLength(1)
    expect(joined[0].type === 'text' && joined[0].text === text).toBe(true)
  })
})

describe('joinConsecutiveTextItems', () => {
  const image: MessageItem = testBlob('data:image/png;base64,AAAA')
  const reply: MessageItem = { type: 'reply', payloadDigest: 'ab'.repeat(32) }

  it('joins each run of consecutive text items with nothing between them, keeping the rest in order', () => {
    const items: MessageItem[] = [
      reply,
      { type: 'text', text: 'one ' },
      { type: 'text', text: 'two' },
      image,
      { type: 'text', text: 'three' },
      { type: 'text', text: '' },
      { type: 'text', text: ' four' },
    ]
    expect(joinConsecutiveTextItems(items)).toEqual([
      reply,
      { type: 'text', text: 'one two' },
      image,
      { type: 'text', text: 'three four' },
    ])
    expect(joinConsecutiveTextItemsIndexed(items).map(entry => entry.index)).toEqual([
      0, 1, 3, 4,
    ])
  })

  it('returns the same items when nothing is consecutive', () => {
    const items: MessageItem[] = [{ type: 'text', text: 'a' }, image, { type: 'text', text: 'b' }]
    expect(joinConsecutiveTextItems(items)).toBe(items)
  })
})

describe('splitLongTextItems', () => {
  const reply: MessageItem = { type: 'reply', payloadDigest: 'ab'.repeat(32) }
  it('splits only the texts longer than a text item holds, in place, and a reader shows the items given', () => {
    const long = 'ä long line\n'.repeat(60_000)
    const items: MessageItem[] = [reply, { type: 'text', text: 'short' }, { type: 'text', text: long }]
    const split = splitLongTextItems(items)
    expect(split.slice(0, 2)).toEqual(items.slice(0, 2))
    expect(split.length).toBeGreaterThan(3)
    for (const item of split.slice(1)) expect(() => registry.encodeItem(item)).not.toThrow()
    expect(joinConsecutiveTextItems(split)).toEqual([reply, { type: 'text', text: 'short' + long }])
    // The same items again give the same items: a message sent again has the same bytes.
    expect(splitLongTextItems(items)).toEqual(split)
  })
  it('returns the same items when every text fits', () => {
    const items: MessageItem[] = [reply, { type: 'text', text: 'x'.repeat(MAX_TEXT_STRING_BYTES) }]
    expect(splitLongTextItems(items)).toBe(items)
  })
})

describe('sealedMessageOverLimit', () => {
  it('admits the largest text a sealed message carries and refuses one byte more, saying why', () => {
    const largest = (text: number) => [{ type: 'text', text: 'z'.repeat(text) }] as MessageItem[]
    // Each text item of the split counts its allowance (64 bytes) on top of its text.
    const fits = (n: number) => sealedMessageOverLimit(splitLongTextItems(largest(n))) === undefined
    // ASCII with no break splits at exactly 256 KiB: 32 items for the largest text.
    const n = MAX_SEALED_MESSAGE_CONTENT_BYTES - 64 * 32
    expect(splitLongTextItems(largest(n))).toHaveLength(32)
    expect(fits(n)).toBe(true)
    expect(sealedMessageOverLimit(splitLongTextItems(largest(n + 1)))).toMatch(
      new RegExp(`carries at most ${MAX_SEALED_MESSAGE_CONTENT_BYTES}`),
    )
  })
  it('refuses more items than a message holds', () => {
    const items = Array.from({ length: 257 }, () => ({ type: 'text', text: 'a' }) as MessageItem)
    expect(sealedMessageOverLimit(items)).toMatch(/257 items .* at most 256/)
  })
})
