/**
 * @jest-environment jsdom
 *
 * Unit tests for `utils/markdown.ts` -- chat-message markdown rendering + sanitization. This is
 * the one thing between another user's message text and `v-html` in `ChatMessage.vue`/
 * `ForumMessage.vue`, so the XSS-stripping behavior (not just the happy-path rendering) is worth
 * locking down explicitly, not just implicitly trusted via DOMPurify's own test suite.
 *
 * Needs the jsdom environment explicitly: this project's jest config sets no default
 * `testEnvironment` (jest defaults to "node"), and both DOMPurify and Quasar's `getPaletteColor`
 * need a real `window`/`document` -- confirmed live, both throw under the default node environment
 * (`DOMPurify.sanitize is not a function`, `getPaletteColor` reading computed CSS custom
 * properties). No other test in this suite exercises `renderMarkdown`/`purify` today, so there was
 * no existing pattern to match.
 *
 * `quasar`'s `colors.getPaletteColor` is mocked: it resolves real theme CSS custom properties,
 * which aren't present without Quasar's own stylesheet mounted (confirmed live -- unmocked, it
 * returns "#000000" for every palette name in this bare jsdom environment, making the dark-mode
 * link-color test meaningless). The mock isolates the one thing `renderMarkdown` actually controls
 * -- which palette name it asks for -- from Quasar's real color resolution, which is out of scope
 * for this file's own tests.
 */
import DOMPurify from 'dompurify'
import { renderMarkdown, purify, clearMarkdownCache } from './markdown'

jest.mock('quasar', () => ({
  colors: {
    getPaletteColor: jest.fn((name: string) => `mock-color(${name})`),
  },
}))

