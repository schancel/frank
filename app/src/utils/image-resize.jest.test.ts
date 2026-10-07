/** @jest-environment jsdom */
import {
  DEFAULT_MAX_DIMENSION,
  DEFAULT_MAX_BYTES,
  DEFAULT_QUALITY,
  calculateTargetDimensions,
  getImageByteSize,
  drawToCanvas,
  canvasToCompressedDataUrl,
  compressImageElement,
  downscaleImage,
  resizeImage,
} from './image-resize'

describe('image-resize utilities', () => {
  describe('constants', () => {
    it('defines expected default constraints', () => {
      expect(DEFAULT_MAX_DIMENSION).toBe(800)
      expect(DEFAULT_MAX_BYTES).toBe(150 * 1024)
      expect(DEFAULT_QUALITY).toBe(0.82)
    })
  })

  describe('calculateTargetDimensions (aspect ratio preservation)', () => {
    it('preserves dimensions when both width and height are within maxDimension', () => {
      expect(calculateTargetDimensions(640, 480, 800)).toEqual({
        width: 640,
        height: 480,
      })
      expect(calculateTargetDimensions(800, 600, 800)).toEqual({
        width: 800,
        height: 600,
      })
    })

    it('scales down landscape (wider) images preserving aspect ratio', () => {
      // 1600x800 -> 2:1 ratio -> 800x400
      const dims = calculateTargetDimensions(1600, 800, 800)
      expect(dims).toEqual({ width: 800, height: 400 })
      expect(dims.width / dims.height).toBeCloseTo(1600 / 800)
    })

    it('scales down portrait (taller) images preserving aspect ratio', () => {
      // 600x1200 -> 1:2 ratio -> 400x800
      const dims = calculateTargetDimensions(600, 1200, 800)
      expect(dims).toEqual({ width: 400, height: 800 })
      expect(dims.width / dims.height).toBeCloseTo(600 / 1200)
    })

    it('scales down large square images to maxDimension x maxDimension', () => {
      const dims = calculateTargetDimensions(2400, 2400, 800)
      expect(dims).toEqual({ width: 800, height: 800 })
      expect(dims.width / dims.height).toBe(1)
    })

    it('handles non-standard aspect ratios correctly', () => {
      // 1920x1080 -> 16:9 -> 800x450
      const dims = calculateTargetDimensions(1920, 1080, 800)
      expect(dims).toEqual({ width: 800, height: 450 })
      expect(dims.width / dims.height).toBeCloseTo(1920 / 1080, 2)
    })

    it('handles zero or negative dimensions safely', () => {
      expect(calculateTargetDimensions(0, 0, 800)).toEqual({
        width: 800,
        height: 800,
      })
      expect(calculateTargetDimensions(-100, 50, 800)).toEqual({
        width: 800,
        height: 800,
      })
    })
  })

  describe('getImageByteSize', () => {
    it('returns size of Blob or File', () => {
      const blob = new Blob(['1234567890'])
      expect(getImageByteSize(blob)).toBe(10)
      const file = new File(['hello world'], 'test.txt', { type: 'text/plain' })
      expect(getImageByteSize(file)).toBe(11)
    })

    it('computes decoded binary byte size of base64 data URLs', () => {
      // 'QUJD' is base64 for 'ABC' (3 bytes)
      const dataUrl = 'data:image/png;base64,QUJD'
      expect(getImageByteSize(dataUrl)).toBe(3)

      // 'QUJDRA==' is base64 for 'ABCD' (4 bytes)
      const dataUrl2 = 'data:image/png;base64,QUJDRA=='
      expect(getImageByteSize(dataUrl2)).toBe(4)
    })
  })

  describe('drawToCanvas', () => {
    it('creates canvas with target dimensions and draws source', () => {
      const mockDrawImage = jest.fn()
      const mockFillRect = jest.fn()
      HTMLCanvasElement.prototype.getContext = jest.fn(() => ({
        drawImage: mockDrawImage,
        fillRect: mockFillRect,
        fillStyle: '',
      })) as any

      const srcImg = document.createElement('img')
      const canvas = drawToCanvas(srcImg, 800, 450, true)

      expect(canvas.width).toBe(800)
      expect(canvas.height).toBe(450)
      expect(mockFillRect).toHaveBeenCalledWith(0, 0, 800, 450)
      expect(mockDrawImage).toHaveBeenCalledWith(srcImg, 0, 0, 800, 450)
    })
  })

  describe('canvasToCompressedDataUrl', () => {
    it('returns WebP data URL when supported and within budget', () => {
      const expectedWebp = 'data:image/webp;base64,WEJQX0RBVEE='
      HTMLCanvasElement.prototype.toDataURL = jest.fn((format: string) => {
        if (format === 'image/webp') return expectedWebp
        return 'data:image/jpeg;base64,SlBFRw=='
      })

      const canvas = document.createElement('canvas')
      canvas.width = 400
      canvas.height = 300

      const result = canvasToCompressedDataUrl(canvas, 10000, 0.82)
      expect(result).toBe(expectedWebp)
    })

    it('falls back to JPEG when WebP is unsupported or too large', () => {
      const expectedJpeg = 'data:image/jpeg;base64,SlBFR19EQVRB'
      HTMLCanvasElement.prototype.getContext = jest.fn(() => ({
        drawImage: jest.fn(),
        fillRect: jest.fn(),
        fillStyle: '',
      })) as any
      HTMLCanvasElement.prototype.toDataURL = jest.fn((format: string) => {
        // Simulates browser returning PNG when WebP is not supported
        if (format === 'image/webp') return 'data:image/png;base64,UE5H'
        if (format === 'image/jpeg') return expectedJpeg
        return ''
      })

      const canvas = document.createElement('canvas')
      canvas.width = 400
      canvas.height = 300

      const result = canvasToCompressedDataUrl(canvas, 10000, 0.82)
      expect(result).toBe(expectedJpeg)
    })
  })

  describe('compressImageElement', () => {
    it('scales image to target dimensions and stays under maxBytes limit', () => {
      const mockDrawImage = jest.fn()
      HTMLCanvasElement.prototype.getContext = jest.fn(() => ({
        drawImage: mockDrawImage,
        fillRect: jest.fn(),
        fillStyle: '',
      })) as any

      HTMLCanvasElement.prototype.toDataURL = jest.fn((format: string) => {
        if (format === 'image/webp') {
          return 'data:image/webp;base64,' + 'W'.repeat(1200)
        }
        return 'data:image/jpeg;base64,' + 'J'.repeat(1200)
      })

      const img = document.createElement('img')
      Object.defineProperty(img, 'naturalWidth', { value: 1600 })
      Object.defineProperty(img, 'naturalHeight', { value: 900 })

      const result = compressImageElement(img, {
        maxDimension: 800,
        maxBytes: 150 * 1024,
      })

      expect(result).toMatch(/^data:image\/webp;base64,/)
      expect(result.length).toBeLessThanOrEqual(150 * 1024)
      expect(mockDrawImage).toHaveBeenCalledWith(img, 0, 0, 800, 450)
    })
  })

  describe('downscaleImage (end-to-end integration)', () => {
    let originalImage: any

    beforeEach(() => {
      HTMLCanvasElement.prototype.getContext = jest.fn(() => ({
        drawImage: jest.fn(),
        fillRect: jest.fn(),
        fillStyle: '',
      })) as any

      originalImage = window.Image
    })

    afterEach(() => {
      window.Image = originalImage
    })

    it('returns original base64 data URL without canvas re-compression when within constraints', async () => {
      class MockSmallImage {
        width = 400
        height = 300
        naturalWidth = 400
        naturalHeight = 300
        complete = true
        _src = ''
        onload: (() => void) | null = null
        get src() {
          return this._src
        }
        set src(val: string) {
          this._src = val
          if (this.onload) this.onload()
        }
      }
      window.Image = MockSmallImage as any

      const mockToDataURL = jest.fn()
      HTMLCanvasElement.prototype.toDataURL = mockToDataURL

      const smallDataUrl = 'data:image/png;base64,QUJD' // tiny, 400x300 <= 800, 3 bytes <= 150KB
      const result = await downscaleImage(smallDataUrl)

      // Must be EXACT original string, no canvas calls!
      expect(result).toBe(smallDataUrl)
      expect(mockToDataURL).not.toHaveBeenCalled()
    })

    it('downscales and re-compresses when image dimensions exceed maxDimension', async () => {
      let drawnWidth = 0
      let drawnHeight = 0
      HTMLCanvasElement.prototype.getContext = jest.fn(() => ({
        drawImage: (
          _img: any,
          _sx: number,
          _sy: number,
          w: number,
          h: number,
        ) => {
          drawnWidth = w
          drawnHeight = h
        },
        fillRect: jest.fn(),
        fillStyle: '',
      })) as any

      HTMLCanvasElement.prototype.toDataURL = jest.fn((format: string) => {
        return `data:${format};base64,RESIZED_DOWNSCALED`
      })

      class MockOversizedImage {
        width = 2400
        height = 1200
        naturalWidth = 2400
        naturalHeight = 1200
        complete = true
        _src = ''
        onload: (() => void) | null = null
        get src() {
          return this._src
        }
        set src(val: string) {
          this._src = val
          if (this.onload) this.onload()
        }
      }
      window.Image = MockOversizedImage as any

      const inputDataUrl = 'data:image/png;base64,SOME_BIG_IMAGE'
      const result = await downscaleImage(inputDataUrl, {
        maxDimension: 800,
      })

      // Verified: aspect ratio preserved (2400:1200 = 2:1 -> 800:400)
      expect(drawnWidth).toBe(800)
      expect(drawnHeight).toBe(400)
      expect(result).toBe('data:image/webp;base64,RESIZED_DOWNSCALED')
    })

    it('reduces byte size when raw size exceeds maxBytes even if dimensions are within maxDimension', async () => {
      HTMLCanvasElement.prototype.getContext = jest.fn(() => ({
        drawImage: jest.fn(),
        fillRect: jest.fn(),
        fillStyle: '',
      })) as any

      const compressedDataUrl = 'data:image/webp;base64,COMPRESSED_PAYLOAD'
      HTMLCanvasElement.prototype.toDataURL = jest.fn(() => compressedDataUrl)

      class MockHeavyImage {
        width = 500
        height = 500
        naturalWidth = 500
        naturalHeight = 500
        complete = true
        _src = ''
        onload: (() => void) | null = null
        get src() {
          return this._src
        }
        set src(val: string) {
          this._src = val
          if (this.onload) this.onload()
        }
      }
      window.Image = MockHeavyImage as any

      // Input base64 exceeds maxBytes (200,000 bytes > 150KB)
      const oversizedDataUrl = 'data:image/png;base64,' + 'A'.repeat(200000)
      const result = await downscaleImage(oversizedDataUrl, {
        maxDimension: 800,
        maxBytes: 150 * 1024,
      })

      expect(result).toBe(compressedDataUrl)
      expect(result.length).toBeLessThan(oversizedDataUrl.length)
    })

    it('processes File input, downscaling when oversized and preserving aspect ratio', async () => {
      let drawnW = 0
      let drawnH = 0
      HTMLCanvasElement.prototype.getContext = jest.fn(() => ({
        drawImage: (
          _img: any,
          _sx: number,
          _sy: number,
          w: number,
          h: number,
        ) => {
          drawnW = w
          drawnH = h
        },
        fillRect: jest.fn(),
        fillStyle: '',
      })) as any

      const compressed = 'data:image/webp;base64,FILE_COMPRESSED'
      HTMLCanvasElement.prototype.toDataURL = jest.fn(() => compressed)

      class MockFileImage {
        width = 1600
        height = 1200
        naturalWidth = 1600
        naturalHeight = 1200
        complete = true
        _src = ''
        onload: (() => void) | null = null
        get src() {
          return this._src
        }
        set src(val: string) {
          this._src = val
          if (this.onload) this.onload()
        }
      }
      window.Image = MockFileImage as any

      const blob = new Blob(['fake-large-file-bytes'], { type: 'image/jpeg' })
      const file = new File([blob], 'photo.jpg', { type: 'image/jpeg' })

      const result = await downscaleImage(file, { maxDimension: 800 })
      expect(result).toBe(compressed)
      // 1600x1200 -> 4:3 ratio -> 800x600
      expect(drawnW).toBe(800)
      expect(drawnH).toBe(600)
    })

    it('processes File input without re-compression when already within dimension and byte limits', async () => {
      class MockSmallFileImage {
        width = 200
        height = 150
        naturalWidth = 200
        naturalHeight = 150
        complete = true
        _src = ''
        onload: (() => void) | null = null
        get src() {
          return this._src
        }
        set src(val: string) {
          this._src = val
          if (this.onload) this.onload()
        }
      }
      window.Image = MockSmallFileImage as any

      const mockToDataURL = jest.fn()
      HTMLCanvasElement.prototype.toDataURL = mockToDataURL

      const blob = new Blob(['tiny-file'], { type: 'image/png' })
      const file = new File([blob], 'small.png', { type: 'image/png' })

      const result = await downscaleImage(file, {
        maxDimension: 800,
        maxBytes: 150 * 1024,
      })

      // Verified: FileReader data URL returned without canvas re-compression
      expect(result).toContain('data:image/png;')
      expect(mockToDataURL).not.toHaveBeenCalled()
    })

    it('rejects non-image files with an informative error', async () => {
      const textFile = new File(['text'], 'notes.txt', { type: 'text/plain' })
      await expect(downscaleImage(textFile)).rejects.toThrow(
        'File is not a valid image',
      )
    })

    it('provides resizeImage alias that functions identically', async () => {
      expect(resizeImage).toBe(downscaleImage)
    })
  })
})
