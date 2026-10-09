/**
 * HD sub-account and change key derivation on secp256k1 curve (Issue #953).
 *
 * Provides curve-level abstraction `Secp256k1HdKeyring` supporting parameterized
 * BIP-44 derivation paths across EVM (coin 60'), eCash (coin 1899'), Bitcoin Cash (coin 145'),
 * and Bitcoin (coin 0').
 *
 * Specializes standard EVM spend/change keyrings (`EvmHdKeyring`, `EvmChangeKeyring`)
 * and maintains backwards-compatible aliases for legacy Monad naming.
 */

import * as bip39 from 'bip39'
import { HDNodeWallet, Mnemonic, getBytes } from 'ethers'
import { Bip32DomainRoot, bip32MasterFromDomainRoot } from './bip32-domain-root'

export interface Bip44PathConfig {
  readonly coinType: number // e.g. 60 for EVM, 1899 for eCash, 145 for BCH, 0 for BTC
  readonly account?: number // default 0
  readonly branch?: 0 | 1 // 0 = external/spend, 1 = internal/change. Default 0
}

export function resolveBip44Path(config: Bip44PathConfig | string): string {
  if (typeof config === 'string') {
    return config.replace(/\/+$/, '')
  }
  const coinType = config.coinType
  const account = config.account ?? 0
  const branch = config.branch ?? 0
  if (!Number.isInteger(coinType) || coinType < 0) {
    throw new Error(`coinType must be a non-negative integer, got ${coinType}`)
  }
  if (!Number.isInteger(account) || account < 0) {
    throw new Error(`account must be a non-negative integer, got ${account}`)
  }
  if (branch !== 0 && branch !== 1) {
    throw new Error(`branch must be 0 (spend) or 1 (change), got ${branch}`)
  }
  return `m/44'/${coinType}'/${account}'/${branch}`
}

export function subAccountPathFor(pathPrefix: string, index: number): string {
  if (!Number.isInteger(index) || index < 0) {
    throw new Error(
      `Sub-account index must be a non-negative integer, got ${index}`,
    )
  }
  return `${pathPrefix}/${index}`
}

export interface DerivedKeypair {
  readonly index: number
  readonly address: string
  readonly privateKey: string
  readonly publicKey: string
}

export type DerivedSubAccount = DerivedKeypair
export type DerivedChangeAccount = DerivedKeypair

/**
 * Curve-level secp256k1 HD keyring holding a master HD node in memory
 * and deriving sub-accounts on demand from any specified BIP-44 path prefix.
 */
export class Secp256k1HdKeyring {
  readonly masterNode: HDNodeWallet
  readonly pathPrefix: string

  constructor(
    masterNode: HDNodeWallet,
    pathConfigOrPrefix: Bip44PathConfig | string = { coinType: 60, branch: 0 },
  ) {
    this.masterNode = masterNode
    this.pathPrefix = resolveBip44Path(pathConfigOrPrefix)
  }

  /** Builds keyring from a BIP-39 mnemonic phrase and path configuration. */
  static fromMnemonic(
    mnemonic: string,
    pathConfigOrPrefix: Bip44PathConfig | string = { coinType: 60, branch: 0 },
    passphrase = '',
  ): Secp256k1HdKeyring {
    if (!bip39.validateMnemonic(mnemonic)) {
      throw new Error('Invalid BIP-39 mnemonic')
    }
    const seed = Mnemonic.fromPhrase(mnemonic, passphrase).computeSeed()
    const masterNode = HDNodeWallet.fromSeed(seed)
    return new Secp256k1HdKeyring(masterNode, pathConfigOrPrefix)
  }

  /** Builds keyring from a raw binary seed and path configuration. */
  static fromSeed(
    seed: Uint8Array,
    pathConfigOrPrefix: Bip44PathConfig | string = { coinType: 60, branch: 0 },
  ): Secp256k1HdKeyring {
    const masterNode = HDNodeWallet.fromSeed(seed)
    return new Secp256k1HdKeyring(masterNode, pathConfigOrPrefix)
  }

  /** Builds keyring from an EVM wallet-domain root. */
  static fromDomainRoot(
    domainRoot: Bip32DomainRoot<'evm-wallet'>,
    pathConfigOrPrefix: Bip44PathConfig | string = { coinType: 60, branch: 0 },
  ): Secp256k1HdKeyring {
    return new Secp256k1HdKeyring(
      bip32MasterFromDomainRoot(domainRoot, 'evm-wallet'),
      pathConfigOrPrefix,
    )
  }

  /** Generates a fresh random mnemonic and derived keyring. */
  static generate(
    pathConfigOrPrefix: Bip44PathConfig | string = { coinType: 60, branch: 0 },
  ): { keyring: Secp256k1HdKeyring; mnemonic: string } {
    const mnemonic = bip39.generateMnemonic()
    return {
      keyring: Secp256k1HdKeyring.fromMnemonic(mnemonic, pathConfigOrPrefix),
      mnemonic,
    }
  }

