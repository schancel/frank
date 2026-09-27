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
 * Why this is a separate class rather than a generalization of `MonadHdKeyring`
 * -----------------------------------------------------------------------------
 * This ticket's ownership rules forbid editing `monad-hd-keyring.ts` directly, and that class:
 *   - hardcodes its derivation path prefix to branch `0` (`DERIVATION_PATH_PREFIX =
 *     "m/44'/60'/0'/0"`, not parameterized by branch), and
 *   - keeps its derived `masterNode` as a private field with no accessor, so there's no way to
 *     reach in from outside and derive a different branch off the same root secret.
 * So this module duplicates (deliberately, in full) `MonadHdKeyring`'s narrow constructor surface
 * (`fromMnemonic`/`generate`, holding one BIP-39 mnemonic's derived master node in memory) with
 * only the path prefix changed to branch `1`. A caller that wants both a burn keyring and a change
 * keyring sharing one root secret constructs one of each from the *same* mnemonic --
 * `MonadHdKeyring.fromMnemonic(mnemonic)` and `MonadChangeKeyring.fromMnemonic(mnemonic)` -- which
 * is exactly how a real BIP-44 wallet keeps its external and internal chains in sync under one
 * seed. If `monad-hd-keyring.ts` is ever generalized to take an explicit branch parameter (a
 * follow-up outside this ticket's edit scope), this module becomes a thin wrapper around it
 * instead; nothing downstream (`monad-change-pool.ts`, `monad-change-recovery.ts`) depends on how
 * the derivation itself is implemented, only on `deriveChangeAccount(index)`'s shape.
 */
import * as bip39 from 'bip39'
import { HDNodeWallet, Mnemonic } from 'ethers'

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
 * Holds one root secret (a BIP-39 mnemonic) in memory and derives `m/44'/60'/0'/1/i` change
 * accounts from it on demand. Deterministic: the same mnemonic + index always yields the same
 * address/private key. See this file's header for why this duplicates `MonadHdKeyring` rather
 * than extending it.
 */
export class MonadChangeKeyring {
  private readonly masterNode: HDNodeWallet

  private constructor(masterNode: HDNodeWallet) {
    this.masterNode = masterNode
  }

  /** Generates a brand-new random mnemonic and a change keyring derived from it. In practice, a
   * caller wanting both a burn and a change keyring under one root secret should instead call
   * `MonadHdKeyring.generate()` once and feed its `mnemonic` into `MonadChangeKeyring.
   * fromMnemonic()` -- this method exists mainly for standalone testing/tooling. */
  static generate(): { keyring: MonadChangeKeyring; mnemonic: string } {
    const mnemonic = bip39.generateMnemonic()
    return { keyring: MonadChangeKeyring.fromMnemonic(mnemonic), mnemonic }
  }

  /** Rebuilds a change keyring from a previously-generated (or externally-supplied) mnemonic --
   * the same mnemonic used to build the corresponding `MonadHdKeyring` for burn accounts, so both
   * branches derive from one shared root secret. `passphrase` is the optional BIP-39 25th-word
   * passphrase (defaults to none). */
  static fromMnemonic(mnemonic: string, passphrase = ''): MonadChangeKeyring {
    if (!bip39.validateMnemonic(mnemonic)) {
      throw new Error('Invalid BIP-39 mnemonic')
    }
    const seed = Mnemonic.fromPhrase(mnemonic, passphrase).computeSeed()
    const masterNode = HDNodeWallet.fromSeed(seed)
    return new MonadChangeKeyring(masterNode)
  }

  /** Deterministically derives the change account at `m/44'/60'/0'/1/{index}`. Calling this twice
   * with the same index on keyrings built from the same mnemonic always yields the same address
   * and private key. */
  deriveChangeAccount(index: number): DerivedChangeAccount {
    const node = this.masterNode.derivePath(changeAccountPath(index))
    return { index, address: node.address, privateKey: node.privateKey }
  }
}
