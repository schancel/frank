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

/** Revalidate at setup's final persistence boundary and persist exactly the canonical value. */
export function commitValidatedSetupName(
  name: string,
  persistName: (name: string) => void,
): string {
  const normalizedName = requireValidProfileDisplayName(name)
  persistName(normalizedName)
  return normalizedName
}
