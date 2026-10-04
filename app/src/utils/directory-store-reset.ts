/**
 * Recovery of a browser directory store whose first enrollment never completed (#778).
 *
 * Opening an admission store in `new` mode creates its IndexedDB database before any evidence is
 * admitted. If that first enrollment then fails, the database stays behind with only its format row, and
 * `new` refuses an existing database. This removes such a database, and only such a database: one
 * that holds any other record is admitted state and is always retained.
 */
const RECORDS = 'records'
const FORMAT_KEY = 'format'

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
      const retain = () => {
        db.close()
        resolve('retained')
      }
      if (created) return remove('absent')
      if (db.objectStoreNames.length === 0) return remove('discarded')
      if (
        db.objectStoreNames.length !== 1 ||
        !db.objectStoreNames.contains(RECORDS)
      )
        return retain()
      // A store that never admitted anything holds at most its format row; an admitted one also
      // holds its marker, head and evidence records.
      const count = db
        .transaction(RECORDS, 'readonly')
        .objectStore(RECORDS)
        .getAllKeys(null, 2)
      count.onsuccess = () =>
        count.result.every(key => key === FORMAT_KEY)
          ? remove('discarded')
          : retain()
      count.onerror = () => {
        db.close()
        unavailable()
      }
    }
  })
}
