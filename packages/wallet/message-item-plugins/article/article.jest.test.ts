import {
  encodeCanonical,
  encodeFrame,
  standaloneItemBudget,
  validateFrame,
  type ChildFrame,
} from '@frank/codec'
import {
  createMessageItemRegistry,
  MessageItemDecodeError,
  MessageItemEncodeError,
} from '../registry'
import { decodeItemFrames, encodeItemFrames } from '../wire'
import {
  ARTICLE_PLUGIN_ID,
  articlePlugin,
  decodeArticlePayload,
  encodeArticlePayload,
  estimateArticleReadingMinutes,
  parseArticleApplicationItem,
  parseArticleMarkdown,
  readArticlePayload,
  renderArticleMarkdownToHtml,
  sanitizeArticleUrl,
  toArticleApplicationItem,
  type ArticlePayload,
} from './index'

const sampleArticle: ArticlePayload = {
  schemaVersion: 1,
  articleId: 'article-2026-10-17-01',
  title: 'Designing Content-Oblivious Encrypted Articles',
  summary:
    'How deterministic CBOR and zero-XSS Markdown keep long-form articles private inside encrypted chat.',
  markdownBody: [
    '# Introduction',
    '',
    'Welcome to **Frank Articles** with *rich* typography, `inline code`, and ~~legacy~~ modern primitives.',
    '',
    '## Threat Model',
    '',
    '> Relays must remain content-oblivious while clients render zero-XSS Markdown.',
    '',
    '- [x] Deterministic CBOR payload bounds',
    '- [ ] Optional attachment references',
    '',
    '1. First ordered item',
    '2. Second ordered item',
    '',
    '| Feature | Bound |',
    '| :--- | ---: |',
    '| Title | 200 chars |',
    '| Body | 65536 bytes |',
    '',
    '```ts',
    'const id = "article-v1";',
    '```',
    '',
    'Read the [specification](https://frank.cash/docs/articles) or contact [support](mailto:security@frank.cash).',
  ].join('\n'),
  authorName: 'Ada Lovelace',
  publishedAtIso: '2026-10-17T20:00:00.000Z',
  tags: ['privacy', 'markdown', 'cbor'],
}

