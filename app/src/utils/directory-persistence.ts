/** Browser persistence for caller-owned directory continuity, outside admission IndexedDB. */
import {
  parseCheckpoint,
  serializeCheckpoint,
  type OpenDirectoryDeps,
} from '@frank/cashweb/relay/open-directory'

const CHECKPOINT_PREFIX = 'frank-directory-checkpoint:'
const PIN_PREFIX = 'frank-directory-pin:'

/** Access storage at each operation so unavailable/quota/parse failures reach the caller. */
export function browserDirectoryPersistence(): Pick<
  OpenDirectoryDeps,
  'checkpoints' | 'pins'
> {
  return {
    checkpoints: {
      load(key) {
        const saved = globalThis.localStorage.getItem(CHECKPOINT_PREFIX + key)
        return saved === null ? null : parseCheckpoint(saved)
      },
      save(key, checkpoint) {
        globalThis.localStorage.setItem(
          CHECKPOINT_PREFIX + key,
          serializeCheckpoint(checkpoint),
        )
      },
    },
    pins: {
      load: key => globalThis.localStorage.getItem(PIN_PREFIX + key),
      save(key, value) {
        if (value === '') globalThis.localStorage.removeItem(PIN_PREFIX + key)
        else globalThis.localStorage.setItem(PIN_PREFIX + key, value)
      },
    },
  }
}
