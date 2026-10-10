/** @jest-environment jsdom */

import { createApp } from 'vue'
import { setActivePinia, createPinia } from 'pinia'
import { getActiveChain, onActiveChainChange } from '@frank/wallet/chain'
import { useSettingsStore, saveSettings, restoreSettings } from './settings'
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
    expect(
      () => store.setEmailGatewayAddress('0x123'), // too short
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

  // The app is testnet-only for now. A mainnet choice saved by an earlier build must not swap
  // the global chain under a wallet that is bound to testnet: every balance, send and message
  // call would then throw.
  it('does not change the active chain when a mainnet choice is found in storage', async () => {
    let storageOptions:
      | { restore(storage: unknown): Promise<Record<string, unknown>> }
      | undefined
    const pinia = createPinia()
    pinia.use(({ options }) => {
      storageOptions = options.storage as typeof storageOptions
    })
    createApp({}).use(pinia)
    setActivePinia(pinia)
    const store = useSettingsStore()
    const before = getActiveChain()
    const changes = jest.fn()
    const stop = onActiveChainChange(changes)

    const put = jest.fn(async () => undefined)
    const restored = await storageOptions!.restore({
      get: async () =>
        JSON.stringify({
          emailGatewayAddress: '0x2222222222222222222222222222222222222222',
          networkMode: 'mainnet',
        }),
      put,
    })
    store.$patch(restored)
    stop()

    expect(getActiveChain()).toBe(before)
    expect(changes).not.toHaveBeenCalled()
    expect(store.$state).toEqual({
      emailGatewayAddress: '0x2222222222222222222222222222222222222222',
      networkMode: 'testnet',
    })
    // The stored record is corrected, keeping the rest of it.
    expect(put).toHaveBeenCalledWith(
      'settings',
      JSON.stringify({
        emailGatewayAddress: '0x2222222222222222222222222222222222222222',
        networkMode: 'testnet',
      }),
    )
    expect('setNetworkMode' in store).toBe(false)
  })

  it('keeps the default gateway when the stored one is not an address', async () => {
    const storage = {
      get: async () => JSON.stringify({ emailGatewayAddress: 'nope' }),
    } as any
    expect(await restoreSettings(storage)).toEqual({})
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
      networkMode: 'testnet' as const,
    }
    await saveSettings(mockStorage, state)
    expect(mockStorage.put).toHaveBeenCalledWith(
      'settings',
      JSON.stringify(state),
    )

    expect(await restoreSettings(mockStorage)).toEqual({
      emailGatewayAddress: state.emailGatewayAddress,
    })
    expect(mockStorage.put).toHaveBeenCalledTimes(1)
  })
})
