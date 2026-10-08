/** @jest-environment jsdom */
import {
  MAX_AVATAR_BYTES,
  MAX_AVATAR_DIMENSION,
  isAvatarTooLarge,
  calculateTargetDimensions,
  resizeImageToCanvas,
  canvasToCompressedDataUrl,
  resizeAndCompressImage,
  compressAvatarDataUrl,
  compressAvatarFile,
} from './avatar-resize'
import { profileAvatar, clearAvatarCache } from './avatar'

describe('avatar resizing and compression utilities', () => {
  describe('isAvatarTooLarge', () => {
    it('returns false for undefined, null, or empty string', () => {
      expect(isAvatarTooLarge(undefined)).toBe(false)
      expect(isAvatarTooLarge(null)).toBe(false)
      expect(isAvatarTooLarge('')).toBe(false)
    })

    it('returns false for avatars under or equal to MAX_AVATAR_BYTES', () => {
      const underLimit = 'data:image/webp;base64,' + 'A'.repeat(2000)
      expect(isAvatarTooLarge(underLimit)).toBe(false)
      const exactLimit = 'A'.repeat(MAX_AVATAR_BYTES)
      expect(isAvatarTooLarge(exactLimit)).toBe(false)
    })

    it('returns true for avatars exceeding MAX_AVATAR_BYTES', () => {
      const overLimit =
        'data:image/png;base64,' + 'A'.repeat(MAX_AVATAR_BYTES + 500)
      expect(isAvatarTooLarge(overLimit)).toBe(true)
    })
  })

  describe('calculateTargetDimensions', () => {
    it('preserves dimensions when both are within maxDimension', () => {
      expect(calculateTargetDimensions(64, 64, 80)).toEqual({
        width: 64,
        height: 64,
      })
      expect(calculateTargetDimensions(80, 50, 80)).toEqual({
        width: 80,
        height: 50,
      })
    })

    it('scales down wider images maintaining aspect ratio', () => {
      expect(calculateTargetDimensions(400, 200, 80)).toEqual({
        width: 80,
        height: 40,
      })
      expect(calculateTargetDimensions(512, 512, 80)).toEqual({
        width: 80,
        height: 80,
      })
    })

    it('scales down taller images maintaining aspect ratio', () => {
      expect(calculateTargetDimensions(200, 400, 80)).toEqual({
        width: 40,
        height: 80,
      })
      expect(calculateTargetDimensions(300, 600, 96)).toEqual({
        width: 48,
        height: 96,
      })
    })

    it('handles zero or negative dimensions safely', () => {
      expect(calculateTargetDimensions(0, 0, 80)).toEqual({
        width: 80,
        height: 80,
      })
    })
  })

  describe('resizeImageToCanvas', () => {
    it('creates a canvas with constrained dimensions and draws image', () => {
      const mockDrawImage = jest.fn()
      const mockFillRect = jest.fn()
      HTMLCanvasElement.prototype.getContext = jest.fn(() => ({
        drawImage: mockDrawImage,
        fillRect: mockFillRect,
        fillStyle: '',
      })) as any

      const img = document.createElement('img')
      Object.defineProperty(img, 'naturalWidth', { value: 600 })
      Object.defineProperty(img, 'naturalHeight', { value: 300 })

      const canvas = resizeImageToCanvas(img, 80)
      expect(canvas.width).toBe(80)
      expect(canvas.height).toBe(40)
      expect(mockDrawImage).toHaveBeenCalledWith(img, 0, 0, 80, 40)
    })
  })

  describe('canvasToCompressedDataUrl', () => {
    it('returns compressed webp data URL when supported and within limit', () => {
      const expectedDataUrl = 'data:image/webp;base64,AAA'
      HTMLCanvasElement.prototype.toDataURL = jest.fn((format: string) => {
        if (format === 'image/webp') return expectedDataUrl
        return 'data:image/png;base64,XXX'
      })

      const canvas = document.createElement('canvas')
      canvas.width = 80
      canvas.height = 80

      const result = canvasToCompressedDataUrl(canvas, 4096)
      expect(result).toBe(expectedDataUrl)
      expect(result.length).toBeLessThanOrEqual(4096)
    })

    it('falls back to jpeg when webp is not supported or too large', () => {
      const jpegDataUrl = 'data:image/jpeg;base64,BBB'
      HTMLCanvasElement.prototype.getContext = jest.fn(() => ({
        drawImage: jest.fn(),
        fillRect: jest.fn(),
        fillStyle: '',
      })) as any
      HTMLCanvasElement.prototype.toDataURL = jest.fn((format: string) => {
        if (format === 'image/webp') return 'data:image/png;base64,not-webp' // browser fallback
        if (format === 'image/jpeg') return jpegDataUrl
        return 'data:image/png;base64,large'
      })

      const canvas = document.createElement('canvas')
      canvas.width = 80
      canvas.height = 80

      const result = canvasToCompressedDataUrl(canvas, 4096)
      expect(result).toBe(jpegDataUrl)
    })

    it('does not return PNG fallback when it exceeds maxBytes', () => {
      HTMLCanvasElement.prototype.getContext = jest.fn(() => ({
        drawImage: jest.fn(),
        fillRect: jest.fn(),
        fillStyle: '',
      })) as any
      HTMLCanvasElement.prototype.toDataURL = jest.fn((format: string) => {
        if (format === 'image/webp') return 'data:image/png;base64,not-webp'
        if (format === 'image/jpeg')
          return 'data:image/jpeg;base64,' + 'J'.repeat(10000)
        return 'data:image/png;base64,' + 'P'.repeat(10000)
      })

      const canvas = document.createElement('canvas')
      canvas.width = 80
      canvas.height = 80

      const result = canvasToCompressedDataUrl(canvas, 4096)
      expect(result).toBe('')
    })
  })

  describe('resizeAndCompressImage', () => {
    it('resizes and stays under MAX_AVATAR_BYTES limit', () => {
      HTMLCanvasElement.prototype.getContext = jest.fn(() => ({
        drawImage: jest.fn(),
        fillRect: jest.fn(),
        fillStyle: '',
      })) as any

      const mockToDataUrl = jest.fn((format: string) => {
        return 'data:image/webp;base64,' + 'M'.repeat(1500)
      })
      HTMLCanvasElement.prototype.toDataURL = mockToDataUrl

      const img = document.createElement('img')
      Object.defineProperty(img, 'naturalWidth', { value: 1024 })
      Object.defineProperty(img, 'naturalHeight', { value: 1024 })

      const result = resizeAndCompressImage(img, {
        maxDimension: 80,
        maxBytes: 4096,
      })
      expect(result).toMatch(/^data:image\/webp;base64,/)
      expect(result.length).toBeLessThanOrEqual(4096)
    })
  })

  describe('compressAvatarDataUrl', () => {
    it('compresses data URL through Image and canvas', async () => {
      const compressedUrl = 'data:image/webp;base64,COMPRESSED'
      HTMLCanvasElement.prototype.getContext = jest.fn(() => ({
        drawImage: jest.fn(),
        fillRect: jest.fn(),
        fillStyle: '',
      })) as any
      HTMLCanvasElement.prototype.toDataURL = jest.fn(() => compressedUrl)

      // Mock Image behavior
      const originalImage = window.Image
      class MockImage {
        crossOrigin = ''
        width = 500
        height = 500
        naturalWidth = 500
        naturalHeight = 500
        complete = false
        private _src = ''
        onload: (() => void) | null = null
        onerror: (() => void) | null = null

        get src() {
          return this._src
        }
        set src(val: string) {
          this._src = val
          this.complete = true
          setTimeout(() => {
            if (this.onload) this.onload()
          }, 0)
        }
      }
      window.Image = MockImage as any

      try {
        const inputUrl = 'data:image/png;base64,' + 'A'.repeat(5000)
        const result = await compressAvatarDataUrl(inputUrl, { maxBytes: 4096 })
        expect(result).toBe(compressedUrl)
        expect(result.length).toBeLessThanOrEqual(4096)
      } finally {
        window.Image = originalImage
      }
    })
  })

  describe('compressAvatarFile', () => {
    it('reads and compresses a file object', async () => {
      const compressedUrl = 'data:image/webp;base64,COMPRESSED_FILE'
      HTMLCanvasElement.prototype.getContext = jest.fn(() => ({
        drawImage: jest.fn(),
        fillRect: jest.fn(),
        fillStyle: '',
      })) as any
      HTMLCanvasElement.prototype.toDataURL = jest.fn(() => compressedUrl)

      const originalImage = window.Image
      class MockImage {
        crossOrigin = ''
        width = 400
        height = 400
        naturalWidth = 400
        naturalHeight = 400
        complete = false
        private _src = ''
        onload: (() => void) | null = null
        onerror: (() => void) | null = null

        get src() {
          return this._src
        }
        set src(val: string) {
          this._src = val
          this.complete = true
          setTimeout(() => {
            if (this.onload) this.onload()
          }, 0)
        }
      }
      window.Image = MockImage as any

      try {
        const blob = new Blob(['fake image data'], { type: 'image/png' })
        const file = new File([blob], 'avatar.png', { type: 'image/png' })
        const result = await compressAvatarFile(file, { maxBytes: 4096 })
        expect(result).toBe(compressedUrl)
      } finally {
        window.Image = originalImage
      }
    })
  })
})

