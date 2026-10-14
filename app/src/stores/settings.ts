import { defineStore } from 'pinia'
import { LevelDB } from 'level'
import { activeChain } from '@frank/wallet/chain'
import {
  discoverEmailGateway,
  type AdvertisedEmailGateway,
} from '@frank/cashweb/relay/email-gateway-discovery'

export const ETHEREUM_ADDRESS_REGEX = /^0x[a-fA-F0-9]{40}$/
export const SOLANA_ADDRESS_REGEX = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/

export interface ColdVaultSweepSettings {
  enabled: boolean
  externalVaultAddress: string
  maxHotBalanceDisplay: string
}

export const DEFAULT_COLD_VAULT_MAX_HOT_BALANCE_DISPLAY = '1500'

export const DEFAULT_COLD_VAULT_SWEEP_SETTINGS: Readonly<ColdVaultSweepSettings> =
  Object.freeze({
    enabled: false,
    externalVaultAddress: '',
    maxHotBalanceDisplay: DEFAULT_COLD_VAULT_MAX_HOT_BALANCE_DISPLAY,
  })

export function isValidExternalVaultAddress(address: string): boolean {
  const trimmed = (address || '').trim()
  if (!trimmed) return false
  return (
    ETHEREUM_ADDRESS_REGEX.test(trimmed) || SOLANA_ADDRESS_REGEX.test(trimmed)
  )
}

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
  /** Minimum stamp value in AVU required for a non-contact message to fire a notification (#1574). */
  notificationFeeThresholdAvu: number
  /** Whether contacts with pre-shared wakeup tokens bypass the notification fee threshold (#1574). */
  allowContactNotificationBypass: boolean
  /** Cold-Wallet Auto-Sweep Vault configuration (Issue #1572). */
  coldVaultSweep: ColdVaultSweepSettings
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

function normalizeThresholdAvu(value: unknown): number {
  const num = typeof value === 'string' ? Number(value.trim()) : Number(value)
  if (!Number.isFinite(num) || num < 0) return 0
  return num
}

function validColdVaultSweep(value: unknown): value is ColdVaultSweepSettings {
  if (!value || typeof value !== 'object') return false
  const item = value as Record<string, unknown>
  if (typeof item.enabled !== 'boolean') return false
  if (typeof item.externalVaultAddress !== 'string') return false
  if (
    item.externalVaultAddress.trim() !== '' &&
    !isValidExternalVaultAddress(item.externalVaultAddress)
  ) {
    return false
  }
  if (
    typeof item.maxHotBalanceDisplay !== 'string' ||
    !item.maxHotBalanceDisplay.trim() ||
    !Number.isFinite(Number(item.maxHotBalanceDisplay)) ||
    Number(item.maxHotBalanceDisplay) <= 0
  ) {
    return false
  }
  return true
}

