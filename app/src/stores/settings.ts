import { defineStore } from 'pinia'
import { LevelDB } from 'level'

import { defaultEmailGatewayAddress } from 'src/utils/constants'

export interface SettingsState {
  emailGatewayAddress: string
  /** Always 'testnet' for now. See `restoreSettings`. */
  networkMode: 'testnet'
}

export function saveSettings(
  storage: LevelDB,
  state: SettingsState,
): Promise<void> {
  return storage.put('settings', JSON.stringify(state))
}

export const ETHEREUM_ADDRESS_REGEX = /^0x[a-fA-F0-9]{40}$/

/**
 * Reads back only the settings this store has, each checked.
 *
 * The app runs on testnet only for now, so `networkMode` is always 'testnet' whatever was stored:
 * a mainnet choice saved by an earlier build is ignored, and the record is rewritten without it.
 * Nothing here touches the active chain. The chain comes from configuration, and a stored
 * setting must never swap it under an open wallet (that broke every balance, send and message
 * call). A future unlock is a change to this field and to how a wallet is opened for the chosen
 * network, not a swap of the global chain.
 */
export async function restoreSettings(
  storage: LevelDB,
): Promise<Partial<SettingsState>> {
  let settings = '{}'
  try {
    settings = await storage.get('settings')
  } catch {
    // Ignore storage read errors on first load
  }
  let stored: { emailGatewayAddress?: unknown; networkMode?: unknown } | null
  try {
    stored = JSON.parse(settings)
  } catch {
    return {}
  }
  const gateway = stored?.emailGatewayAddress
  const restored: Partial<SettingsState> =
    typeof gateway === 'string' && ETHEREUM_ADDRESS_REGEX.test(gateway)
      ? { emailGatewayAddress: gateway }
      : {}
  if (stored?.networkMode !== undefined && stored.networkMode !== 'testnet') {
    await saveSettings(storage, {
      emailGatewayAddress:
        restored.emailGatewayAddress ?? defaultEmailGatewayAddress,
      networkMode: 'testnet',
    })
  }
  return restored
}

export const useSettingsStore = defineStore('settings', {
  state: (): SettingsState => ({
    emailGatewayAddress: defaultEmailGatewayAddress,
    networkMode: 'testnet',
  }),
  actions: {
    setEmailGatewayAddress(address: string) {
      if (!ETHEREUM_ADDRESS_REGEX.test(address)) {
        throw new Error(
          `Invalid Ethereum address: "${address}". Expected format: 0x followed by 40 hex characters.`,
        )
      }
      this.emailGatewayAddress = address
    },
    resetEmailGatewayAddress() {
      this.emailGatewayAddress = defaultEmailGatewayAddress
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
