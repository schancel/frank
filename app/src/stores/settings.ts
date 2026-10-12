import { defineStore } from 'pinia'
import { LevelDB } from 'level'
import { activeChain } from '@frank/wallet/chain'
import {
  discoverEmailGateway,
  type AdvertisedEmailGateway,
} from 'src/utils/email-gateway-discovery'

export const ETHEREUM_ADDRESS_REGEX = /^0x[a-fA-F0-9]{40}$/

type GatewayIdentity = Pick<AdvertisedEmailGateway, 'address'>
type AcceptedGatewayIdentity = AdvertisedEmailGateway & { relayOrigin: string }
type GatewayStatus = 'unavailable' | 'loading' | 'ready' | 'changed' | 'error'

export interface SettingsState {
  /** A deliberate user choice. Never a compiled default. */
  emailGatewayOverride: GatewayIdentity | null
  /** Last relay identity accepted; detects address, domain, and origin changes across restarts. */
  acceptedEmailGateway: AcceptedGatewayIdentity | null
  advertisedEmailGateway: AdvertisedEmailGateway | null
  emailGatewayStatus: GatewayStatus
  emailGatewayError: string
  emailGatewayRelayOrigin: string | null
  /** Network of the relay information most recently verified this session. */
  emailGatewayVerifiedNetwork: string | null
  emailGatewayGeneration: number
  /** Always 'testnet' for now. */
  networkMode: 'testnet'
}

function validIdentity(value: unknown): value is GatewayIdentity {
  if (!value || typeof value !== 'object') return false
  const item = value as Record<string, unknown>
  return (
    !('chainIdentifier' in item) &&
    typeof item.address === 'string' &&
    ETHEREUM_ADDRESS_REGEX.test(item.address)
  )
}

function validAcceptedIdentity(
  value: unknown,
): value is AcceptedGatewayIdentity {
  return (
    validIdentity(value) &&
    typeof (value as unknown as Record<string, unknown>).relayOrigin ===
      'string' &&
    typeof (value as unknown as Record<string, unknown>).domain === 'string'
  )
}

export function saveSettings(
  storage: LevelDB,
  state: SettingsState,
): Promise<void> {
  return storage.put(
    'settings',
    JSON.stringify({
      emailGatewayOverride: state.emailGatewayOverride,
      acceptedEmailGateway: state.acceptedEmailGateway,
      networkMode: 'testnet',
    }),
  )
}

/** Hydration reads only settings. Legacy unscoped development addresses are intentionally ignored. */
export async function restoreSettings(
  storage: LevelDB,
): Promise<Partial<SettingsState>> {
  let raw: string
  try {
    raw = await storage.get('settings')
  } catch {
    return {}
  }
  let stored: Record<string, unknown>
  try {
    stored = JSON.parse(raw) as Record<string, unknown>
  } catch {
    return {}
  }
  if (!stored || typeof stored !== 'object') return {}
  return {
    ...(validIdentity(stored.emailGatewayOverride)
      ? { emailGatewayOverride: stored.emailGatewayOverride }
      : {}),
    ...(validAcceptedIdentity(stored.acceptedEmailGateway)
      ? { acceptedEmailGateway: stored.acceptedEmailGateway }
      : {}),
  }
}

export const useSettingsStore = defineStore('settings', {
  state: (): SettingsState => ({
    emailGatewayOverride: null,
    acceptedEmailGateway: null,
    advertisedEmailGateway: null,
    emailGatewayStatus: 'unavailable',
    emailGatewayError: '',
    emailGatewayRelayOrigin: null,
    emailGatewayVerifiedNetwork: null,
    emailGatewayGeneration: 0,
    networkMode: 'testnet',
  }),
  getters: {
    emailGatewayAddress(state): string {
      if (state.emailGatewayOverride) return state.emailGatewayOverride.address
      if (
        state.emailGatewayStatus !== 'ready' ||
        state.emailGatewayVerifiedNetwork !== activeChain.chainIdentifier
      )
        return ''
      return state.advertisedEmailGateway.address
    },
  },
  actions: {
    setEmailGatewayAddress(address: string) {
      if (!ETHEREUM_ADDRESS_REGEX.test(address))
        throw new Error(
          `Invalid Ethereum address: "${address}". Expected format: 0x followed by 40 hex characters.`,
        )
      this.emailGatewayOverride = { address }
    },
    resetEmailGatewayAddress() {
      this.emailGatewayOverride = null
      if (this.advertisedEmailGateway)
        this.acceptedEmailGateway = {
          ...this.advertisedEmailGateway,
          relayOrigin: this.emailGatewayRelayOrigin ?? '',
        }
      this.emailGatewayStatus = this.advertisedEmailGateway
        ? 'ready'
        : 'unavailable'
    },
    clearEmailGatewayDiscovery() {
      this.emailGatewayGeneration += 1
      this.advertisedEmailGateway = null
      this.emailGatewayRelayOrigin = null
      this.emailGatewayVerifiedNetwork = null
      this.emailGatewayStatus = 'unavailable'
      this.emailGatewayError = ''
    },
    async refreshEmailGateway(relayBaseUrl: string, chainIdentifier: string) {
      const generation = ++this.emailGatewayGeneration
      this.advertisedEmailGateway = null
      this.emailGatewayVerifiedNetwork = null
      this.emailGatewayStatus = 'loading'
      this.emailGatewayError = ''
      try {
        const origin = new URL(relayBaseUrl).origin
        this.emailGatewayRelayOrigin = origin
        const gateway = await discoverEmailGateway({
          relayBaseUrl,
          chainIdentifier,
        })
        if (
          this.emailGatewayGeneration !== generation ||
          this.emailGatewayRelayOrigin !== origin ||
          activeChain.chainIdentifier !== chainIdentifier
        )
          return
        this.advertisedEmailGateway = gateway
        this.emailGatewayVerifiedNetwork = chainIdentifier
        if (!gateway) {
          this.emailGatewayStatus = 'unavailable'
        } else if (
          this.acceptedEmailGateway &&
          (this.acceptedEmailGateway.relayOrigin !== origin ||
            this.acceptedEmailGateway.address.toLowerCase() !==
              gateway.address.toLowerCase() ||
            this.acceptedEmailGateway.domain !== gateway.domain)
        ) {
          this.emailGatewayStatus = 'changed'
        } else {
          this.acceptedEmailGateway = {
            ...gateway,
            relayOrigin: origin,
          }
          this.emailGatewayStatus = 'ready'
        }
      } catch (error) {
        if (this.emailGatewayGeneration !== generation) return
        this.emailGatewayStatus = 'error'
        this.emailGatewayError =
          error instanceof Error ? error.message : String(error)
      }
    },
  },
  storage: {
    save(storage, _mutation, state): Promise<void> {
      return saveSettings(storage, state)
    },
    restore(storage): Promise<Partial<SettingsState>> {
      return restoreSettings(storage)
    },
  },
})
