/**
 * HD change-account key derivation for Monad (ticket #36).
 *
 * Derives BIP-44 `m/44'/60'/0'/1/i` **change** keypairs -- branch `1`, mirroring Bitcoin's
 * BIP-44 internal/external chain split (`.../0/i` = external/spend, `.../1/i` = internal/change).
 * This is the sibling of `./monad-hd-keyring.ts`'s `MonadHdKeyring`, which derives the burn/spend
 * side on branch `0` (ticket #14). See `./monad-change-pool.ts` for how these change accounts get
 * used: a spent burn account's leftover balance (ticket #34's `'spent'` outcome) is swept here
 * instead of being abandoned in the dead burn account.
 *
 * The class is separate from `MonadHdKeyring` so callers cannot accidentally derive change and
 * spend addresses through the wrong branch. Both consume the same EVM wallet-domain root.
 */
import * as bip39 from 'bip39'
import { HDNodeWallet, Mnemonic } from 'ethers'
import { MonadDomainRoot, monadMasterFromDomainRoot } from './monad-domain-root'

/** BIP-44 path prefix for Monad (coin type 60) **change** accounts -- branch `1`, as opposed to
 * `monad-hd-keyring.ts`'s branch `0` burn/spend accounts. `{index}` is appended per-derivation. */
const CHANGE_DERIVATION_PATH_PREFIX = "m/44'/60'/0'/1"

/** Builds the full derivation path for change account `index`, e.g. `changeAccountPath(3)` ->
 * `"m/44'/60'/0'/1/3"`. */
export function changeAccountPath(index: number): string {
  if (!Number.isInteger(index) || index < 0) {
    throw new Error(
      `Change account index must be a non-negative integer, got ${index}`,
    )
  }
  return `${CHANGE_DERIVATION_PATH_PREFIX}/${index}`
}

/** A single derived change-account keypair. Like `DerivedSubAccount` (`monad-hd-keyring.ts`),
 * never persisted with its private key -- cheaply and deterministically re-derivable from the
 * root secret + index on demand. */
export interface DerivedChangeAccount {
  index: number
  address: string
  privateKey: string
}

/**
 * Holds one EVM wallet-domain root in memory and derives `m/44'/60'/0'/1/i` change accounts.
 */
export class MonadChangeKeyring {
  private readonly masterNode: HDNodeWallet

  private constructor(masterNode: HDNodeWallet) {
    this.masterNode = masterNode
  }

  /** Builds the change keyring from the same already-separated EVM wallet-domain output. */
  static fromDomainRoot(
    domainRoot: MonadDomainRoot<'evm-wallet'>,
  ): MonadChangeKeyring {
    return new MonadChangeKeyring(
      monadMasterFromDomainRoot(domainRoot, 'evm-wallet'),
    )
  }

  /** @deprecated Legacy test/import helper. Generates a mnemonic and change keyring. In practice, a
   * caller wanting both a burn and a change keyring under one root secret should instead call
   * `MonadHdKeyring.generate()` once and feed its `mnemonic` into `MonadChangeKeyring.
   * fromMnemonic()` -- this method exists mainly for standalone testing/tooling. */
  static generate(): { keyring: MonadChangeKeyring; mnemonic: string } {
    const mnemonic = bip39.generateMnemonic()
    return { keyring: MonadChangeKeyring.fromMnemonic(mnemonic), mnemonic }
  }

  /** @deprecated Legacy recovery/import constructor. */
  static fromMnemonic(mnemonic: string, passphrase = ''): MonadChangeKeyring {
    if (!bip39.validateMnemonic(mnemonic)) {
      throw new Error('Invalid BIP-39 mnemonic')
    }
    const seed = Mnemonic.fromPhrase(mnemonic, passphrase).computeSeed()
    const masterNode = HDNodeWallet.fromSeed(seed)
    return new MonadChangeKeyring(masterNode)
  }

  /** Deterministically derives the change account at `m/44'/60'/0'/1/{index}`. */
  deriveChangeAccount(index: number): DerivedChangeAccount {
    const node = this.masterNode.derivePath(changeAccountPath(index))
    return { index, address: node.address, privateKey: node.privateKey }
  }
}
