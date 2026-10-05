import { ref } from 'vue'

export const WALLET_NAMES_STORAGE_KEY = 'frank:wallet_custom_names'

function loadStoredNames(): Record<string, string> {
  try {
    if (typeof window !== 'undefined' && window.localStorage) {
      const raw = window.localStorage.getItem(WALLET_NAMES_STORAGE_KEY)
      if (raw) {
        const parsed = JSON.parse(raw)
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          return parsed as Record<string, string>
        }
      }
    }
  } catch {
    // Storage access may be restricted or throw in certain environments
  }
  return {}
}

function saveStoredNames(names: Record<string, string>) {
  try {
    if (typeof window !== 'undefined' && window.localStorage) {
      window.localStorage.setItem(WALLET_NAMES_STORAGE_KEY, JSON.stringify(names))
    }
  } catch {
    // Storage access may be restricted or throw in certain environments
  }
}

const customNames = ref<Record<string, string>>(loadStoredNames())

export function useWalletNames() {
  function initWalletNames() {
    customNames.value = loadStoredNames()
  }

  function getCustomName(chain: string): string {
    return customNames.value[chain] || ''
  }

  function setCustomName(chain: string, name: string) {
    const trimmed = name.trim()
    const updated = { ...customNames.value }
    if (trimmed) {
      updated[chain] = trimmed
    } else {
      delete updated[chain]
    }
    customNames.value = updated
    saveStoredNames(updated)
  }

  function resetCustomName(chain: string) {
    const updated = { ...customNames.value }
    delete updated[chain]
    customNames.value = updated
    saveStoredNames(updated)
  }

  function clearAllCustomNames() {
    customNames.value = {}
    try {
      if (typeof window !== 'undefined' && window.localStorage) {
        window.localStorage.removeItem(WALLET_NAMES_STORAGE_KEY)
      }
    } catch {
      // ignore
    }
  }

  return {
    customNames,
    initWalletNames,
    getCustomName,
    setCustomName,
    resetCustomName,
    clearAllCustomNames,
  }
}
