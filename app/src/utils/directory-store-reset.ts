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
  return new Promise((resolve, reject) => {
    const unavailable = () => reject(new Error('Directory store unavailable'))
    const request = indexedDB.open(name)
    let created = false
    // Fires only when no database existed; it is removed again below.
    request.onupgradeneeded = () => {
      created = true
    }
    request.onerror = unavailable
    request.onblocked = unavailable
    request.onsuccess = () => {
      const db = request.result
      const remove = (outcome: 'absent' | 'discarded') => {
        db.close()
        const removal = indexedDB.deleteDatabase(name)
        removal.onsuccess = () => resolve(outcome)
        removal.onerror = unavailable
        removal.onblocked = unavailable
      }
      if (created) return remove('absent')
      // A database without an acknowledged checkpoint cannot be reopened.
      // Discard it so `openStore` in `new` mode can rebuild it from authoritative relay evidence.
      return remove('discarded')
    }
  })
}
