import { ref } from 'vue'
import {
  AccountBackupUnavailableError,
  accountSession,
} from '../accounts/session'

const PRESETS: ReadonlyArray<readonly [number, number]> = [
  [2, 3],
  [3, 5],
  [6, 10],
]

/**
 * State for the Settings backup page. Nothing secret is read or computed until
 * `generateShares` is called by an explicit user action; choosing a scheme only records the
 * choice and drops any shares already shown.
 */
export function useCodex32Backup() {
  const backupLoading = ref(false)
  const backupError = ref('')
  /** This account predates stored account roots: no shares can be issued for it. */
  const backupUnavailable = ref(false)
  const backupShares = ref<string[]>([])
  const threshold = ref(2)
  const count = ref(3)
  let request = 0

  /** Drop shown shares and abandon any set still being issued. */
  function clearShares() {
    request++
    backupShares.value = []
    backupError.value = ''
    backupLoading.value = false
  }

  async function generateShares() {
    clearShares()
    const current = request
    backupLoading.value = true
    backupUnavailable.value = false
    try {
      const shares = await accountSession.backupCodex32(
        threshold.value,
        count.value,
      )
      // The user left or chose another scheme meanwhile: this set is never shown.
      if (current === request) backupShares.value = shares
    } catch (err) {
      if (current !== request) return
      if (err instanceof AccountBackupUnavailableError) {
        backupUnavailable.value = true
      } else {
        backupError.value =
          (err as Error)?.message || 'Failed to generate backup shares'
      }
    } finally {
      if (current === request) backupLoading.value = false
    }
  }

  function setScheme(t: number, c: number) {
    if (t < 2 || t > 9 || c < t || c > 31) return
    clearShares()
    threshold.value = t
    count.value = c
  }

  function cycleScheme() {
    const currentIndex = PRESETS.findIndex(
      ([t, c]) => t === threshold.value && c === count.value,
    )
    const [nextT, nextC] = PRESETS[(currentIndex + 1) % PRESETS.length] ?? [
      2, 3,
    ]
    setScheme(nextT, nextC)
  }

  return {
    backupLoading,
    backupError,
    backupUnavailable,
    backupShares,
    threshold,
    count,
    cycleScheme,
    setScheme,
    generateShares,
    clearShares,
  }
}
