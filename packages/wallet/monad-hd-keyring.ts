/**
 * HD sub-account key derivation for the Monad account pool (ticket #14).
 *
 * Derives BIP-44 `m/44'/60'/0'/0/i` sub-account keypairs from one already-separated EVM wallet
 * domain root. The Codex32 derivation registry owns how that root is produced and whether this
 * existing BIP-32 interpretation is approved. Mnemonic generation and import remain legacy leaves.
 */
import * as bip39 from 'bip39'
import { HDNodeWallet, Mnemonic, getBytes } from 'ethers'
import { MonadDomainRoot, monadMasterFromDomainRoot } from './monad-domain-root'

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
 * Holds one EVM wallet-domain root in memory and derives `m/44'/60'/0'/0/i` sub-account keypairs
 * from it on demand. Nothing about a derived sub-account needs to be persisted beyond its index.
 */
export class MonadHdKeyring {
  private readonly masterNode: HDNodeWallet

  private constructor(masterNode: HDNodeWallet) {
    this.masterNode = masterNode
  }

  /** Builds the spend/burn keyring from its already-separated registry output. */
  static fromDomainRoot(
    domainRoot: MonadDomainRoot<'evm-wallet'>,
  ): MonadHdKeyring {
    return new MonadHdKeyring(
      monadMasterFromDomainRoot(domainRoot, 'evm-wallet'),
    )
  }

  /** @deprecated Legacy test/import helper; production Codex32 creation is not enabled yet.
   * Generates a random mnemonic (English wordlist, 128 bits of entropy / 12 words) and
   * a keyring derived from it. Callers are responsible for persisting `mnemonic` securely — raw,
   * production-grade secret storage is an explicit non-goal of this ticket (see `PLAN.md`), and
   * this module never writes the mnemonic or any derived private key to disk itself. */
  static generate(): { keyring: MonadHdKeyring; mnemonic: string } {
    const mnemonic = bip39.generateMnemonic()
    return { keyring: MonadHdKeyring.fromMnemonic(mnemonic), mnemonic }
  }

  /** @deprecated Legacy recovery/import constructor. */
  static fromMnemonic(mnemonic: string, passphrase = ''): MonadHdKeyring {
    if (!bip39.validateMnemonic(mnemonic)) {
      throw new Error('Invalid BIP-39 mnemonic')
    }
    const seed = Mnemonic.fromPhrase(mnemonic, passphrase).computeSeed()
    const masterNode = HDNodeWallet.fromSeed(seed)
    return new MonadHdKeyring(masterNode)
  }

  /** Public-only copy of the actual existing branch; no custody or signing authority. */
  publicBranchDescriptor(): {
    path: string
    publicKey: Uint8Array
    chainCode: Uint8Array
  } {
    const branch = this.masterNode.derivePath(DERIVATION_PATH_PREFIX).neuter()
    return {
      path: DERIVATION_PATH_PREFIX,
      publicKey: getBytes(branch.publicKey),
      chainCode: getBytes(branch.chainCode),
    }
  }

  /** Deterministically derives the sub-account at `m/44'/60'/0'/0/{index}`. */
  deriveSubAccount(index: number): DerivedSubAccount {
    const node = this.masterNode.derivePath(subAccountPath(index))
    return { index, address: node.address, privateKey: node.privateKey }
  }
}