describe('renderMarkdown', () => {
  beforeEach(() => {
    clearMarkdownCache()
    jest.clearAllMocks()
  })

  it('renders basic markdown to HTML', () => {
    expect(renderMarkdown('**bold** and *italic*', false)).toContain(
      '<strong>bold</strong>',
    )
    expect(renderMarkdown('**bold** and *italic*', false)).toContain(
      '<em>italic</em>',
    )
  })

  it('renders links with target="_blank" and an inline color style', () => {
    const html = renderMarkdown('[click me](https://example.com)', false)
    expect(html).toContain('target="_blank"')
    expect(html).toContain('href="https://example.com"')
    expect(html).toContain('style="color: mock-color(blue)"')
  })

  it('asks for the "blue" palette in light mode and "blue-2" in dark mode', () => {
    const lightHtml = renderMarkdown('[x](https://example.com)', false)
    const darkHtml = renderMarkdown('[x](https://example.com)', true)
    expect(lightHtml).toContain('style="color: mock-color(blue)"')
    expect(darkHtml).toContain('style="color: mock-color(blue-2)"')
  })

  it('wraps blockquotes in a styled div instead of a bare <blockquote>', () => {
    const html = renderMarkdown('> quoted text', false)
    expect(html).toContain('class="quote"')
    expect(html).not.toContain('<blockquote>')
  })

  it('strips a raw <script> tag entirely', () => {
    const html = renderMarkdown('<script>alert(1)</script>', false)
    expect(html).not.toContain('<script')
    expect(html).not.toContain('alert(1)')
  })

  it('strips an inline event handler from raw HTML input', () => {
    const html = renderMarkdown('<img src=x onerror="alert(1)">', false)
    expect(html).not.toContain('onerror')
  })

  it('strips a javascript: URL rendered as a markdown link', () => {
    const html = renderMarkdown('[click me](javascript:alert(1))', false)
    expect(html.toLowerCase()).not.toContain('javascript:')
  })

  it('returns exact same HTML on cache hits', () => {
    const input = 'hello **world** [link](https://example.com)'
    const first = renderMarkdown(input, false)
    const second = renderMarkdown(input, false)
    expect(first).toBe(second)
  })

  it('proves DOMPurify.sanitize is only called once for repeated inputs', () => {
    const sanitizeSpy = jest.spyOn(DOMPurify, 'sanitize')
    const input = 'repeated **markdown** content'

    const first = renderMarkdown(input, false)
    expect(sanitizeSpy).toHaveBeenCalledTimes(1)

    const second = renderMarkdown(input, false)
    expect(second).toBe(first)
    expect(sanitizeSpy).toHaveBeenCalledTimes(1)

    sanitizeSpy.mockRestore()
  })

  it('produces distinct cache entries for different linkColor boolean values', () => {
    const sanitizeSpy = jest.spyOn(DOMPurify, 'sanitize')
    const input = '[click](https://example.com)'

    const light = renderMarkdown(input, false)
    const dark = renderMarkdown(input, true)

    expect(light).toContain('style="color: mock-color(blue)"')
    expect(dark).toContain('style="color: mock-color(blue-2)"')
    expect(light).not.toBe(dark)
    expect(sanitizeSpy).toHaveBeenCalledTimes(2)

    const lightCached = renderMarkdown(input, false)
    const darkCached = renderMarkdown(input, true)

    expect(lightCached).toBe(light)
    expect(darkCached).toBe(dark)
    expect(sanitizeSpy).toHaveBeenCalledTimes(2)

    sanitizeSpy.mockRestore()
  })

  it('evicts the oldest entry when cache capacity exceeds 1000 entries', () => {
    const sanitizeSpy = jest.spyOn(DOMPurify, 'sanitize')

    renderMarkdown('oldest-entry', false)
    expect(sanitizeSpy).toHaveBeenCalledTimes(1)

    for (let i = 1; i <= 1000; i++) {
      renderMarkdown(`entry-${i}`, false)
    }
    expect(sanitizeSpy).toHaveBeenCalledTimes(1001)

    // 'oldest-entry' was evicted, so rendering it again is a cache miss
    sanitizeSpy.mockClear()
    renderMarkdown('oldest-entry', false)
    expect(sanitizeSpy).toHaveBeenCalledTimes(1)

    // 'entry-1000' is still cached, so rendering it is a cache hit
    sanitizeSpy.mockClear()
    renderMarkdown('entry-1000', false)
    expect(sanitizeSpy).toHaveBeenCalledTimes(0)

    sanitizeSpy.mockRestore()
  })
})

describe('purify', () => {
  it('leaves plain text untouched', () => {
    expect(purify('just some plain text')).toBe('just some plain text')
  })

  it('strips a raw <script> tag', () => {
    const result = purify('hello <script>alert(1)</script> world')
    expect(result).not.toContain('<script')
    expect(result).not.toContain('alert(1)')
  })

  it('strips an inline event handler', () => {
    const result = purify('<img src=x onerror="alert(1)">')
    expect(result).not.toContain('onerror')
  })
})

describe('renderMarkdown line breaks', () => {
  const help = '**Commands**\n\n• `/join` - Join a room\n• `/leave` - Leave it'

  it('keeps single newlines as line breaks when asked to (chat messages)', () => {
    clearMarkdownCache()
    const html = renderMarkdown(help, false, true)
    expect(html).toContain('<br>')
    expect(html.match(/<br>/g)).toHaveLength(1)
    expect(html).toContain('<code>/join</code>')
  })

  it('joins them into one paragraph by default (posts, email)', () => {
    clearMarkdownCache()
    expect(renderMarkdown(help, false)).not.toContain('<br>')
  })

  it('caches the two renderings of the same text separately', () => {
    clearMarkdownCache()
    const withBreaks = renderMarkdown(help, false, true)
    const without = renderMarkdown(help, false)
    expect(withBreaks).not.toBe(without)
    expect(renderMarkdown(help, false, true)).toBe(withBreaks)
  })

  it('still sanitizes with line breaks on', () => {
    clearMarkdownCache()
    const html = renderMarkdown('a\n<img src=x onerror=alert(1)>', false, true)
    expect(html).not.toContain('onerror')
  })
})

