import {
  encodeCanonical,
  encodeFrame,
   standaloneItemBudget,
  validateFrame,
  type ChildFrame,
} from '@frank/codec'
import type { ApplicationMessageItem } from '@frank/cashweb/types/messages'
import {
  createMessageItemRegistry,
  MessageItemDecodeError,
  MessageItemEncodeError,
} from '../registry'
import { decodeItemFrames, encodeItemFrames } from '../wire'
import {
  createNewsletterArticleItem,
  createNewsletterArticlePlugin,
  NEWSLETTER_ARTICLE_ITEM_TYPE,
  readNewsletterArticle,
  type NewsletterArticleValue,
} from './index'

const sampleArticle: NewsletterArticleValue = {
  articleId: 'dispatch-001',
  title: 'Post-Quantum Stamp Channels in Practice',
  source: 'Stamped Dispatch',
  author: 'Ada Lovelace',
  summary:
    'How hash-based commitments and compact stamp receipts protect reader privacy.',
  body: 'Paragraph one explores deterministic CBOR framing.\n\nParagraph two details zero-leakage reader views.',
  url: 'https://frank.example/dispatch/001',
  imageUrl:
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  publishedAt: 1760000000000,
  tags: ['privacy', 'cryptography', 'cbor'],
}

const minimalArticle: NewsletterArticleValue = {
  articleId: 'dispatch-min',
  title: 'Minimal Edition',
  source: 'Wire',
  body: 'Short dispatch body.',
  publishedAt: 0,
}

function toChildFrames(frames: Uint8Array[]): ChildFrame[] {
  const parsed = validateFrame(
    encodeFrame(
      { typeId: 8, schemaVersion: 1, minReaderVersion: 1 },
      new Map<number, string | Uint8Array[]>([
        [0, 'frank'],
        [1, frames],
      ]),
    ),
  )
  if (parsed.kind !== 'parsed' || parsed.typed?.type !== 8) {
    throw new Error('Expected revision frame')
  }
  return parsed.typed.items
}

describe('newsletter-article-v1 application item plugin', () => {
  it('validates minimal and complete newsletter articles via readNewsletterArticle', () => {
    expect(readNewsletterArticle(minimalArticle)).toEqual(minimalArticle)
    expect(readNewsletterArticle(sampleArticle)).toEqual(sampleArticle)
  })

  it('rejects invalid fields and unknown properties in readNewsletterArticle', () => {
    expect(() => readNewsletterArticle(null)).toThrow(TypeError)
    expect(() => readNewsletterArticle('not-an-object')).toThrow(TypeError)
    expect(() => readNewsletterArticle([])).toThrow(TypeError)
    expect(() =>
      readNewsletterArticle({ ...minimalArticle, extraField: true }),
    ).toThrow(/Unexpected newsletter article property/)
    expect(() =>
      readNewsletterArticle({ ...minimalArticle, articleId: '' }),
    ).toThrow(/articleId/)
    expect(() =>
      readNewsletterArticle({ ...minimalArticle, articleId: 'x'.repeat(129) }),
    ).toThrow(/articleId/)
    expect(() =>
      readNewsletterArticle({ ...minimalArticle, title: '' }),
    ).toThrow(/title/)
    expect(() =>
      readNewsletterArticle({ ...minimalArticle, title: 'x'.repeat(257) }),
    ).toThrow(/title/)
    expect(() =>
      readNewsletterArticle({ ...minimalArticle, source: '' }),
    ).toThrow(/source/)
    expect(() =>
      readNewsletterArticle({ ...minimalArticle, body: '' }),
    ).toThrow(/body/)
    expect(() =>
      readNewsletterArticle({ ...minimalArticle, publishedAt: -1 }),
    ).toThrow(/publishedAt/)
    expect(() =>
      readNewsletterArticle({ ...minimalArticle, publishedAt: 1.5 }),
    ).toThrow(/publishedAt/)
    expect(() =>
      readNewsletterArticle({
        ...minimalArticle,
        url: 'javascript:alert(1)',
      }),
    ).toThrow(/url/)
    expect(() =>
      readNewsletterArticle({
        ...minimalArticle,
        imageUrl: 'ftp://example.com/img.png',
      }),
    ).toThrow(/imageUrl/)
    expect(() =>
      readNewsletterArticle({
        ...minimalArticle,
        tags: Array.from({ length: 17 }, (_, i) => `tag-${i}`),
      }),
    ).toThrow(/tags/)
    expect(() =>
      readNewsletterArticle({
        ...minimalArticle,
        tags: [''],
      }),
    ).toThrow(/tags\[0\]/)
  })

  it('registers with MessageItemRegistry, formats previewText, and round-trips canonical CBOR and wire frames', () => {
    const registry = createMessageItemRegistry()
    registry.registerApplication(createNewsletterArticlePlugin())

    const fullItem = createNewsletterArticleItem(sampleArticle)
    const minItem = createNewsletterArticleItem(minimalArticle)

    expect(registry.previewText(fullItem)).toBe(
      '📰 Post-Quantum Stamp Channels in Practice — Stamped Dispatch',
    )
    expect(registry.previewText(minItem)).toBe('📰 Minimal Edition — Wire')

    const encodedFull = registry.encodeItem(fullItem)
    expect(encodedFull.type).toBe(NEWSLETTER_ARTICLE_ITEM_TYPE)
    const decodedFull = registry.decodeItem(
      NEWSLETTER_ARTICLE_ITEM_TYPE,
      encodedFull.bytes,
      { budget: standaloneItemBudget() },
    )
    expect(decodedFull).toEqual({
      kind: 'item',
      item: fullItem,
    })

    // Deterministic canonical CBOR encoding
    expect(registry.encodeItem(fullItem).bytes).toEqual(encodedFull.bytes)

    // Wire frame round-trip (frame type 27)
    const frames = encodeItemFrames(registry, [fullItem, minItem])
    const decodedFrames = decodeItemFrames(
      registry,
      toChildFrames(frames),
      standaloneItemBudget(),
    )
    expect(decodedFrames).toEqual([fullItem, minItem])
  })

  it('rejects malformed CBOR and unknown CBOR map keys on decode', () => {
    const registry = createMessageItemRegistry()
    registry.registerApplication(createNewsletterArticlePlugin())

    expect(() =>
      registry.decodeItem(NEWSLETTER_ARTICLE_ITEM_TYPE, new Uint8Array(), {
        budget: standaloneItemBudget(),
      }),
    ).toThrow(MessageItemDecodeError)

    const unknownKeyCbor = encodeCanonical(
      new Map<number, string | number>([
        [0, 'id-1'],
        [1, 'Title'],
        [2, 'Source'],
        [3, 'Body'],
        [4, 1000],
        [99, 'unknown'],
      ]),
    )
    expect(() =>
      registry.decodeItem(NEWSLETTER_ARTICLE_ITEM_TYPE, unknownKeyCbor, {
        budget: standaloneItemBudget(),
      }),
    ).toThrow(MessageItemDecodeError)

    const badItem: ApplicationMessageItem = {
      type: 'application',
      itemType: NEWSLETTER_ARTICLE_ITEM_TYPE,
      value: { articleId: '' },
    }
    expect(() => registry.encodeItem(badItem)).toThrow(MessageItemEncodeError)
  })
})
