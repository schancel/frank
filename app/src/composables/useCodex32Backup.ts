import { ref } from 'vue'
import { accountSession } from '../accounts/session'

const PRESETS: ReadonlyArray<readonly [number, number]> = [
  [2, 3],
  [3, 5],
  [6, 10],
]

export function useCodex32Backup() {
  const showBackupDialog = ref(false)
  const backupLoading = ref(false)
  const backupError = ref('')
  const backupShares = ref<string[]>([])
  const copyStatus = ref('')
  const threshold = ref(2)
  const count = ref(3)

  async function generateShares(t = threshold.value, c = count.value) {
    threshold.value = t
    count.value = c
    backupLoading.value = true
    backupError.value = ''
    try {
      if (typeof accountSession?.backupCodex32 === 'function') {
        backupShares.value = await accountSession.backupCodex32(t, c)
      } else {
        throw new Error('Backup service is unavailable')
      }
    } catch (err) {
      backupError.value =
        (err as Error)?.message || 'Failed to generate backup shares'
    } finally {
      backupLoading.value = false
    }
  }

  async function openBackupDialog() {
    showBackupDialog.value = true
    backupError.value = ''
    copyStatus.value = ''
    if (backupShares.value.length === 0) {
      await generateShares(threshold.value, count.value)
    }
  }

  function closeBackupDialog() {
    showBackupDialog.value = false
    backupShares.value = []
    backupError.value = ''
    copyStatus.value = ''
    threshold.value = 2
    count.value = 3
  }

  async function cycleScheme() {
    let nextIndex = 0
    const currentIndex = PRESETS.findIndex(
      ([t, c]) => t === threshold.value && c === count.value,
    )
    if (currentIndex >= 0) {
      nextIndex = (currentIndex + 1) % PRESETS.length
    }
    const [nextT, nextC] = PRESETS[nextIndex] ?? [2, 3]
    await generateShares(nextT, nextC)
  }

  async function setScheme(t: number, c: number) {
    if (t < 2 || t > 9 || c < t || c > 31) return
    await generateShares(t, c)
  }

  async function copyShare(share: string, index: number) {
    try {
      await navigator.clipboard.writeText(share)
      copyStatus.value = `Share ${index + 1} copied.`
    } catch {
      copyStatus.value = 'Failed to copy share.'
    }
  }

  return {
    showBackupDialog,
    backupLoading,
    backupError,
    backupShares,
    copyStatus,
    threshold,
    count,
    openBackupDialog,
    closeBackupDialog,
    cycleScheme,
    setScheme,
    generateShares,
    copyShare,
  }
}
