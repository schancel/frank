import { LevelMessageStore } from '@frank/cashweb/relay/storage/level-storage'
// import { Platform } from 'quasar'

async function createStore(): Promise<LevelMessageStore> {
  // if (Platform.is.electron) {
  //   // eslint-disable-next-line @typescript-eslint/no-explicit-any
  //   return (window as any).messageStore
  // }
  const store = new LevelMessageStore('MessageStore')
  await store.Open()

  // Path doesn't matter. We're using indexdb
  return store
}

export const store = createStore()

// Opening starts at module import, before setup-apis can await chat restoration. Observe an
// early failure immediately, while preserving the original rejection for the startup boundary.
void store.catch(() => undefined)
