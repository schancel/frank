import { reactive, readonly } from 'vue'

const status = reactive({ present: false, unavailable: false, revision: 0 })
export const legacyStatus = readonly(status)
let storage: { get(key: string): Promise<string> } | undefined
let observed: string | undefined

/** Read-only quarantine: the original blob never enters a store or normal wallet. */
export async function inspectLegacyWallet(source: {
  get(key: string): Promise<string>
}) {
  storage = source
  try {
    let raw: string | undefined
    try {
      raw = await source.get('wallet')
    } catch (error) {
      if (!(error as { notFound?: boolean })?.notFound) throw error
    }
    if (raw !== observed) status.revision++
    observed = raw
    const value = raw === undefined ? null : JSON.parse(raw)
    status.present = !!(value?.seedPhrase || value?.xPrivKey)
    status.unavailable = false
  } catch {
    status.unavailable = true
    status.present = true
  }
}

export async function assertLegacyUnchanged(revision: number) {
  if (!storage) throw new Error('Legacy storage unavailable')
  await inspectLegacyWallet(storage)
  if (status.unavailable || status.revision !== revision)
    throw new Error('Existing account changed; restart explicitly')
}

/** Retry only the original read-only adapter; never rewrite quarantined bytes. */
export async function retryLegacyInspection() {
  if (storage) await inspectLegacyWallet(storage)
}

/** Explicit local migration only. No wallet, network, or persistence is constructed. */
export async function identifyLegacyAccount(phrase: string): Promise<string> {
  if (phrase.length > 512) throw new Error('Invalid legacy phrase')
  const { validateMnemonic } = await import('bip39')
  const canonical = phrase.trim().toLowerCase().replace(/\s+/g, ' ')
  if (!validateMnemonic(canonical)) throw new Error('Invalid legacy phrase')
  const { MonadIdentity } = await import('@frank/wallet/monad-identity')
  return MonadIdentity.fromSeed({ mnemonic: canonical }).displayAddress
}

export { importBip39Wallet } from './session'