describe('content that may fetch nothing (a direct message)', () => {
  const picture = 'data:image/png;base64,AAAA'
  const other = 'data:image/png;base64,BBBB'
  beforeEach(() => clearMarkdownCache())

  /** Every element of the rendered HTML that names a resource to load. */
  const sources = (html: string) => {
    const box = document.createElement('div')
    box.innerHTML = html
    return Array.from(box.querySelectorAll('*')).flatMap(el =>
      ['src', 'srcset', 'poster', 'background', 'style']
        .map(name => el.getAttribute(name))
        .filter((value): value is string => value !== null),
    )
  }

  it('shows a listed picture where the Markdown has it', () => {
    const html = renderMarkdown(`a ![cat](${picture}) b`, false, true, [
      picture,
    ])
    expect(html).toContain(`<img alt="cat" src="${picture}">`)
  })

  it('writes a remote Markdown image as a link and fetches nothing', () => {
    const html = renderMarkdown(
      'look ![cat](https://evil.example/t.png?id=1)',
      false,
      true,
      [picture],
    )
    expect(html).not.toContain('<img')
    expect(html).toContain('href="https://evil.example/t.png?id=1"')
    expect(html).toContain('>cat</a>')
  })

  it('writes a data URI that is not a listed picture, or any other scheme, as text', () => {
    const html = renderMarkdown(
      `![a](${other}) ![b](attachment:3) ![c](ipfs://x)`,
      false,
      true,
      [picture],
    )
    expect(html).not.toContain('<img')
    expect(html).toContain(`![a](${other})`)
    expect(html).toContain('![b](attachment:3)')
    expect(html).toContain('![c](ipfs://x)')
  })

  it('escapes what it writes back as text', () => {
    const html = renderMarkdown('![x](attachment:"><b>)', false, true, [])
    expect(html).not.toContain('<b>')
  })

  it.each([
    '<img src="https://evil.example/t.png">',
    '<img src="//evil.example/t.png">',
    `<img src="${other}">`,
    '<image src="https://evil.example/t.png">',
    `<img src="${picture}" srcset="https://evil.example/t.png 2x">`,
    '<video src="https://evil.example/v.mp4" poster="https://evil.example/p.png"></video>',
    '<audio src="https://evil.example/a.mp3"></audio>',
    '<picture><source srcset="https://evil.example/t.png"><img src="https://evil.example/u.png"></picture>',
    '<input type="image" src="https://evil.example/t.png">',
    '<table background="https://evil.example/t.png"><tr><td>x</td></tr></table>',
    '<div style="background-image: url(https://evil.example/t.png)">x</div>',
    '<style>body { background: url(https://evil.example/t.png) }</style>x',
    '<svg><image href="https://evil.example/t.png" /></svg>',
  ])('raw HTML cannot load anything either: %s', raw => {
    for (const html of [
      renderMarkdown(`hello\n\n${raw}`, false, true, [picture]),
      purify(raw, [picture]),
    ]) {
      expect(sources(html).filter(value => value !== picture)).toEqual([])
      expect(html).not.toContain('evil.example')
    }
  })

  it('keeps the link colour and the quote bar it writes itself', () => {
    const html = renderMarkdown('[a](https://x.example)\n\n> q', true, true, [])
    expect(html).toContain('style="color: mock-color(blue-2)"')
    expect(html).toContain('border-left: 2px solid')
  })

  it('leaves the next rendering of other content as it was (posts, email)', () => {
    renderMarkdown('![x](https://a.example/x.png)', false, true, [])
    const html = renderMarkdown('![x](https://a.example/x.png)', false)
    expect(html).toContain('src="https://a.example/x.png"')
    expect(purify('<img src="https://a.example/x.png">')).toContain('<img')
  })
})
