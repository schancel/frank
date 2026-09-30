/**
 * Persistent browser storage for the stored recovery phrase (ticket #370).
 *
 * The wallet seed lives in the browser's IndexedDB. A browser may delete that under storage
 * pressure, and Safari clears script-writable storage after 7 days without a visit unless the site
 * was added to the Home Screen. `navigator.storage.persist()` asks the browser to exempt this
 * origin. The answer is only "yes" or "no": a "no" is not an error, and there is nothing more the
 * page can do about it, so the UI says so plainly and points at the recovery phrase.
 *
 * Nothing here ever throws: an unsupported browser or a rejecting call is reported as a status.
 */
export type PersistentStorageStatus =
  | 'granted'
  | 'not-granted'
  | 'unsupported'
  // Not asked yet, or the browser has not answered (a permission prompt is still open).
  | 'unknown'

type Manager = Partial<Pick<StorageManager, 'persist' | 'persisted'>>

function currentManager(): Manager | undefined {
  return typeof navigator === 'undefined' ? undefined : navigator.storage
}

/** Whether persistence is already granted. Never prompts. */
export async function queryPersistentStorage(
  manager: Manager | undefined = currentManager(),
): Promise<PersistentStorageStatus> {
  if (!manager || typeof manager.persisted !== 'function') return 'unsupported'
  try {
    return (await manager.persisted()) ? 'granted' : 'not-granted'
  } catch {
    return 'not-granted'
  }
}

/** Asks the browser to keep this origin's data (skips the call when already granted). */
export async function requestPersistentStorage(
  manager: Manager | undefined = currentManager(),
): Promise<PersistentStorageStatus> {
  if (!manager || typeof manager.persist !== 'function') return 'unsupported'
  try {
    if (
      typeof manager.persisted === 'function' &&
      (await manager.persisted())
    ) {
      return 'granted'
    }
    return (await manager.persist()) ? 'granted' : 'not-granted'
  } catch {
    return 'not-granted'
  }
}

/** Like `requestPersistentStorage`, but gives up waiting after `ms` ('unknown'): some browsers
 * hold the promise open behind a permission prompt, and signup must not hang on it. */
export async function requestPersistentStorageWithin(
  ms: number,
  manager?: Manager,
): Promise<PersistentStorageStatus> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<PersistentStorageStatus>(resolve => {
    timer = setTimeout(() => resolve('unknown'), ms)
  })
  try {
    return await Promise.race([requestPersistentStorage(manager), timeout])
  } finally {
    clearTimeout(timer)
  }
}
