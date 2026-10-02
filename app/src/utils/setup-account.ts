import { validateMnemonic, wordlists } from 'bip39'
import { requireValidProfileDisplayName } from '@frank/wallet/profile-display-name'

/** Canonical form accepted by Frank's current English BIP-39 setup UI. */
export function normalizeSetupMnemonic(seed: string): string {
  return seed.toLowerCase().trim().replace(/\s+/g, ' ')
}

export type MnemonicValidationReason =
  | 'word-count'
  | 'unrecognized-words'
  | 'invalid-checksum'
  | 'invalid'

const englishBip39Words: Set<string> | null =
  wordlists && wordlists.english ? new Set(wordlists.english) : null

/**
 * Identify why a recovery phrase candidate fails BIP-39 validation,
 * or return null if it is valid or empty.
 * Never throws, logs, or returns secret words.
 */
export function getMnemonicValidationReason(
  seed: string,
): MnemonicValidationReason | null {
  const normalized = normalizeSetupMnemonic(seed)
  if (!normalized) return null
  const words = normalized.split(' ').filter(Boolean)
  if (![12, 15, 18, 21, 24].includes(words.length)) {
    return 'word-count'
  }
  if (englishBip39Words) {
    if (words.some(word => !englishBip39Words.has(word))) {
      return 'unrecognized-words'
    }
  }
  if (!validateMnemonic(normalized)) {
    return 'invalid-checksum'
  }
  return null
}

/**
 * Return the translation key describing why the seed is invalid,
 * or null if the seed is empty or valid.
 */
export function getMnemonicValidationKey(seed: string): string | null {
  const reason = getMnemonicValidationReason(seed)
  switch (reason) {
    case 'word-count':
      return 'accountStep.invalidWordCount'
    case 'unrecognized-words':
      return 'accountStep.unrecognizedWords'
    case 'invalid-checksum':
      return 'accountStep.invalidChecksum'
    case 'invalid':
      return 'profile.invalidSeed'
    default:
      return null
  }
}

/**
 * Validate at the final setup boundary, then hand exactly the validated value to
 * the wallet store. This prevents a stale, eagerly-generated seed from winning
 * when the user chose Import Account.
 */
export function commitValidatedSetupSeed(
  seed: string,
  persistSeed: (seed: string, confirmedAt: number | null) => void,
  confirmedAt: number | null = null,
): string {
  const normalizedSeed = normalizeSetupMnemonic(seed)
  if (!validateMnemonic(normalizedSeed)) {
    throw new Error('Invalid BIP-39 mnemonic')
  }
  persistSeed(normalizedSeed, confirmedAt)
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

/**
 * Seed offered to the New Account step. An already-stored seed is returned
 * untouched (never regenerated or overwritten); otherwise a fresh draft is
 * generated in memory only. Nothing here writes to the wallet store: a seed is
 * persisted solely by commitValidatedSetupSeed() when the user finishes the
 * account step, so merely visiting /setup cannot create a real account.
 */
export function initialSetupSeed(
  storedSeed: string | null | undefined,
  generate: () => string,
): string {
  return storedSeed || generate()
}

/** Number of recovery-phrase words the user is asked to re-enter. */
export const CONFIRMATION_WORD_COUNT = 3

/** A recovery-phrase confirmation challenge, bound to the phrase it was made for. */
export interface SeedConfirmationChallenge {
  seed: string
  /** 1-based word positions, ascending and distinct. */
  positions: number[]
}

/** Uniform integer in [0, max) from the platform CSPRNG (rejection sampling, no modulo bias). */
export function cryptoRandomInt(max: number): number {
  const c = (globalThis as { crypto?: Crypto }).crypto
  if (!c || typeof c.getRandomValues !== 'function') {
    // Never fall back to Math.random for anything derived from wallet secrets.
    throw new Error('Secure random number generator unavailable')
  }
  const range = 0x1_0000_0000
  const limit = range - (range % max)
  const buf = new Uint32Array(1)
  for (;;) {
    c.getRandomValues(buf)
    if (buf[0] < limit) return buf[0] % max
  }
}

/** Choose `count` distinct 1-based word positions out of `wordCount`, sorted ascending. */
export function pickConfirmationPositions(
  wordCount: number,
  count: number = CONFIRMATION_WORD_COUNT,
  randomInt: (max: number) => number = cryptoRandomInt,
): number[] {
  const pool = Array.from({ length: wordCount }, (_, i) => i + 1)
  const picked: number[] = []
  while (picked.length < count && pool.length > 0) {
    picked.push(pool.splice(randomInt(pool.length), 1)[0])
  }
  return picked.sort((a, b) => a - b)
}

/**
 * The challenge for `seed`. The previous challenge is returned untouched while the phrase is
 * unchanged (stable across re-renders and step re-entry); a different phrase gets fresh positions.
 */
export function ensureConfirmationChallenge(
  previous: SeedConfirmationChallenge | null,
  seed: string,
  randomInt: (max: number) => number = cryptoRandomInt,
): SeedConfirmationChallenge {
  const normalized = normalizeSetupMnemonic(seed)
  if (previous && previous.seed === normalized) return previous
  const wordCount = normalized.split(/\s+/).filter(Boolean).length
  return {
    seed: normalized,
    positions: pickConfirmationPositions(
      wordCount,
      CONFIRMATION_WORD_COUNT,
      randomInt,
    ),
  }
}

/**
 * Indexes (into `positions`/`answers`) of the answers that do not match the phrase's word at that
 * position, after the same trim + lowercase normalization as always. Returns indexes only, never
 * the words, so callers cannot leak the right answer.
 */
export function wrongConfirmationIndexes(
  seed: string,
  positions: number[],
  answers: string[],
): number[] {
  const words = normalizeSetupMnemonic(seed).split(/\s+/)
  const wrong: number[] = []
  positions.forEach((position, i) => {
    const expected = words[position - 1]
    if (!expected || expected !== (answers[i] ?? '').trim().toLowerCase())
      wrong.push(i)
  })
  return wrong
}

/** True only if every requested position was answered with exactly the phrase's word. */
export function checkConfirmationAnswers(
  seed: string,
  positions: number[],
  answers: string[],
): boolean {
  return (
    positions.length > 0 &&
    positions.length === answers.length &&
    wrongConfirmationIndexes(seed, positions, answers).length === 0
  )
}
