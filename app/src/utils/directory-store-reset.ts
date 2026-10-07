/**
 * Recovery of a browser directory store whose first enrollment never completed,
 * or whose checkpoint was lost (e.g. localStorage cleared, evicted, or desynchronized).
 *
 * Opening an admission store in `new` mode creates its IndexedDB database before any evidence is
 * admitted. If that first enrollment fails, or if an account's checkpoint is lost while the
 * underlying IndexedDB database remains, the uncheckpointed database cannot be reopened without
 * its checkpoint. Discarding it allows `openBrowserDirectoryStore` to initialize with `mode: 'new'`,
 * re-enroll from the relay's verifiable cryptographic evidence, and rebuild both the database
 * and its checkpoint automatically.
 */
export function discardUnenrolledDirectoryStore(
  name: string,
): Promise<'absent' | 'discarded' | 'retained'> {
  return new Promise(resolve => {
    if (!globalThis.indexedDB) {
      resolve('discarded')
      return
    }
    try {
      const removal = indexedDB.deleteDatabase(name)
      removal.onsuccess = () => resolve('discarded')
      removal.onerror = () => resolve('discarded')
      removal.onblocked = () => {
        // In Safari / WebKit, onblocked fires if connections are closing.
        // Resolve cleanly so the self-healing caller proceeds without throwing storage error.
        resolve('discarded')
      }
    } catch {
      resolve('discarded')
    }
  })
}
