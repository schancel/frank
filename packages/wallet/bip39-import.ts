/**
 * BIP-39 mnemonic import and multi-path candidate account derivation scanner (Issue #847).
 *
 * Scans candidate BIP-44 derivation paths for active balances, selecting the funded account
 * or defaulting to Frank's canonical identity path (m/44'/60'/1'/0/0).
 */
import * as bip39 from 'bip39'
import {
  HDNodeWallet,
  Mnemonic,
  Wallet,
  type JsonRpcProvider,
  type Provider,
} from 'ethers'
import {
  MONAD_IDENTITY_DERIVATION_PATH,
  MonadIdentity,
} from './monad-identity'
import { MonadHdKeyring } from './monad-hd-keyring'
import { MonadChangeKeyring } from './monad-change-keyring'
import type { MonadWalletMaterial } from './monad-wallet-material'

export const CANONICAL_FRANK_PATH = MONAD_IDENTITY_DERIVATION_PATH // "m/44'/60'/1'/0/0"
export const STANDARD_EVM_PATH = "m/44'/60'/0'/0/0"
export const EARLY_FRANK_PATH = "m/44'/60'/0'/1/0"
export const FRANK_BURNER_POOL_PREFIX = "m/44'/60'/0'/0"

export function burnerPoolPath(index: number): string {
  if (!Number.isInteger(index) || index < 0) {
    throw new Error(`Burner pool index must be non-negative integer, got ${index}`)
  }
  return `${FRANK_BURNER_POOL_PREFIX}/${index}`
}

export const BURNER_POOL_PATHS = Object.freeze(
  [0, 1, 2, 3, 4].map(i => burnerPoolPath(i)),
)

export interface CandidatePath {
  readonly path: string
  readonly label: string
  readonly description: string
}

export const CANDIDATE_PATHS: readonly CandidatePath[] = Object.freeze([
  {
    path: CANONICAL_FRANK_PATH,
    label: 'Canonical Frank',
    description: 'Canonical Frank Monad identity (m/44\'/60\'/1\'/0/0)',
  },
  {
    path: STANDARD_EVM_PATH,
    label: 'Standard EVM',
    description: 'Standard EVM / MetaMask Account 0 (m/44\'/60\'/0\'/0/0)',
  },
  {
    path: EARLY_FRANK_PATH,
    label: 'Early Frank',
    description: 'Early Frank identity path (m/44\'/60\'/0\'/1/0)',
  },
  {
    path: burnerPoolPath(1),
    label: 'Frank Burner 1',
    description: 'Frank sub-account burner pool, index 1 (m/44\'/60\'/0\'/0/1)',
  },
  {
    path: burnerPoolPath(2),
    label: 'Frank Burner 2',
    description: 'Frank sub-account burner pool, index 2 (m/44\'/60\'/0\'/0/2)',
  },
  {
    path: burnerPoolPath(3),
    label: 'Frank Burner 3',
    description: 'Frank sub-account burner pool, index 3 (m/44\'/60\'/0\'/0/3)',
  },
  {
    path: burnerPoolPath(4),
    label: 'Frank Burner 4',
    description: 'Frank sub-account burner pool, index 4 (m/44\'/60\'/0\'/0/4)',
  },
])

export const CANDIDATE_DERIVATION_PATHS = CANDIDATE_PATHS

export interface CandidateAccount {
  readonly path: string
  readonly label: string
  readonly description?: string
  readonly address: string
  readonly privateKey: string
}

export interface ScannedCandidateAccount extends CandidateAccount {
  readonly balance: bigint
}

export interface ScanBip39AccountsParams {
  readonly phrase: string
  readonly passphrase?: string
  readonly provider?: JsonRpcProvider | Provider | { getBalance(address: string): Promise<bigint> } | null
}

export interface ScanBip39AccountsResult extends ScannedCandidateAccount {
  readonly selected: ScannedCandidateAccount
  readonly candidates: readonly ScannedCandidateAccount[]
}

export interface Bip39SeedBundle {
  readonly mnemonic: string
  readonly passphrase?: string
  readonly path: string
  readonly address: string
  readonly privateKey: string
}

export function normalizeMnemonic(phrase: string): string {
  if (typeof phrase !== 'string') {
    throw new Error('Mnemonic phrase must be a string')
  }
  return phrase.trim().toLowerCase().replace(/\s+/g, ' ')
}

