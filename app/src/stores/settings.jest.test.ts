/** @jest-environment jsdom */

import { createPinia, setActivePinia } from 'pinia'
import { activeChain } from '@frank/wallet/chain'
import { useSettingsStore, saveSettings, restoreSettings } from './settings'
import { discoverEmailGateway } from 'src/utils/email-gateway-discovery'

jest.mock('src/utils/email-gateway-discovery', () => ({
  discoverEmailGateway: jest.fn(),
}))

const advertised = {
  chainIdentifier: 'monad-testnet',
  address: '0x2222222222222222222222222222222222222222',
  domain: 'mail.example.test',
}
const discover = discoverEmailGateway as jest.MockedFunction<
  typeof discoverEmailGateway
>

describe('email gateway settings', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    discover.mockReset()
  })

  it('has no compiled payment destination or restored unscoped fallback', async () => {
    const store = useSettingsStore()
    expect(store.emailGatewayAddress).toBe('')
    expect(
      await restoreSettings({
        get: async () =>
          JSON.stringify({
            emailGatewayAddress: '0x1111111111111111111111111111111111111111',
          }),
      } as any),
    ).toEqual({})
  })

  it('uses only the selected relay and exact canonical network advertisement', async () => {
    const store = useSettingsStore()
    discover.mockResolvedValueOnce(advertised)
    await store.refreshEmailGateway(
      'https://relay.example.test/path',
      activeChain.chainIdentifier,
    )
    expect(discover).toHaveBeenCalledWith({
      relayBaseUrl: 'https://relay.example.test/path',
      chainIdentifier: activeChain.chainIdentifier,
    })
    expect(store.emailGatewayAddress).toBe(advertised.address)
    expect(store.emailGatewayStatus).toBe('ready')
  })

  it('leaves sending unavailable when the relay has no service or cannot be checked', async () => {
    const store = useSettingsStore()
    discover.mockResolvedValueOnce(null)
    await store.refreshEmailGateway(
      'https://relay.example.test',
      activeChain.chainIdentifier,
    )
    expect(store.emailGatewayAddress).toBe('')
    expect(store.emailGatewayStatus).toBe('unavailable')
    discover.mockRejectedValueOnce(new Error('wrong network'))
    await store.refreshEmailGateway(
      'https://relay.example.test',
      activeChain.chainIdentifier,
    )
    expect(store.emailGatewayAddress).toBe('')
    expect(store.emailGatewayStatus).toBe('error')
  })

  it('blocks an advertised identity change until the user accepts it', async () => {
    const store = useSettingsStore()
    discover.mockResolvedValueOnce(advertised)
    await store.refreshEmailGateway(
      'https://relay.example.test',
      activeChain.chainIdentifier,
    )
    discover.mockResolvedValueOnce({
      ...advertised,
      address: '0x3333333333333333333333333333333333333333',
    })
    await store.refreshEmailGateway(
      'https://relay.example.test',
      activeChain.chainIdentifier,
    )
    expect(store.emailGatewayStatus).toBe('changed')
    expect(store.emailGatewayAddress).toBe('')
    store.resetEmailGatewayAddress()
    expect(store.emailGatewayAddress).toBe(
      '0x3333333333333333333333333333333333333333',
    )
  })

  it('keeps a deliberate override scoped to its canonical chain', () => {
    const store = useSettingsStore()
    store.setEmailGatewayAddress('0x4444444444444444444444444444444444444444')
    expect(store.emailGatewayAddress).toBe(
      '0x4444444444444444444444444444444444444444',
    )
    expect(store.emailGatewayOverride?.chainIdentifier).toBe(
      activeChain.chainIdentifier,
    )
    store.emailGatewayOverride = {
      chainIdentifier: 'ethereum-sepolia',
      address: '0x5555555555555555555555555555555555555555',
    }
    expect(store.emailGatewayAddress).toBe('')
    expect(() => store.setEmailGatewayAddress('0x123')).toThrow(
      /Invalid Ethereum address/,
    )
  })

  it('persists only override and accepted identity, without fetching or mutating on hydration', async () => {
    const values: Record<string, string> = {}
    const storage = {
      put: jest.fn(async (key: string, value: string) => {
        values[key] = value
      }),
      get: jest.fn(async (key: string) => values[key]),
    } as any
    const store = useSettingsStore()
    store.setEmailGatewayAddress('0x4444444444444444444444444444444444444444')
    await saveSettings(storage, store.$state)
    expect(await restoreSettings(storage)).toEqual({
      emailGatewayOverride: {
        chainIdentifier: activeChain.chainIdentifier,
        address: '0x4444444444444444444444444444444444444444',
      },
    })
    expect(storage.put).toHaveBeenCalledTimes(1)
    expect(discover).not.toHaveBeenCalled()
  })
})
