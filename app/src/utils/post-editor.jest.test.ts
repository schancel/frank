/** @jest-environment jsdom */
import {
  applyMarkdownFormat,
  insertImageMarkdown,
  calculateTargetDimensions,
  drawToCanvas,
  canvasToDataUrl,
  compressImageElement,
  compressPostImage,
  expandAttachmentTokens,
  tokenizeAttachmentDataUrls,
  formatAttachmentSize,
  type PostAttachment,
} from './post-editor'

describe('post-editor utilities', () => {
  describe('applyMarkdownFormat', () => {
    it('wraps selected text in bold', () => {
      const result = applyMarkdownFormat('Hello world', 6, 11, 'bold')
      expect(result.text).toBe('Hello **world**')
      expect(result.selectionStart).toBe(8)
      expect(result.selectionEnd).toBe(13)
    })

    it('inserts default bold placeholder when nothing is selected', () => {
      const result = applyMarkdownFormat('Hello ', 6, 6, 'bold')
      expect(result.text).toBe('Hello **bold text**')
      expect(result.selectionStart).toBe(8)
      expect(result.selectionEnd).toBe(17)
    })

    it('wraps selected text in italic', () => {
      const result = applyMarkdownFormat('Hello world', 0, 5, 'italic')
      expect(result.text).toBe('*Hello* world')
      expect(result.selectionStart).toBe(1)
      expect(result.selectionEnd).toBe(6)
    })

    it('inserts default italic placeholder when nothing is selected', () => {
      const result = applyMarkdownFormat('', 0, 0, 'italic')
      expect(result.text).toBe('*italic text*')
      expect(result.selectionStart).toBe(1)
      expect(result.selectionEnd).toBe(12)
    })

    it('inserts heading at start of text', () => {
      const result = applyMarkdownFormat('Title', 0, 5, 'heading')
      expect(result.text).toBe('### Title')
      expect(result.selectionStart).toBe(4)
      expect(result.selectionEnd).toBe(9)
    })

    it('inserts heading with leading newline if not at start of line', () => {
      const result = applyMarkdownFormat('Intro text', 10, 10, 'heading')
      expect(result.text).toBe('Intro text\n### Heading')
    })

    it('inserts blockquote with leading newline if in middle', () => {
      const result = applyMarkdownFormat('Intro', 5, 5, 'quote')
      expect(result.text).toBe('Intro\n> Quote')
    })

    it('wraps single-line text in inline code backticks', () => {
      const result = applyMarkdownFormat('const a = 1', 6, 11, 'code')
      expect(result.text).toBe('const `a = 1`')
      expect(result.selectionStart).toBe(7)
      expect(result.selectionEnd).toBe(12)
    })

    it('wraps multi-line text in fenced code block', () => {
      const multiline = 'line 1\nline 2'
      const result = applyMarkdownFormat(multiline, 0, multiline.length, 'code')
      expect(result.text).toBe('```\nline 1\nline 2\n```\n')
    })

    it('inserts bullet list prefix', () => {
      const result = applyMarkdownFormat('item', 0, 4, 'bullet')
      expect(result.text).toBe('- item')
    })

    it('formats markdown link with custom url', () => {
      const result = applyMarkdownFormat('Google', 0, 6, 'link', {
        url: 'https://google.com',
      })
      expect(result.text).toBe('[Google](https://google.com)')
    })

    it('formats markdown image with custom alt and url', () => {
      const result = applyMarkdownFormat('', 0, 0, 'image', {
        alt: 'screenshot',
        url: 'https://example.com/pic.png',
      })
      expect(result.text).toBe('![screenshot](https://example.com/pic.png)\n')
    })

    describe('formatting toggles (unbold, unitalic, etc.)', () => {
      it('unbolds when clicking bold on selected text surrounded by **', () => {
        // user selected "world" in "Hello **world**"
        const result = applyMarkdownFormat('Hello **world**', 8, 13, 'bold')
        expect(result.text).toBe('Hello world')
        expect(result.selectionStart).toBe(6)
        expect(result.selectionEnd).toBe(11)
      })

      it('unbolds when the selection includes the asterisks', () => {
        // user selected "**world**"
        const result = applyMarkdownFormat('Hello **world**', 6, 15, 'bold')
        expect(result.text).toBe('Hello world')
        expect(result.selectionStart).toBe(6)
        expect(result.selectionEnd).toBe(11)
      })

      it('unbolds when cursor is collapsed inside bold text', () => {
        // cursor is inside "**wo|rld**"
        const result = applyMarkdownFormat('Hello **world**', 10, 10, 'bold')
        expect(result.text).toBe('Hello world')
        expect(result.selectionStart).toBe(8)
        expect(result.selectionEnd).toBe(8)
      })

      it('toggles bold twice back to unbolded text', () => {
        // 1st click
        const first = applyMarkdownFormat('', 0, 0, 'bold')
        expect(first.text).toBe('**bold text**')
        // 2nd click on the resulting selection
        const second = applyMarkdownFormat(
          first.text,
          first.selectionStart,
          first.selectionEnd,
          'bold',
        )
        expect(second.text).toBe('bold text')
      })

      it('unitalics when clicking italic on selected text surrounded by *', () => {
        const result = applyMarkdownFormat('Hello *world*', 7, 12, 'italic')
        expect(result.text).toBe('Hello world')
        expect(result.selectionStart).toBe(6)
        expect(result.selectionEnd).toBe(11)
      })

      it('does not confuse bold with italic when checking *', () => {
        // Clicking italic on bold text should wrap it in *, not unwrap bold
        const result = applyMarkdownFormat('**bold**', 2, 6, 'italic')
        expect(result.text).toBe('***bold***')
      })

      it('uncodes inline code when already wrapped in backticks', () => {
        const result = applyMarkdownFormat('`code`', 1, 5, 'code')
        expect(result.text).toBe('code')
      })

      it('uncodes multi-line fenced code block when selected', () => {
        const fenced = '```\nline 1\nline 2\n```'
        const result = applyMarkdownFormat(fenced, 0, fenced.length, 'code')
        expect(result.text).toBe('line 1\nline 2')
      })

      it('toggles off heading prefix when line already starts with ###', () => {
        const result = applyMarkdownFormat('### Title', 0, 9, 'heading')
        expect(result.text).toBe('Title')
      })

      it('toggles off quote prefix when line already starts with >', () => {
        const result = applyMarkdownFormat('> Quote line', 0, 12, 'quote')
        expect(result.text).toBe('Quote line')
      })

      it('toggles off bullet list prefix when line already starts with -', () => {
        const result = applyMarkdownFormat('- List item', 0, 11, 'bullet')
        expect(result.text).toBe('List item')
      })
    })
  })

  describe('insertImageMarkdown', () => {
    it('inserts image markdown with clean spacing and sanitized alt', () => {
      const result = insertImageMarkdown(
        'Some text before',
        16,
        16,
        '[bracketed-name]',
        'data:image/jpeg;base64,1234',
      )
      expect(result.text).toBe(
        'Some text before\n![bracketed-name](data:image/jpeg;base64,1234)\n',
      )
    })

    it('inserts image markdown in empty text without extra leading newline', () => {
      const result = insertImageMarkdown(
        '',
        0,
        0,
        'photo',
        'https://example.com/cat.jpg',
      )
      expect(result.text).toBe('![photo](https://example.com/cat.jpg)\n')
    })
  })

  describe('calculateTargetDimensions', () => {
    it('preserves dimensions when within maxDimension', () => {
      expect(calculateTargetDimensions(500, 300, 800)).toEqual({
        width: 500,
        height: 300,
      })
    })

    it('scales down wider images maintaining aspect ratio', () => {
      expect(calculateTargetDimensions(1600, 800, 800)).toEqual({
        width: 800,
        height: 400,
      })
    })

    it('scales down taller images maintaining aspect ratio', () => {
      expect(calculateTargetDimensions(600, 1200, 800)).toEqual({
        width: 400,
        height: 800,
      })
    })

    it('handles zero or negative dimensions safely', () => {
      expect(calculateTargetDimensions(0, -10, 800)).toEqual({
        width: 800,
        height: 800,
      })
    })
  })

  describe('canvas and compression helpers', () => {
    let getContextSpy: jest.SpyInstance

    beforeEach(() => {
      const mockCtx = {
        drawImage: jest.fn(),
        fillRect: jest.fn(),
        fillStyle: '',
      }
      getContextSpy = jest
        .spyOn(HTMLCanvasElement.prototype, 'getContext')
        .mockReturnValue(mockCtx as any)
    })

    afterEach(() => {
      getContextSpy.mockRestore()
    })

    it('draws image to canvas', () => {
      const canvas = document.createElement('canvas')
      canvas.width = 100
      canvas.height = 100
      const drawn = drawToCanvas(canvas, 50, 50)
      expect(drawn.width).toBe(50)
      expect(drawn.height).toBe(50)
    })

    it('exports canvas to data url under byte limit', () => {
      const canvas = document.createElement('canvas')
      canvas.width = 10
      canvas.height = 10
      const originalToDataURL = canvas.toDataURL
      canvas.toDataURL = jest.fn(() => 'data:image/webp;base64,AAAA')
      const result = canvasToDataUrl(canvas, 1000, 0.8)
      expect(result).toBe('data:image/webp;base64,AAAA')
      canvas.toDataURL = originalToDataURL
    })

    it('compresses an image element using step-downs', () => {
      const img = new Image()
      img.width = 1200
      img.height = 900
      const mockCanvas = document.createElement('canvas')
      jest
        .spyOn(document, 'createElement')
        .mockImplementation((tag: string) => {
          if (tag === 'canvas') {
            const c = mockCanvas
            c.toDataURL = jest.fn(
              () => 'data:image/jpeg;base64,' + 'B'.repeat(500),
            )
            return c
          }
          return document.createElement(tag)
        })

      const dataUrl = compressImageElement(img, { maxBytes: 5000 })
      expect(dataUrl).toContain('data:image/jpeg;base64,')
      jest.restoreAllMocks()
    })
  })

  describe('compressPostImage', () => {
    it('rejects files that are not images', async () => {
      const textFile = new File(['hello'], 'test.txt', { type: 'text/plain' })
      await expect(compressPostImage(textFile)).rejects.toThrow(
        'File is not a valid image',
      )
    })

    it('resolves fast if raw data URL is already under small limit', async () => {
      const smallPng = new File(['fake-png-bytes'], 'small.png', {
        type: 'image/png',
      })
      const result = await compressPostImage(smallPng, { maxBytes: 100_000 })
      expect(result.name).toBe('small.png')
      expect(result.dataUrl).toContain('data:image/png;')
    })
  })

  describe('formatAttachmentSize', () => {
    it('formats bytes under 1 KB', () => {
      expect(formatAttachmentSize(500)).toBe('500 B')
    })

    it('formats bytes in kilobytes', () => {
      expect(formatAttachmentSize(45 * 1024)).toBe('45.0 KB')
      expect(formatAttachmentSize(45.5 * 1024)).toBe('45.5 KB')
    })

    it('formats bytes in megabytes', () => {
      expect(formatAttachmentSize(2.5 * 1024 * 1024)).toBe('2.5 MB')
    })
  })

  describe('expandAttachmentTokens', () => {
    it('returns text unchanged if no attachments or empty text', () => {
      expect(expandAttachmentTokens('', [])).toBe('')
      expect(expandAttachmentTokens('Hello world', [])).toBe('Hello world')
    })

    it('expands attachment tokens to full data URIs', () => {
      const attachments: PostAttachment[] = [
        {
          id: '1',
          name: 'photo.jpg',
          dataUrl: 'data:image/jpeg;base64,PHOTO_DATA',
          sizeBytes: 100,
        },
        {
          id: '2',
          name: 'diagram.png',
          dataUrl: 'data:image/png;base64,DIAGRAM_DATA',
          sizeBytes: 200,
        },
      ]
      const text =
        'Here is ![photo](attachment:1) and ![diagram](attachment:2).'
      const expanded = expandAttachmentTokens(text, attachments)
      expect(expanded).toBe(
        'Here is ![photo](data:image/jpeg;base64,PHOTO_DATA) and ![diagram](data:image/png;base64,DIAGRAM_DATA).',
      )
    })

    it('leaves unmatched attachment tokens intact', () => {
      const attachments: PostAttachment[] = [
        {
          id: '1',
          name: 'photo.jpg',
          dataUrl: 'data:image/jpeg;base64,PHOTO_DATA',
          sizeBytes: 100,
        },
      ]
      const text = 'Unknown ![missing](attachment:999)'
      expect(expandAttachmentTokens(text, attachments)).toBe(text)
    })
  })

  describe('tokenizeAttachmentDataUrls', () => {
    it('replaces data:image markdown with attachment tokens and returns attachments list', () => {
      const input =
        'Look at this: ![cat](data:image/png;base64,QUJD) and ![dog](data:image/jpeg;base64,REVGRw==)'
      const result = tokenizeAttachmentDataUrls(input)

      expect(result.text).toBe(
        'Look at this: ![cat](attachment:1) and ![dog](attachment:2)',
      )
      expect(result.attachments).toHaveLength(2)
      expect(result.attachments[0]).toEqual({
        id: '1',
        name: 'cat',
        dataUrl: 'data:image/png;base64,QUJD',
        sizeBytes: expect.any(Number),
      })
      expect(result.attachments[1]).toEqual({
        id: '2',
        name: 'dog',
        dataUrl: 'data:image/jpeg;base64,REVGRw==',
        sizeBytes: expect.any(Number),
      })
    })

    it('deduplicates existing attachments and increments ID from existing maximum', () => {
      const existing: PostAttachment[] = [
        {
          id: '3',
          name: 'existing.png',
          dataUrl: 'data:image/png;base64,EXISTING',
          sizeBytes: 50,
        },
      ]
      const input =
        'Existing: ![existing.png](data:image/png;base64,EXISTING) New: ![new](data:image/jpeg;base64,NEWDATA)'
      const result = tokenizeAttachmentDataUrls(input, existing)

      expect(result.text).toBe(
        'Existing: ![existing.png](attachment:3) New: ![new](attachment:4)',
      )
      expect(result.attachments).toHaveLength(2)
      expect(result.attachments[1].id).toBe('4')
    })
  })
})
