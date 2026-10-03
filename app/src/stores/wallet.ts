import { defineStore } from 'pinia'
import { inspectLegacyWallet } from '../accounts/legacy'

/** Compatibility projection only. The historical 'wallet' blob is read-only quarantine.
 * Custody owns all new accounts; no secret fields are hydrated or serialized here. */
export const useWalletStore = defineStore('wallet', {
  state: () => ({
    balance: 0,
    feePerByte: 2,
    utxos: {} as Record<string, number | undefined>,
    xPrivKey: null,
    seedPhrase: null,
    seedConfirmedAt: null,
  }),
  actions: {
    reset() {
      this.balance = 0
      this.utxos = {}
    },
    setXPrivKey() {
      throw new Error('Legacy wallet is quarantined')
    },
    setSeedPhrase() {
      throw new Error('Use explicit legacy recovery/migration')
    },
    removeUTXO(id: string) {
      delete this.utxos[id]
    },
    addUTXO() {
      throw new Error('Legacy wallet is quarantined')
    },
  },
  storage: {
    save: async () => undefined,
    restore: async storage => {
      await inspectLegacyWallet(storage)
      return {}
    },
  },
})
