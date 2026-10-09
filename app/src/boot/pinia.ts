import { boot } from 'quasar/wrappers'
import { createPinia } from 'pinia'
import { nextTick } from 'vue'
// eslint-disable-next-line @typescript-eslint/no-unused-vars
import type {
  PiniaPlugin,
  StateTree,
  SubscriptionCallbackMutation,
} from 'pinia'
import level, { LevelDB } from 'level'
import { displayNetwork } from '../utils/constants'
import { pathOr } from 'ramda'

export type StoreMetadata = {
  networkName: string
  version: number
}

export interface StorageOptions<S extends StateTree> {
  save: (
    storage: LevelDB,
    mutation: SubscriptionCallbackMutation<S>,
    state: S,
  ) => Promise<void>
  restore: (
    storage: LevelDB,
    metadata: StoreMetadata,
    state: S,
  ) => Promise<Partial<S>>
}

export const STORE_SCHEMA_VERSION = 4

declare module 'pinia' {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  export interface DefineStoreOptionsBase<S extends StateTree, Store> {
    /**
     * Persist store in storage.
     * @docs https://github.com/prazdevs/pinia-plugin-persistedstate.
     */
    storage?: StorageOptions<S>
  }

  export interface PiniaCustomProperties {
    // you can define simpler values too
    restored: Promise<boolean>
    flushPersistence: () => Promise<void>
    rehydrate: () => Promise<void>
  }
}

export function createStoragePlugin(
  storage: LevelDB,
  metadataPromise: Promise<StoreMetadata>,
): PiniaPlugin {
  return ({ store, options }) => {
    if (!options.storage) {
      return {
        restored: Promise.resolve(true),
        flushPersistence: () => Promise.resolve(),
        rehydrate: () => Promise.resolve(),
      }
    }
    const { save, restore } = options.storage

    let isRehydrating = false
    async function hydrate(metadata: StoreMetadata) {
      const partialState = await restore(storage, metadata, store.$state)
      isRehydrating = true
      try {
        store.$patch(partialState)
        await nextTick()
      } finally {
        isRehydrating = false
      }
    }
    const restored = metadataPromise.then(async metadata => {
      await hydrate(metadata)
      return true
    })

    // Count mutations synchronously without changing the existing batched save
    // behavior. flushPersistence() snapshots this counter before yielding to
    // Vue's subscription queue, so a mutation immediately followed by a barrier
    // cannot slip through before its save has even been started.
    let issuedMutation = 0
    let processedMutation = 0
    store.$subscribe(
      () => {
        if (isRehydrating) return
        issuedMutation += 1
      },
      { flush: 'sync' },
    )

    // Keep physical completion separate from the sticky first error. A rejected write still
    // poisons this store's barrier for the application lifetime, but later writes must drain
    // before flushPersistence() surfaces that retained error.
    let writeDrain = Promise.resolve()
    let hasPersistenceError = false
    let persistenceError: unknown
    store.$subscribe((mutation, state) => {
      if (isRehydrating) return
      processedMutation = issuedMutation
      let write: Promise<void>
      try {
        write = save(storage, mutation, state)
      } catch (err) {
        write = Promise.reject(err)
      }
      const observedWrite = write.catch(error => {
        if (!hasPersistenceError) {
          hasPersistenceError = true
          persistenceError = error
        }
      })
      writeDrain = Promise.all([writeDrain, observedWrite]).then(
        () => undefined,
      )
    })

    return {
      restored,
      async flushPersistence() {
        const targetMutation = issuedMutation
        if (processedMutation < targetMutation) {
          await nextTick()
        }
        await writeDrain
        if (hasPersistenceError) throw persistenceError
      },
      async rehydrate() {
        const metadata = await metadataPromise
        await hydrate(metadata)
      },
    }
  }
}

export default boot(({ app }) => {
  // const walletStore = useWalletStore()
  const pinia = createPinia()

  app.use(pinia)
  const storage = level('vuex-store')
  const metadataPromise = new Promise<StoreMetadata>(resolve => {
    storage
      .get('storeMetadata')
      .then(data => {
        const state = JSON.parse(data)
        resolve({
          networkName: pathOr(displayNetwork, ['networkName'], state),
          version: pathOr(STORE_SCHEMA_VERSION, ['version'], state),
        })
      })
      .catch(() => {
        resolve({
          networkName: displayNetwork,
          version: STORE_SCHEMA_VERSION,
        })
      })
  })

  pinia.use(createStoragePlugin(storage, metadataPromise))
})
