import { ref } from 'vue'
import { accountSession } from '../accounts/session'

export function useCodex32Backup() {
  const showBackupDialog = ref(false)
  const backupLoading = ref(false)
  const backupError = ref('')
  const backupShares = ref<string[]>([])
  const copyStatus = ref('')

  async function openBackupDialog() {
    showBackupDialog.value = true
    backupError.value = ''
    copyStatus.value = ''
    if (backupShares.value.length === 0) {
      backupLoading.value = true
      try {
        if (typeof accountSession?.backupCodex32 === 'function') {
          backupShares.value = await accountSession.backupCodex32(2, 3)
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
  }

  function closeBackupDialog() {
    showBackupDialog.value = false
    backupShares.value = []
    backupError.value = ''
    copyStatus.value = ''
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
    openBackupDialog,
    closeBackupDialog,
    copyShare,
  }
}
