import { defineStore } from 'pinia'
import { LevelDB } from 'level'
import { setNetworkMode } from '@frank/wallet/chain'

import { defaultEmailGatewayAddress } from 'src/utils/constants'

export interface SettingsState {
  emailGatewayAddress: string
  networkMode: 'testnet' | 'mainnet'
}

export function saveSettings(
  storage: LevelDB,
  state: SettingsState,
): Promise<void> {
  return storage.put('settings', JSON.stringify(state))
}

export async function restoreSettings(
  storage: LevelDB,
): Promise<Partial<SettingsState>> {
  let settings = '{}'
  try {
    settings = await storage.get('settings')
  } catch {
    // Ignore storage read errors on first load
  }
  try {
    const deserialized = JSON.parse(settings) as Partial<SettingsState>
    return deserialized
  } catch {
    return {}
  }
}

export const ETHEREUM_ADDRESS_REGEX = /^0x[a-fA-F0-9]{40}$/

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
    setNetworkMode(mode: 'testnet' | 'mainnet') {
      this.networkMode = mode
      setNetworkMode(mode)
    },
  },
  storage: {
    save(storage, _mutation, state): Promise<void> {
      return saveSettings(storage, state)
    },
    async restore(storage): Promise<Partial<SettingsState>> {
      const restored = await restoreSettings(storage)
      if (restored.networkMode) {
        setNetworkMode(restored.networkMode)
      }
      return restored
    },
  },
})
