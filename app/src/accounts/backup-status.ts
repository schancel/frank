const BACKUP_STORAGE_KEY = 'frank:backed-up-accounts'

function getBackedUpSet(): Set<string> {
  try {
    if (typeof localStorage === 'undefined') return new Set()
    const raw = localStorage.getItem(BACKUP_STORAGE_KEY)
    if (!raw) return new Set()
    const parsed = JSON.parse(raw)
    return new Set(Array.isArray(parsed) ? parsed : [])
  } catch {
    return new Set()
  }
}

export function isAccountBackedUp(accountId?: string | null): boolean {
  if (!accountId) return false
  return getBackedUpSet().has(accountId)
}

export function markAccountBackedUp(accountId?: string | null): void {
  if (!accountId) return
  try {
    const set = getBackedUpSet()
    set.add(accountId)
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(BACKUP_STORAGE_KEY, JSON.stringify([...set]))
    }
  } catch {
    // ignore storage quota / access issues
  }
}

export function clearAccountBackedUp(accountId?: string | null): void {
  try {
    if (typeof localStorage === 'undefined') return
    if (!accountId) {
      localStorage.removeItem(BACKUP_STORAGE_KEY)
    } else {
      const set = getBackedUpSet()
      set.delete(accountId)
      localStorage.setItem(BACKUP_STORAGE_KEY, JSON.stringify([...set]))
    }
  } catch {
    // ignore
  }
}
