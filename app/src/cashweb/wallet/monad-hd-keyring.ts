/**
 * HD sub-account key derivation for the Monad account pool (ticket #14).
 *
 * Derives BIP-44 `m/44'/60'/0'/0/i` sub-account keypairs from a single root secret, deterministic
 * given the same seed and index (ticket #14's acceptance criterion). This module's chosen root
 * secret is a locally-held BIP-39 mnemonic phrase (`bip39`, already a dependency in
 * `app/package.json`) — see the "Mera" note below for the documented, deferred alternative.
 *
 * Root secret sourcing: mnemonic (this ticket) vs. Mera (deferred follow-up)
 * ---------------------------------------------------------------------------
 * Issue #14's own comment thread flags an alternative root-secret source: Monad's own "Mera"
 * WebAuthn-passkey SDK (`@category-labs/mera`, confirmed on npm — `mera@0.2.0`) derives keys via
 * WebAuthn PRF -> HKDF -> BIP-39 -> BIP-32, landing on the *exact same* `m/44'/60'/0'/0/i` path
 * this module already needs — so the downstream pool/fan-out/lease logic in
 * `monad-account-pool.ts` would be identical either way; only the root-secret source changes.
 *
 * This ticket ships the plain-mnemonic version instead, for one blocking reason (not merely
 * time-boxing): this ticket's ownership rule scopes edits to files under
 * `app/src/cashweb/wallet/` only, and integrating `@category-labs/mera` would require adding it
 * as a new npm dependency in `app/package.json` (and, per its package layout, likely a
 * `@category-labs/mera/viem` adapter alongside a real WebAuthn/passkey browser flow — i.e. a
 * second EVM library next to this codebase's chosen `ethers`, see `monad-account-tx.ts`'s file
 * header for why `ethers` was picked over `viem`) — both squarely out of this ticket's edit scope,
 * and realistically multi-day work to land and test properly even if they weren't.
 *
 * `MonadHdKeyring` is deliberately kept narrow (constructed from a mnemonic, exposes
 * `deriveSubAccount(index)`) so that swapping the root-secret source to Mera's PRF output later is
 * a drop-in: a follow-up ticket only needs a new constructor path that accepts Mera's derived seed
 * bytes instead of a mnemonic phrase, with zero changes to the pool, fan-out funding, or selection
 * logic. Left as a documented follow-up (the issue comment also references two still-unclaimed
 * Monad Foundation "Mera" bounties, non-blocking here).
 */
import * as bip39 from 'bip39'
import { HDNodeWallet, Mnemonic } from 'ethers'

/** BIP-44 path prefix for Monad (coin type 60, same as Ethereum) sub-accounts. `{index}` is
 * appended per-derivation. Matches the path ticket #14 and `PLAN.md`'s M5 both specify verbatim. */
const DERIVATION_PATH_PREFIX = "m/44'/60'/0'/0"

/** Builds the full derivation path for sub-account `index`, e.g. `subAccountPath(3)` ->
 * `"m/44'/60'/0'/0/3"`. */
export function subAccountPath(index: number): string {
  if (!Number.isInteger(index) || index < 0) {
    throw new Error(
      `Sub-account index must be a non-negative integer, got ${index}`,
    )
  }
  return `${DERIVATION_PATH_PREFIX}/${index}`
}

/** A single derived sub-account keypair. Callers should treat this as ephemeral: the pool's
 * persisted state (`storage/sub-account-pool-storage.ts`) only ever stores
 * `{ index, address, status }`, never the private key — it's always cheaply and deterministically
 * re-derivable from the root secret + index, so there's no reason to write it to disk. */
export interface DerivedSubAccount {
  index: number
  address: string
  privateKey: string
}

/**
 * Holds one root secret (a BIP-39 mnemonic, in this ticket's implementation) in memory and derives
 * `m/44'/60'/0'/0/i` sub-account keypairs from it on demand. Deterministic: the same mnemonic +
 * index always yields the same address/private key, so nothing about a derived sub-account itself
 * needs to be persisted beyond its index (see `SubAccountPoolStore`).
 */
export class MonadHdKeyring {
  private readonly masterNode: HDNodeWallet

  private constructor(masterNode: HDNodeWallet) {
    this.masterNode = masterNode
  }

  /** Generates a brand-new random mnemonic (English wordlist, 128 bits of entropy / 12 words) and
   * a keyring derived from it. Callers are responsible for persisting `mnemonic` securely — raw,
   * production-grade secret storage is an explicit non-goal of this ticket (see `PLAN.md`), and
   * this module never writes the mnemonic or any derived private key to disk itself. */
  static generate(): { keyring: MonadHdKeyring; mnemonic: string } {
    const mnemonic = bip39.generateMnemonic()
    return { keyring: MonadHdKeyring.fromMnemonic(mnemonic), mnemonic }
  }

  /** Rebuilds a keyring from a previously-generated (or externally-supplied) mnemonic phrase, e.g.
   * after loading it back from wherever the caller chose to store it. `passphrase` is the optional
   * BIP-39 25th-word passphrase (defaults to none). */
  static fromMnemonic(mnemonic: string, passphrase = ''): MonadHdKeyring {
    if (!bip39.validateMnemonic(mnemonic)) {
      throw new Error('Invalid BIP-39 mnemonic')
    }
    const seed = Mnemonic.fromPhrase(mnemonic, passphrase).computeSeed()
    const masterNode = HDNodeWallet.fromSeed(seed)
    return new MonadHdKeyring(masterNode)
  }

  /** Deterministically derives the sub-account at `m/44'/60'/0'/0/{index}`. Calling this twice
   * with the same index on keyrings built from the same mnemonic always yields the same address
   * and private key. */
  deriveSubAccount(index: number): DerivedSubAccount {
    const node = this.masterNode.derivePath(subAccountPath(index))
    return { index, address: node.address, privateKey: node.privateKey }
  }
}