  /** Builds the full derivation path for child `index`. */
  subAccountPath(index: number): string {
    return subAccountPathFor(this.pathPrefix, index)
  }

  /** Deterministically derives child keypair at `${this.pathPrefix}/${index}`. */
  deriveSubAccount(index: number): DerivedKeypair {
    const node = this.masterNode.derivePath(this.subAccountPath(index))
    return {
      index,
      address: node.address,
      privateKey: node.privateKey,
      publicKey: node.publicKey,
    }
  }

  /** Alias for deriveSubAccount for change-keyring consumers. */
  deriveChangeAccount(index: number): DerivedKeypair {
    return this.deriveSubAccount(index)
  }

  /** Public-only copy of the branch descriptor without signing authority. */
  publicBranchDescriptor(): {
    path: string
    publicKey: Uint8Array
    chainCode: Uint8Array
  } {
    const branch = this.masterNode.derivePath(this.pathPrefix).neuter()
    return {
      path: this.pathPrefix,
      publicKey: getBytes(branch.publicKey),
      chainCode: getBytes(branch.chainCode),
    }
  }
}

/**
 * Standard EVM HD Spend Keyring: BIP-44 path m/44'/60'/0'/0/*
 * Powers Monad, Ethereum, Sepolia, Holesky, Base, Hyperliquid, Tempo spend accounts.
 */
export class EvmHdKeyring extends Secp256k1HdKeyring {
  constructor(masterNode: HDNodeWallet) {
    super(masterNode, { coinType: 60, branch: 0 })
  }

  static override fromMnemonic(
    mnemonic: string,
    passphrase = '',
  ): EvmHdKeyring {
    const base = Secp256k1HdKeyring.fromMnemonic(
      mnemonic,
      { coinType: 60, branch: 0 },
      passphrase,
    )
    return new EvmHdKeyring(base.masterNode)
  }

  static override fromDomainRoot(
    domainRoot: Bip32DomainRoot<'evm-wallet'>,
  ): EvmHdKeyring {
    return new EvmHdKeyring(bip32MasterFromDomainRoot(domainRoot, 'evm-wallet'))
  }

  static override generate(): { keyring: EvmHdKeyring; mnemonic: string } {
    const { keyring, mnemonic } = Secp256k1HdKeyring.generate({
      coinType: 60,
      branch: 0,
    })
    return { keyring: new EvmHdKeyring(keyring.masterNode), mnemonic }
  }
}

/**
 * Standard EVM HD Change Keyring: BIP-44 path m/44'/60'/0'/1/*
 * Powers unhardened change addresses across all EVM chains.
 */
export class EvmChangeKeyring extends Secp256k1HdKeyring {
  constructor(masterNode: HDNodeWallet) {
    super(masterNode, { coinType: 60, branch: 1 })
  }

  static override fromMnemonic(
    mnemonic: string,
    passphrase = '',
  ): EvmChangeKeyring {
    const base = Secp256k1HdKeyring.fromMnemonic(
      mnemonic,
      { coinType: 60, branch: 1 },
      passphrase,
    )
    return new EvmChangeKeyring(base.masterNode)
  }

  static override fromDomainRoot(
    domainRoot: Bip32DomainRoot<'evm-wallet'>,
  ): EvmChangeKeyring {
    return new EvmChangeKeyring(
      bip32MasterFromDomainRoot(domainRoot, 'evm-wallet'),
    )
  }

  static override generate(): { keyring: EvmChangeKeyring; mnemonic: string } {
    const { keyring, mnemonic } = Secp256k1HdKeyring.generate({
      coinType: 60,
      branch: 1,
    })
    return { keyring: new EvmChangeKeyring(keyring.masterNode), mnemonic }
  }
}

/**
 * Parameterized UTXO HD Keyring for eCash (coin 1899), Bitcoin Cash (coin 145), or Bitcoin (coin 0).
 */
export class UtxoHdKeyring extends Secp256k1HdKeyring {
  constructor(
    masterNode: HDNodeWallet,
    pathConfigOrPrefix: Bip44PathConfig | string = {
      coinType: 1899,
      branch: 0,
    },
  ) {
    super(masterNode, pathConfigOrPrefix)
  }

  static override fromMnemonic(
    mnemonic: string,
    pathConfigOrPrefix: Bip44PathConfig | string = {
      coinType: 1899,
      branch: 0,
    },
    passphrase = '',
  ): UtxoHdKeyring {
    const base = Secp256k1HdKeyring.fromMnemonic(
      mnemonic,
      pathConfigOrPrefix,
      passphrase,
    )
    return new UtxoHdKeyring(base.masterNode, pathConfigOrPrefix)
  }

  /** Convenience factory for standard UTXO coin types (e.g. 1899 eCash, 145 BCH, 0 BTC). */
  static fromCoin(
    mnemonic: string,
    coinType = 1899,
    branch: 0 | 1 = 0,
    passphrase = '',
  ): UtxoHdKeyring {
    return UtxoHdKeyring.fromMnemonic(
      mnemonic,
      { coinType, branch },
      passphrase,
    )
  }
}
