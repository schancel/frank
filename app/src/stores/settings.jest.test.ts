/** @jest-environment jsdom */

import { watch } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import { activeChain } from '@frank/wallet/chain'
import {
  useSettingsStore,
  saveSettings,
  restoreSettings,
  isValidExternalVaultAddress,
} from './settings'
import { discoverEmailGateway } from '@frank/cashweb/relay/email-gateway-discovery'

jest.mock('@frank/cashweb/relay/email-gateway-discovery', () => ({
  discoverEmailGateway: jest.fn(),
}))

const advertised = {
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
    expect(
      await restoreSettings({
        get: async () =>
          JSON.stringify({
            emailGatewayOverride: {
              chainIdentifier: 'monad-testnet',
              address: advertised.address,
            },
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

  it.each(['clear', 'refresh'])(
    'projects absent gateway authority safely during public %s transitions',
    async transition => {
      const store = useSettingsStore()
      const relay = 'https://relay.example.test'
      discover.mockResolvedValue(advertised)
      await store.refreshEmailGateway(relay, activeChain.chainIdentifier)
      expect(store.emailGatewayAddress).toBe(advertised.address)
      const observed: string[] = []
      const stop = watch(
        () => store.emailGatewayAddress,
        address => observed.push(address),
        { flush: 'sync' },
      )
      try {
        if (transition === 'clear') {
          expect(() => store.clearEmailGatewayDiscovery()).not.toThrow()
          expect(store.emailGatewayAddress).toBe('')
        }
        const refresh = store.refreshEmailGateway(
          relay,
          activeChain.chainIdentifier,
        )
        await expect(refresh).resolves.toBeUndefined()
        expect(store.emailGatewayAddress).toBe(advertised.address)
        expect(observed).toEqual(['', advertised.address])
      } finally {
        stop()
      }
    },
  )

  it('does not restore gateway authority from a discovery completed after clearing', async () => {
    const store = useSettingsStore()
    let completeDiscovery: (gateway: typeof advertised) => void = () => {
      throw new Error('Discovery completion was not initialized')
    }
    discover.mockReturnValueOnce(
      new Promise(resolve => {
        completeDiscovery = resolve
      }),
    )
    const pending = store.refreshEmailGateway(
      'https://relay.example.test',
      activeChain.chainIdentifier,
    )
    store.clearEmailGatewayDiscovery()
    completeDiscovery(advertised)
    await pending
    expect(store.advertisedEmailGateway).toBeNull()
    expect(store.emailGatewayVerifiedNetwork).toBeNull()
    expect(store.emailGatewayStatus).toBe('unavailable')
    expect(store.emailGatewayAddress).toBe('')
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

  it('blocks a changed relay origin even when the gateway address matches', async () => {
    const store = useSettingsStore()
    discover.mockResolvedValue(advertised)
    await store.refreshEmailGateway(
      'https://first-relay.example.test',
      activeChain.chainIdentifier,
    )
    expect(store.emailGatewayAddress).toBe(advertised.address)
    await store.refreshEmailGateway(
      'https://other-relay.example.test',
      activeChain.chainIdentifier,
    )
    expect(store.emailGatewayStatus).toBe('changed')
    expect(store.emailGatewayAddress).toBe('')
  })

  it('blocks a changed mail domain even when the relay and identity address match', async () => {
    const store = useSettingsStore()
    discover.mockResolvedValueOnce(advertised)
    await store.refreshEmailGateway(
      'https://relay.example.test',
      activeChain.chainIdentifier,
    )
    discover.mockResolvedValueOnce({
      ...advertised,
      domain: 'other.example.test',
    })
    await store.refreshEmailGateway(
      'https://relay.example.test',
      activeChain.chainIdentifier,
    )
    expect(store.emailGatewayStatus).toBe('changed')
    expect(store.emailGatewayAddress).toBe('')
  })

  it('does not use an advertisement verified for another selected network', async () => {
    const store = useSettingsStore()
    discover.mockResolvedValueOnce(advertised)
    await store.refreshEmailGateway(
      'https://relay.example.test',
      activeChain.chainIdentifier,
    )
    store.emailGatewayVerifiedNetwork = 'ethereum-sepolia'
    expect(store.emailGatewayAddress).toBe('')
  })

  it('keeps a deliberate gateway identity override independent of settlement chain', () => {
    const store = useSettingsStore()
    store.setEmailGatewayAddress('0x4444444444444444444444444444444444444444')
    expect(store.emailGatewayAddress).toBe(
      '0x4444444444444444444444444444444444444444',
    )
    store.emailGatewayOverride = {
      address: '0x5555555555555555555555555555555555555555',
    }
    expect(store.emailGatewayAddress).toBe(
      '0x5555555555555555555555555555555555555555',
    )
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
        address: '0x4444444444444444444444444444444444444444',
      },
    })
    expect(storage.put).toHaveBeenCalledTimes(1)
    expect(discover).not.toHaveBeenCalled()
  })

  it('persists and restores notificationFeeThresholdAvu and allowContactNotificationBypass (#1574)', async () => {
    const values: Record<string, string> = {}
    const storage = {
      put: jest.fn(async (key: string, value: string) => {
        values[key] = value
      }),
      get: jest.fn(async (key: string) => values[key]),
    } as any
    const store = useSettingsStore()
    expect(store.notificationFeeThresholdAvu).toBe(0)
    expect(store.notificationFeeThresholdAvuMicros).toBe(0)
    expect(store.allowContactNotificationBypass).toBe(true)

    store.setNotificationFeeThresholdAvu(0.25)
    store.setAllowContactNotificationBypass(false)
    expect(store.notificationFeeThresholdAvu).toBe(0.25)
    expect(store.notificationFeeThresholdAvuMicros).toBe(250_000)
    expect(store.allowContactNotificationBypass).toBe(false)

    await saveSettings(storage, store.$state)
    expect(await restoreSettings(storage)).toEqual({
      notificationFeeThresholdAvu: 0.25,
      allowContactNotificationBypass: false,
    })
  })
})

describe('coldVaultSweep settings (Issue #1572)', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it('starts disabled with default 1500 MON hot-float ceiling', () => {
    const store = useSettingsStore()
    expect(store.coldVaultSweep).toEqual({
      enabled: false,
      externalVaultAddress: '',
      maxHotBalanceDisplay: '1500',
    })
  })

  it('validates and persists EVM and Solana external vault addresses and hot-float ceiling', async () => {
    const values: Record<string, string> = {}
    const storage = {
      put: jest.fn(async (key: string, value: string) => {
        values[key] = value
      }),
      get: jest.fn(async (key: string) => values[key]),
    } as any

    const store = useSettingsStore()
    store.setColdVaultSweep({
      enabled: true,
      externalVaultAddress: '0x9999999999999999999999999999999999999999',
      maxHotBalanceDisplay: '1500',
    })
    expect(store.coldVaultSweep).toEqual({
      enabled: true,
      externalVaultAddress: '0x9999999999999999999999999999999999999999',
      maxHotBalanceDisplay: '1500',
    })

    await saveSettings(storage, store.$state)
    expect(await restoreSettings(storage)).toEqual({
      coldVaultSweep: {
        enabled: true,
        externalVaultAddress: '0x9999999999999999999999999999999999999999',
        maxHotBalanceDisplay: '1500',
      },
    })

    store.resetColdVaultSweep()
    expect(store.coldVaultSweep).toEqual({
      enabled: false,
      externalVaultAddress: '',
      maxHotBalanceDisplay: '1500',
    })
  })

  it('rejects enabling without a vault address or with an invalid address or ceiling', () => {
    const store = useSettingsStore()
    expect(() =>
      store.setColdVaultSweep({
        enabled: true,
        externalVaultAddress: '',
      }),
    ).toThrow(/External vault address is required/)

    expect(() =>
      store.setColdVaultSweep({
        enabled: true,
        externalVaultAddress: 'invalid-addr',
      }),
    ).toThrow(/Invalid external vault address/)

    expect(() =>
      store.setColdVaultSweep({
        enabled: false,
        externalVaultAddress: '0x9999999999999999999999999999999999999999',
        maxHotBalanceDisplay: '0',
      }),
    ).toThrow(/Hot-wallet ceiling must be a positive number/)
  })
})

describe('external vault address validation', () => {
  it('accepts EVM addresses and Solana addresses that decode to 32 bytes', () => {
    expect(
      isValidExternalVaultAddress('0x8888888888888888888888888888888888888888'),
    ).toBe(true)
    expect(
      isValidExternalVaultAddress(
        'So11111111111111111111111111111111111111112',
      ),
    ).toBe(true)
    expect(isValidExternalVaultAddress('1'.repeat(32))).toBe(true)
  })

  it('rejects a well-formed prefix of a Solana address', () => {
    // 32-43 base58 characters pass the shape regex but decode to fewer than 32 bytes.
    expect(
      isValidExternalVaultAddress('So1111111111111111111111111111111111111111'),
    ).toBe(false)
    expect(
      isValidExternalVaultAddress('So111111111111111111111111111111'),
    ).toBe(false)
  })
})

it('clearing the gateway override does not accept a changed relay gateway', () => {
  setActivePinia(createPinia())
  const store = useSettingsStore()
  store.emailGatewayOverride = {
    address: '0x3333333333333333333333333333333333333333',
  }
  store.emailGatewayStatus = 'changed'
  const accepted = store.acceptedEmailGateway
  store.clearEmailGatewayOverride()
  expect(store.emailGatewayOverride).toBeNull()
  expect(store.emailGatewayStatus).toBe('changed')
  expect(store.acceptedEmailGateway).toEqual(accepted)
})
