/** @jest-environment jsdom */

import { setActivePinia, createPinia } from 'pinia'
import {
  useSettingsStore,
  saveSettings,
  restoreSettings,
} from './settings'
import { defaultEmailGatewayAddress } from '../utils/constants'

describe('settings store', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it('initializes with defaultEmailGatewayAddress', () => {
    const store = useSettingsStore()
    expect(store.emailGatewayAddress).toBe(defaultEmailGatewayAddress)
  })

  it('sets valid Ethereum address', () => {
    const store = useSettingsStore()
    const validAddr = '0x1234567890123456789012345678901234567890'
    store.setEmailGatewayAddress(validAddr)
    expect(store.emailGatewayAddress).toBe(validAddr)
  })

  it('throws on invalid address formats', () => {
    const store = useSettingsStore()
    expect(() => store.setEmailGatewayAddress('not-an-address')).toThrow(
      /Invalid Ethereum address/,
    )
    expect(() =>
      store.setEmailGatewayAddress('0x123'), // too short
    ).toThrow(/Invalid Ethereum address/)
    expect(() =>
      store.setEmailGatewayAddress(
        '0xGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGG', // non-hex
      ),
    ).toThrow(/Invalid Ethereum address/)
  })

  it('resets email gateway address to default', () => {
    const store = useSettingsStore()
    const validAddr = '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd'
    store.setEmailGatewayAddress(validAddr)
    expect(store.emailGatewayAddress).toBe(validAddr)

    store.resetEmailGatewayAddress()
    expect(store.emailGatewayAddress).toBe(defaultEmailGatewayAddress)
  })

  it('saves and restores settings to LevelDB storage', async () => {
    const fakeStore: Record<string, string> = {}
    const mockStorage = {
      put: jest.fn((key: string, val: string) => {
        fakeStore[key] = val
        return Promise.resolve()
      }),
      get: jest.fn((key: string) => {
        if (key in fakeStore) return Promise.resolve(fakeStore[key])
        return Promise.reject(new Error('not found'))
      }),
    } as any

    const state = {
      emailGatewayAddress: '0x2222222222222222222222222222222222222222',
    }
    await saveSettings(mockStorage, state)
    expect(mockStorage.put).toHaveBeenCalledWith(
      'settings',
      JSON.stringify(state),
    )

    const restored = await restoreSettings(mockStorage)
    expect(restored.emailGatewayAddress).toBe(
      '0x2222222222222222222222222222222222222222',
    )
  })
})