/**
 * Derives candidate key and address for each candidate BIP-44 path using ethers Mnemonic/HDNodeWallet.
 */
export function deriveCandidateAccounts(
  phrase: string,
  passphrase = '',
  paths: readonly CandidatePath[] = CANDIDATE_PATHS,
): CandidateAccount[] {
  const cleanPhrase = normalizeMnemonic(phrase)
  if (!bip39.validateMnemonic(cleanPhrase)) {
    throw new Error('Invalid BIP-39 mnemonic')
  }
  const mnemonic = Mnemonic.fromPhrase(cleanPhrase, passphrase)
  const masterNode = HDNodeWallet.fromSeed(mnemonic.computeSeed())

  return paths.map(candidate => {
    const node = masterNode.derivePath(candidate.path)
    return {
      path: candidate.path,
      label: candidate.label,
      description: candidate.description,
      address: node.address,
      privateKey: node.privateKey,
    }
  })
}

/**
 * Queries balance for each candidate address if provider supplied, selects the account
 * with highest non-zero balance, or defaults to canonical path m/44'/60'/1'/0/0 if zero
 * balance or provider unavailable.
 */
export async function scanBip39Accounts(
  params: ScanBip39AccountsParams,
): Promise<ScanBip39AccountsResult> {
  const candidates = deriveCandidateAccounts(params.phrase, params.passphrase)

  const scanned: ScannedCandidateAccount[] = await Promise.all(
    candidates.map(async candidate => {
      let balance = 0n
      if (params.provider && typeof params.provider.getBalance === 'function') {
        try {
          balance = await params.provider.getBalance(candidate.address)
        } catch {
          balance = 0n
        }
      }
      return {
        ...candidate,
        balance,
      }
    }),
  )

  let best: ScannedCandidateAccount | undefined
  for (const account of scanned) {
    if (account.balance > 0n) {
      if (!best || account.balance > best.balance) {
        best = account
      }
    }
  }

  const selected =
    best ??
    scanned.find(c => c.path === CANONICAL_FRANK_PATH) ??
    scanned[0]

  return {
    ...selected,
    selected,
    candidates: scanned,
  }
}

/**
 * Creates wallet material directly from a BIP-39 phrase and selected derivation path.
 */
export function createBip39WalletMaterial(
  phrase: string,
  chosenPath = CANONICAL_FRANK_PATH,
  passphrase = '',
): MonadWalletMaterial {
  const cleanPhrase = normalizeMnemonic(phrase)
  if (!bip39.validateMnemonic(cleanPhrase)) {
    throw new Error('Invalid BIP-39 mnemonic')
  }
  const mnemonic = Mnemonic.fromPhrase(cleanPhrase, passphrase)
  const masterNode = HDNodeWallet.fromSeed(mnemonic.computeSeed())
  const node = masterNode.derivePath(chosenPath)
  const mainAccount = new Wallet(node.privateKey)
  const identity = MonadIdentity.fromPrivateKeyHex(node.privateKey)
  const keyring = MonadHdKeyring.fromMnemonic(cleanPhrase, passphrase)
  const changeKeyring = MonadChangeKeyring.fromMnemonic(cleanPhrase, passphrase)

  return {
    identity,
    mainAccount,
    keyring,
    changeKeyring,
    fingerprint: `bip39:${mainAccount.address.toLowerCase()}`,
    dispose() {},
  }
}

/**
 * Creates seed bundle information from the selected path.
 */
export function createBip39SeedBundle(
  phrase: string,
  chosenPath = CANONICAL_FRANK_PATH,
  passphrase = '',
): Bip39SeedBundle {
  const cleanPhrase = normalizeMnemonic(phrase)
  if (!bip39.validateMnemonic(cleanPhrase)) {
    throw new Error('Invalid BIP-39 mnemonic')
  }
  const mnemonic = Mnemonic.fromPhrase(cleanPhrase, passphrase)
  const masterNode = HDNodeWallet.fromSeed(mnemonic.computeSeed())
  const node = masterNode.derivePath(chosenPath)

  return {
    mnemonic: cleanPhrase,
    passphrase,
    path: chosenPath,
    address: node.address,
    privateKey: node.privateKey,
  }
}

export const createWalletMaterialFromPath = createBip39WalletMaterial
export const createWalletMaterialFromSeed = createBip39WalletMaterial
export const createSeedBundleFromPath = createBip39SeedBundle
