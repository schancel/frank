import { defineStore } from 'pinia'

import {
  PersistentStorageStatus,
  queryPersistentStorage,
  mayRequestOnLaunch,
  requestPersistentStorage,
} from 'src/utils/persistent-storage'
import { useWalletStore } from 'src/stores/wallet'

/**
 * Whether the browser has agreed to keep this app's data (ticket #370). Deliberately not saved:
 * the browser is the source of truth, so it is re-read each launch and whenever Settings opens.
 */
export const usePersistentStorageStore = defineStore('persistentStorage', {
  state: (): { status: PersistentStorageStatus } => ({ status: 'unknown' }),
  actions: {
    async refresh() {
      this.status = await queryPersistentStorage()
    },
    async request() {
      this.status = await requestPersistentStorage()
    },
    /** Returning-user launch: when an account exists and persistence is not granted yet, ask, but
     * at most once a week (see `mayRequestOnLaunch`). Never rejects. */
    async ensureForAccount() {
      if (!useWalletStore().seedPhrase) return
      await this.refresh()
      if (this.status === 'not-granted' && mayRequestOnLaunch()) {
        await this.request()
      }
    },
  },
})