export function saveSettings(
  storage: LevelDB,
  state: SettingsState,
): Promise<void> {
  const threshold = normalizeThresholdAvu(state.notificationFeeThresholdAvu)
  const allowBypass = state.allowContactNotificationBypass !== false
  const hasCustomColdVaultSweep =
    state.coldVaultSweep &&
    (state.coldVaultSweep.enabled !==
      DEFAULT_COLD_VAULT_SWEEP_SETTINGS.enabled ||
      state.coldVaultSweep.externalVaultAddress !==
        DEFAULT_COLD_VAULT_SWEEP_SETTINGS.externalVaultAddress ||
      state.coldVaultSweep.maxHotBalanceDisplay !==
        DEFAULT_COLD_VAULT_SWEEP_SETTINGS.maxHotBalanceDisplay)

  return storage.put(
    'settings',
    JSON.stringify({
      emailGatewayOverride: state.emailGatewayOverride,
      acceptedEmailGateway: state.acceptedEmailGateway,
      networkMode: 'testnet',
      ...(threshold > 0 ? { notificationFeeThresholdAvu: threshold } : {}),
      ...(!allowBypass ? { allowContactNotificationBypass: false } : {}),
      ...(hasCustomColdVaultSweep
        ? { coldVaultSweep: state.coldVaultSweep }
        : {}),
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
    ...(typeof stored.notificationFeeThresholdAvu === 'number' &&
    Number.isFinite(stored.notificationFeeThresholdAvu) &&
    stored.notificationFeeThresholdAvu > 0
      ? { notificationFeeThresholdAvu: stored.notificationFeeThresholdAvu }
      : {}),
    ...(stored.allowContactNotificationBypass === false
      ? {
          allowContactNotificationBypass: false,
        }
      : {}),
    ...(validColdVaultSweep(stored.coldVaultSweep)
      ? {
          coldVaultSweep: {
            enabled: stored.coldVaultSweep.enabled,
            externalVaultAddress:
              stored.coldVaultSweep.externalVaultAddress.trim(),
            maxHotBalanceDisplay:
              stored.coldVaultSweep.maxHotBalanceDisplay.trim(),
          },
        }
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
    notificationFeeThresholdAvu: 0,
    allowContactNotificationBypass: true,
    coldVaultSweep: {
      ...DEFAULT_COLD_VAULT_SWEEP_SETTINGS,
    },
  }),
  getters: {
    emailGatewayAddress(state): string {
      if (state.emailGatewayOverride) return state.emailGatewayOverride.address
      if (
        !state.advertisedEmailGateway ||
        state.emailGatewayStatus !== 'ready' ||
        state.emailGatewayVerifiedNetwork !== activeChain.chainIdentifier
      )
        return ''
      return state.advertisedEmailGateway.address
    },
    notificationFeeThresholdAvuMicros(state): number {
      return Math.round(
        normalizeThresholdAvu(state.notificationFeeThresholdAvu) * 1_000_000,
      )
    },
  },
  actions: {
    setNotificationFeeThresholdAvu(value: number | string) {
      this.notificationFeeThresholdAvu = normalizeThresholdAvu(value)
    },
    setAllowContactNotificationBypass(allow: boolean) {
      this.allowContactNotificationBypass = Boolean(allow)
    },
    setColdVaultSweep(input: Partial<ColdVaultSweepSettings>) {
      const enabled = input.enabled ?? this.coldVaultSweep.enabled
      const externalVaultAddress = (
        input.externalVaultAddress ?? this.coldVaultSweep.externalVaultAddress
      ).trim()
      const maxHotBalanceDisplay = (
        input.maxHotBalanceDisplay ?? this.coldVaultSweep.maxHotBalanceDisplay
      ).trim()

      if (enabled && !externalVaultAddress) {
        throw new Error(
          'External vault address is required when Cold-Wallet Auto-Sweep is enabled.',
        )
      }
      if (
        externalVaultAddress &&
        !isValidExternalVaultAddress(externalVaultAddress)
      ) {
        throw new Error(
          `Invalid external vault address: "${externalVaultAddress}". Expected an EVM (0x...) or Solana base58 address.`,
        )
      }
      const parsedCeiling = Number(maxHotBalanceDisplay)
      if (
        !maxHotBalanceDisplay ||
        !Number.isFinite(parsedCeiling) ||
        parsedCeiling <= 0
      ) {
        throw new Error(
          'Hot-wallet ceiling must be a positive number (default: 1500 MON).',
        )
      }

      this.coldVaultSweep = {
        enabled,
        externalVaultAddress,
        maxHotBalanceDisplay,
      }
    },
    resetColdVaultSweep() {
      this.coldVaultSweep = {
        ...DEFAULT_COLD_VAULT_SWEEP_SETTINGS,
      }
    },
    setEmailGatewayAddress(address: string) {
      if (!ETHEREUM_ADDRESS_REGEX.test(address))
        throw new Error(
          `Invalid Ethereum address: "${address}". Expected format: 0x followed by 40 hex characters.`,
        )
      this.emailGatewayOverride = { address }
    },
    acceptAdvertisedEmailGateway() {
      if (this.advertisedEmailGateway) {
        this.acceptedEmailGateway = {
          ...this.advertisedEmailGateway,
          relayOrigin: this.emailGatewayRelayOrigin ?? '',
        }
        this.emailGatewayStatus = 'ready'
        this.emailGatewayOverride = null
      }
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
