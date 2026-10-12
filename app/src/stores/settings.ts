import { defineStore } from 'pinia'
import { LevelDB } from 'level'
import { activeChain, PROTOCOL_CHAINS } from '@frank/wallet/chain'
import {
  discoverEmailGateway,
  type AdvertisedEmailGateway,
} from 'src/utils/email-gateway-discovery'

export const ETHEREUM_ADDRESS_REGEX = /^0x[a-fA-F0-9]{40}$/

type GatewayIdentity = Pick<
  AdvertisedEmailGateway,
  'chainIdentifier' | 'address'
>
type AcceptedGatewayIdentity = GatewayIdentity & { relayOrigin: string }
type GatewayStatus = 'unavailable' | 'loading' | 'ready' | 'changed' | 'error'

export interface SettingsState {
  /** A deliberate user choice, scoped to the canonical network. Never a compiled default. */
  emailGatewayOverride: GatewayIdentity | null
  /** Last relay identity accepted for this network; detects address rotation across restarts. */
  acceptedEmailGateway: AcceptedGatewayIdentity | null
  advertisedEmailGateway: AdvertisedEmailGateway | null
  emailGatewayStatus: GatewayStatus
  emailGatewayError: string
  emailGatewayRelayOrigin: string | null
  emailGatewayGeneration: number
  /** Always 'testnet' for now. */
  networkMode: 'testnet'
}

function validIdentity(value: unknown): value is GatewayIdentity {
  if (!value || typeof value !== 'object') return false
  const item = value as Record<string, unknown>
  return (
    typeof item.chainIdentifier === 'string' &&
    PROTOCOL_CHAINS[item.chainIdentifier]?.id === item.chainIdentifier &&
    PROTOCOL_CHAINS[item.chainIdentifier]?.family === 'evm' &&
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
      'string'
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
    emailGatewayGeneration: 0,
    networkMode: 'testnet',
  }),
  getters: {
    emailGatewayAddress(state): string {
      const chain = activeChain.chainIdentifier
      if (state.emailGatewayOverride?.chainIdentifier === chain)
        return state.emailGatewayOverride.address
      if (
        state.emailGatewayStatus !== 'ready' ||
        state.advertisedEmailGateway?.chainIdentifier !== chain
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
      this.emailGatewayOverride = {
        chainIdentifier: activeChain.chainIdentifier,
        address,
      }
    },
    resetEmailGatewayAddress() {
      this.emailGatewayOverride = null
      if (
        this.advertisedEmailGateway?.chainIdentifier ===
        activeChain.chainIdentifier
      )
        this.acceptedEmailGateway = {
          chainIdentifier: activeChain.chainIdentifier,
          address: this.advertisedEmailGateway.address,
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
      this.emailGatewayStatus = 'unavailable'
      this.emailGatewayError = ''
    },
    async refreshEmailGateway(relayBaseUrl: string, chainIdentifier: string) {
      const generation = ++this.emailGatewayGeneration
      this.advertisedEmailGateway = null
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
        if (!gateway) {
          this.emailGatewayStatus = 'unavailable'
        } else if (
          this.acceptedEmailGateway?.chainIdentifier === chainIdentifier &&
          (this.acceptedEmailGateway.relayOrigin !== origin ||
            this.acceptedEmailGateway.address.toLowerCase() !==
              gateway.address.toLowerCase())
        ) {
          this.emailGatewayStatus = 'changed'
        } else {
          this.acceptedEmailGateway = {
            chainIdentifier,
            address: gateway.address,
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