const minimalArticle: ArticlePayload = {
  schemaVersion: 1,
  articleId: 'min-1',
  title: 'Minimal Note',
  markdownBody: 'Hello world.',
  publishedAtIso: '2026-10-17T00:00:00Z',
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

describe('article-v1 payload contract and codec', () => {
  it('validates minimal and complete payloads and round-trips CBOR and JSON', () => {
    expect(readArticlePayload(minimalArticle)).toEqual(minimalArticle)
    expect(readArticlePayload(sampleArticle)).toEqual(sampleArticle)

    const encoded = encodeArticlePayload(sampleArticle)
    expect(decodeArticlePayload(encoded)).toEqual(sampleArticle)

    const appItem = toArticleApplicationItem(sampleArticle)
    expect(appItem.type).toBe('application')
    expect(appItem.itemType).toBe(ARTICLE_PLUGIN_ID)
    expect(parseArticleApplicationItem(appItem)).toEqual(sampleArticle)
    expect(
      parseArticleApplicationItem(JSON.parse(JSON.stringify(appItem))),
    ).toEqual(sampleArticle)
    expect(articlePlugin.buildSummary(sampleArticle)).toBe(
      '[Article] Designing Content-Oblivious Encrypted Articles',
    )
  })

  it('registers with MessageItemRegistry and round-trips wire frames', () => {
    const registry = createMessageItemRegistry()
    registry.registerApplication(articlePlugin)

    const fullItem = toArticleApplicationItem(sampleArticle)
    const minItem = toArticleApplicationItem(minimalArticle)

    expect(registry.previewText(fullItem)).toBe(
      '[Article] Designing Content-Oblivious Encrypted Articles',
    )
    expect(registry.previewText(minItem)).toBe('[Article] Minimal Note')

    const frames = encodeItemFrames(registry, [fullItem, minItem])
    const decoded = decodeItemFrames(
      registry,
      toChildFrames(frames),
      standaloneItemBudget(),
    )
    expect(decoded).toEqual([fullItem, minItem])
  })

  it('enforces strict bounds on schemaVersion, articleId, title, summary, markdownBody (64KB UTF-8), authorName, publishedAtIso, and tags', () => {
    expect(() =>
      readArticlePayload({ ...minimalArticle, schemaVersion: 2 }),
    ).toThrow(/schemaVersion/)
    expect(() =>
      readArticlePayload({ ...minimalArticle, extra: 'disallowed' }),
    ).toThrow(/Unexpected article property/)
    expect(() =>
      readArticlePayload({ ...minimalArticle, articleId: '' }),
    ).toThrow(/articleId/)
    expect(() =>
      readArticlePayload({
        ...minimalArticle,
        articleId: 'a'.repeat(65),
      }),
    ).toThrow(/articleId/)
    expect(() =>
      readArticlePayload({
        ...minimalArticle,
        articleId: 'has space',
      }),
    ).toThrow(/articleId/)
    expect(() =>
      readArticlePayload({
        ...minimalArticle,
        articleId: 'non-ascii-é',
      }),
    ).toThrow(/articleId/)

    expect(() =>
      readArticlePayload({ ...minimalArticle, title: '   ' }),
    ).toThrow(/title/)
    expect(() =>
      readArticlePayload({ ...minimalArticle, title: 't'.repeat(201) }),
    ).toThrow(/title/)

    expect(() =>
      readArticlePayload({ ...minimalArticle, summary: 's'.repeat(501) }),
    ).toThrow(/summary/)

    expect(() =>
      readArticlePayload({ ...minimalArticle, authorName: 'a'.repeat(121) }),
    ).toThrow(/authorName/)

    expect(() =>
      readArticlePayload({
        ...minimalArticle,
        publishedAtIso: 'not-a-timestamp',
      }),
    ).toThrow(/publishedAtIso/)

    // Exact 65536-byte boundary passes; 65537 bytes fails; multibyte UTF-8 exceeding 65536 bytes fails
    const exact64k = readArticlePayload({
      ...minimalArticle,
      markdownBody: 'a'.repeat(65536),
    })
    expect(exact64k.markdownBody.length).toBe(65536)

    expect(() =>
      readArticlePayload({
        ...minimalArticle,
        markdownBody: 'a'.repeat(65537),
      }),
    ).toThrow(/markdownBody/)

    // 22,000 3-byte UTF-8 characters = 66,000 UTF-8 bytes (> 65536 bytes even though < 65536 chars)
    expect(() =>
      readArticlePayload({
        ...minimalArticle,
        markdownBody: '€'.repeat(22000),
      }),
    ).toThrow(/markdownBody/)

    // Up to 8 tags of 1..32 chars each
    expect(
      readArticlePayload({
        ...minimalArticle,
        tags: Array.from({ length: 8 }, (_, idx) => `tag-${idx}`),
      }).tags,
    ).toHaveLength(8)

    expect(() =>
      readArticlePayload({
        ...minimalArticle,
        tags: Array.from({ length: 9 }, (_, idx) => `tag-${idx}`),
      }),
    ).toThrow(/tags/)

    expect(() =>
      readArticlePayload({
        ...minimalArticle,
        tags: ['valid', 'x'.repeat(33)],
      }),
    ).toThrow(/tags\[1\]/)

    expect(parseArticleApplicationItem(null)).toBeNull()
    expect(
      parseArticleApplicationItem({
        type: 'application',
        itemType: 'other-v1',
        value: minimalArticle,
      }),
    ).toBeNull()
  })

  it('rejects malformed CBOR maps and invalid encode items via registry', () => {
    const registry = createMessageItemRegistry()
    registry.registerApplication(articlePlugin)

    const unknownKeyCbor = encodeCanonical(
      new Map<number, string | number>([
        [0, 1],
        [1, 'id-1'],
        [2, 'Title'],
        [3, 'Body'],
        [4, '2026-10-17T00:00:00Z'],
        [99, 'extra'],
      ]),
    )
    expect(() =>
      registry.decodeItem(ARTICLE_PLUGIN_ID, unknownKeyCbor, {
        budget: standaloneItemBudget(),
      }),
    ).toThrow(MessageItemDecodeError)

    expect(() =>
      registry.encodeItem({
        type: 'application',
        itemType: ARTICLE_PLUGIN_ID,
        value: { schemaVersion: 1 },
      }),
    ).toThrow(MessageItemEncodeError)
  })

  it('estimates reading time deterministically', () => {
    expect(estimateArticleReadingMinutes('Short body')).toBe(1)
    const fourHundredWords = Array.from({ length: 400 }, () => 'word').join(' ')
    expect(estimateArticleReadingMinutes(fourHundredWords)).toBe(2)
    const fourHundredAndOneWords = Array.from(
      { length: 401 },
      () => 'word',
    ).join(' ')
    expect(estimateArticleReadingMinutes(fourHundredAndOneWords)).toBe(3)
  })
})

describe('deterministic safe Markdown parser and HTML renderer', () => {
  it('parses headings with deterministic deduplicated slug IDs, lists, task lists, code blocks, blockquotes, and tables', () => {
    const blocks = parseArticleMarkdown(
      [
        '# Heading One',
        '## Heading One',
        '### Sub-Section!',
        '',
        'Paragraph with **bold**, *italic*, `code`, and ~~strike~~.',
        '',
        '- [x] Done task',
        '- [ ] Pending task',
        '',
        '| Left | Center | Right |',
        '| :--- | :---: | ---: |',
        '| A | B | C |',
      ].join('\n'),
    )

    expect(blocks[0]).toMatchObject({
      type: 'heading',
      level: 1,
      id: 'heading-heading-one',
      text: 'Heading One',
    })
    expect(blocks[1]).toMatchObject({
      type: 'heading',
      level: 2,
      id: 'heading-heading-one-2',
      text: 'Heading One',
    })
    expect(blocks[2]).toMatchObject({
      type: 'heading',
      level: 3,
      id: 'heading-sub-section',
      text: 'Sub-Section!',
    })
    expect(blocks[4]).toMatchObject({
      type: 'list',
      ordered: false,
      items: [
        { checked: true, inlines: [{ type: 'text', text: 'Done task' }] },
        { checked: false, inlines: [{ type: 'text', text: 'Pending task' }] },
      ],
    })
    expect(blocks[5]).toMatchObject({
      type: 'table',
      alignments: ['left', 'center', 'right'],
    })
  })

  it('neutralizes XSS payloads, dangerous URL schemes, and external image beacons', () => {
    expect(sanitizeArticleUrl('https://frank.cash/article')).toBe(
      'https://frank.cash/article',
    )
    expect(sanitizeArticleUrl('http://example.com/path')).toBe(
      'http://example.com/path',
    )
    expect(sanitizeArticleUrl('mailto:team@frank.cash')).toBe(
      'mailto:team@frank.cash',
    )
    expect(sanitizeArticleUrl('javascript:alert(1)')).toBeNull()
    expect(sanitizeArticleUrl('JAVASCRIPT:alert(1)')).toBeNull()
    expect(
      sanitizeArticleUrl('data:text/html,<script>alert(1)</script>'),
    ).toBeNull()
    expect(sanitizeArticleUrl('vbscript:msgbox(1)')).toBeNull()
    expect(sanitizeArticleUrl('file:///etc/passwd')).toBeNull()
    expect(sanitizeArticleUrl('https://user:pass@example.com/')).toBeNull()

    const hostile = [
      '# <script>alert("xss")</script>',
      '',
      '<iframe src="https://evil.example"></iframe>',
      '<img src="x" onerror="alert(1)" />',
      '',
      'Click [bad js](javascript:alert(1)) or [bad data](data:text/html,evil) or [bad vb](vbscript:boom) or [bad file](file:///etc/hosts).',
      '',
      '![beacon](https://evil.example/tracker.png)',
    ].join('\n')

    const html = renderArticleMarkdownToHtml(hostile)
    expect(html).not.toContain('<script')
    expect(html).not.toContain('<iframe')
    expect(html).not.toContain('<img')
    expect(html).not.toContain('javascript:')
    expect(html).not.toContain('data:text/html')
    expect(html).not.toContain('vbscript:')
    expect(html).not.toContain('file:')
    expect(html).toContain('&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;')
    expect(html).toContain('&lt;img src=&quot;x&quot; onerror=&quot;alert(1)&quot; /&gt;')
    expect(html).toContain('Click bad js or bad data or bad vb or bad file.')
    expect(html).toContain('[Image: beacon]')
  })

  it('handles broken tables and bidirectional text gracefully', () => {
    const bidiAndBrokenTable = [
      '# مرحبا بالعالم — שלום עולם — Hello',
      '',
      'Mixed RTL/LTR paragraph: مرحبا **Frank** שלום.',
      '',
      '| Unclosed table header without separator |',
      'Plain line after non-table pipe.',
      '',
      '| Col 1 | Col 2 | Col 3 |',
      '| --- | --- | --- |',
      '| Short row |',
    ].join('\n')

    const blocks = parseArticleMarkdown(bidiAndBrokenTable)
    expect(blocks[0]).toMatchObject({
      type: 'heading',
      level: 1,
    })
    const tableBlock = blocks.find(b => b.type === 'table')
    expect(tableBlock).toBeDefined()
    if (tableBlock?.type === 'table') {
      expect(tableBlock.headers).toHaveLength(3)
      expect(tableBlock.rows[0]).toHaveLength(3)
    }
  })
})