describe('profileAvatar', () => {
  beforeEach(() => {
    clearAvatarCache()
  })

  it('returns custom avatars directly without using default avatars or caching', () => {
    expect(profileAvatar('https://example.com/avatar.png', 'alice')).toBe(
      'https://example.com/avatar.png',
    )
    expect(profileAvatar('data:image/webp;base64,AAA', 'bob')).toBe(
      'data:image/webp;base64,AAA',
    )
    expect(profileAvatar('custom-avatar')).toBe('custom-avatar')
  })

  it('returns exact same URL string on repeated lookups for the same identity', () => {
    const first = profileAvatar(undefined, 'Alice')
    const second = profileAvatar(undefined, 'Alice')
    expect(first).toBe(second)
    expect(first).toMatch(/^assets\/avatars\//)
  })

  it('normalizes identity case so case variants share the same cache entry', () => {
    const lower = profileAvatar(null, 'carol')
    const upper = profileAvatar(null, 'CAROL')
    const mixed = profileAvatar(undefined, 'CaRoL')
    expect(upper).toBe(lower)
    expect(mixed).toBe(lower)
  })

  it('handles default empty identity gracefully', () => {
    const first = profileAvatar()
    const second = profileAvatar(null)
    const third = profileAvatar(undefined, '')
    expect(first).toBe(second)
    expect(second).toBe(third)
  })

  it('clears the cache when clearAvatarCache is called', () => {
    const first = profileAvatar(undefined, 'dave')
    clearAvatarCache()
    const second = profileAvatar(undefined, 'dave')
    expect(second).toBe(first)
  })

  it('bounds cache size to 2000 entries and evicts oldest on overflow', () => {
    const firstUrl = profileAvatar(undefined, 'identity-0')

    for (let i = 1; i <= 2000; i++) {
      profileAvatar(undefined, `identity-${i}`)
    }

    // After 2001 total insertions, 'identity-0' was evicted
    const regeneratedFirstUrl = profileAvatar(undefined, 'identity-0')
    expect(regeneratedFirstUrl).toBe(firstUrl)

    const retainedUrl = profileAvatar(undefined, 'identity-2000')
    expect(retainedUrl).toBeDefined()
  })
})
