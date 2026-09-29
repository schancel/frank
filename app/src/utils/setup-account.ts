import { validateMnemonic } from 'bip39'
import { requireValidProfileDisplayName } from '@frank/wallet/profile-display-name'

/** Canonical form accepted by Frank's current English BIP-39 setup UI. */
export function normalizeSetupMnemonic(seed: string): string {
  return seed.toLowerCase().trim()
}

/**
 * Validate at the final setup boundary, then hand exactly the validated value to
 * the wallet store. This prevents a stale, eagerly-generated seed from winning
 * when the user chose Import Account.
 */
export function commitValidatedSetupSeed(
  seed: string,
  persistSeed: (seed: string) => void,
): string {
  const normalizedSeed = normalizeSetupMnemonic(seed)
  if (!validateMnemonic(normalizedSeed)) {
    throw new Error('Invalid BIP-39 mnemonic')
  }
  persistSeed(normalizedSeed)
  return normalizedSeed
}

/** Import Account collects no public name; it keeps the historical placeholder. */
export const IMPORTED_ACCOUNT_DEFAULT_NAME = 'Frank User'

/** Revalidate a required (New Account) name at setup's final persistence boundary and persist
 * exactly the canonical value. When no name was requested (Import Account) the historical
 * default is persisted unchanged. */
export function commitValidatedSetupName(
  name: string,
  nameRequired: boolean | undefined,
  persistName: (name: string) => void,
): string {
  const committedName =
    nameRequired !== false
      ? requireValidProfileDisplayName(name)
      : name || IMPORTED_ACCOUNT_DEFAULT_NAME
  persistName(committedName)
  return committedName
}
