/** @jest-environment jsdom */

import {
  checkForAppUpdate,
  checkDebouncedAppUpdate,
  forceCacheRefresh,
  isUpdateAvailable,
} from './pwa'

describe('pwa utility', () => {
  const originalLocation = window.location

  beforeEach(() => {
    delete (window as any).checkForAppUpdate
    delete (window as any).forceCacheRefresh
    delete (window as any).offerUpdate
    delete (window as any).isUpdateAvailable
    delete (window as any).caches

    // mock window.location.reload
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: {
        ...originalLocation,
        reload: jest.fn(),
      },
    })
  })

  afterAll(() => {
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: originalLocation,
    })
  })

  describe('checkForAppUpdate', () => {
    it('delegates to window.checkForAppUpdate when defined', async () => {
      const mockCheck = jest.fn().mockResolvedValue({ waiting: null })
      ;(window as any).checkForAppUpdate = mockCheck

      const result = await checkForAppUpdate()
      expect(mockCheck).toHaveBeenCalled()
      expect(result).toEqual({ waiting: null })
    })

    it('falls back to navigator.serviceWorker when window.checkForAppUpdate is absent', async () => {
      const mockUpdate = jest.fn().mockResolvedValue(undefined)
      const mockGetRegistration = jest.fn().mockResolvedValue({
        update: mockUpdate,
      })

      Object.defineProperty(navigator, 'serviceWorker', {
        configurable: true,
        value: {
          getRegistration: mockGetRegistration,
        },
      })

      const reg = await checkForAppUpdate()
      expect(mockGetRegistration).toHaveBeenCalled()
      expect(mockUpdate).toHaveBeenCalled()
      expect(reg).not.toBeNull()
    })
  })

  describe('isUpdateAvailable', () => {
    it('returns false when window.isUpdateAvailable is not defined', () => {
      expect(isUpdateAvailable()).toBe(false)
    })

    it('delegates to window.isUpdateAvailable when defined', () => {
      ;(window as any).isUpdateAvailable = jest.fn().mockReturnValue(true)
      expect(isUpdateAvailable()).toBe(true)
    })
  })

  describe('checkDebouncedAppUpdate', () => {
    it('debounces successive calls within interval', () => {
      const mockCheck = jest.fn().mockResolvedValue(null)
      ;(window as any).checkForAppUpdate = mockCheck

      // First call triggers check
      checkDebouncedAppUpdate(30_000)
      expect(mockCheck).toHaveBeenCalledTimes(1)

      // Second call immediately after is debounced
      checkDebouncedAppUpdate(30_000)
      expect(mockCheck).toHaveBeenCalledTimes(1)
    })
  })

  describe('forceCacheRefresh', () => {
    it('delegates to window.forceCacheRefresh when defined', async () => {
      const mockForce = jest.fn().mockResolvedValue(undefined)
      ;(window as any).forceCacheRefresh = mockForce

      await forceCacheRefresh()
      expect(mockForce).toHaveBeenCalled()
    })

    it('unregisters workers and deletes caches then reloads', async () => {
      const mockUnregister = jest.fn().mockResolvedValue(true)
      const mockGetRegistrations = jest
        .fn()
        .mockResolvedValue([{ unregister: mockUnregister }])

      Object.defineProperty(navigator, 'serviceWorker', {
        configurable: true,
        value: {
          getRegistrations: mockGetRegistrations,
        },
      })

      const mockDelete = jest.fn().mockResolvedValue(true)
      const mockKeys = jest.fn().mockResolvedValue(['cache-v1', 'cache-v2'])
      ;(window as any).caches = {
        keys: mockKeys,
        delete: mockDelete,
      }

      await forceCacheRefresh()

      expect(mockGetRegistrations).toHaveBeenCalled()
      expect(mockUnregister).toHaveBeenCalled()
      expect(mockKeys).toHaveBeenCalled()
      expect(mockDelete).toHaveBeenCalledWith('cache-v1')
      expect(mockDelete).toHaveBeenCalledWith('cache-v2')
      expect(window.location.reload).toHaveBeenCalled()
    })
  })
})
