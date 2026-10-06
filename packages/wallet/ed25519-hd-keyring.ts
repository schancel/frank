/**
 * SLIP-0010 Hierarchical Deterministic Key Derivation on Curve Ed25519 (Ticket #954).
 *
 * Implements deterministic master key and hardened child key derivation for Ed25519
 * per the SLIP-0010 specification:
 * https://github.com/satoshilabs/slips/blob/master/slip-0010.md
 *
 * Specializes for Solana (BIP-44 coin type 501):
 * - Spend branch:  m/44'/501'/0'/0'/i'
 * - Change branch: m/44'/501'/0'/1'/i'
 *
 * All Ed25519 derivations under SLIP-0010 are hardened.
 */

import { Keypair, PublicKey } from '@solana/web3.js'
import { ed25519 } from '@noble/curves/ed25519'
import { hmac } from '@noble/hashes/hmac'
import { sha512 } from '@noble/hashes/sha512'
import * as bip39 from 'bip39'

const ED25519_CURVE_KEY = new TextEncoder().encode('ed25519 seed')
const HARDENED_BIT = 0x80000000

export interface Ed25519Bip44Config {
  /** Coin type (BIP-44). Solana is 501. Defaults to 501. */
  coinType?: number
  /** Account index. Defaults to 0. */
  account?: number
  /** Branch index: 0 = external/spend, 1 = internal/change. Defaults to 0. */
  branch?: 0 | 1
}

export interface Ed25519Node {
  readonly key: Uint8Array
  readonly chainCode: Uint8Array
}

export interface Ed25519DerivedAccount {
  readonly index: number
  readonly path: string
  readonly address: string
  readonly publicKey: PublicKey
  readonly keypair: Keypair
  readonly privateKeyBytes: Uint8Array
}

export interface Ed25519PublicBranchDescriptor {
  readonly path: string
  readonly publicKey: Uint8Array
  readonly chainCode: Uint8Array
}

/**
 * Resolves an Ed25519 BIP-44 path configuration to a canonical prefix string.
 * All segments on Ed25519 must be hardened.
 */
export function resolveEd25519Bip44Path(
  configOrPrefix: Ed25519Bip44Config | string = {},
): string {
  if (typeof configOrPrefix === 'string') {
    const trimmed = configOrPrefix.trim().replace(/\/+$/, '')
    if (!trimmed.startsWith('m')) {
      throw new Error(
        `Ed25519 derivation path must start with 'm', got ${trimmed}`,
      )
    }
    return trimmed
  }

  const coinType = configOrPrefix.coinType ?? 501
  const account = configOrPrefix.account ?? 0
  const branch = configOrPrefix.branch ?? 0

  if (!Number.isInteger(coinType) || coinType < 0) {
    throw new RangeError(
      `BIP-44 coinType must be a non-negative integer, got ${coinType}`,
    )
  }
  if (!Number.isInteger(account) || account < 0) {
    throw new RangeError(
      `BIP-44 account must be a non-negative integer, got ${account}`,
    )
  }
  if (branch !== 0 && branch !== 1) {
    throw new RangeError(
      `BIP-44 branch must be 0 (spend) or 1 (change), got ${branch}`,
    )
  }

  return `m/44'/${coinType}'/${account}'/${branch}'`
}

/**
 * Computes the full derivation path for a sub-account index on an Ed25519 branch.
 */
export function ed25519SubAccountPathFor(
  prefix: string,
  index: number,
): string {
  if (!Number.isInteger(index) || index < 0) {
    throw new RangeError(
      `Ed25519 sub-account index must be a non-negative integer, got ${index}`,
    )
  }
  return `${prefix.replace(/\/+$/, '')}/${index}'`
}

/**
 * Parses a derivation path string into an array of hardened segment indices.
 * Rejects unhardened segments since Ed25519 SLIP-0010 does not support unhardened derivation.
 */
export function parseEd25519Path(path: string): number[] {
  const parts = path.trim().replace(/\/+$/, '').split('/')
  if (parts.length === 0 || (parts[0] !== 'm' && parts[0] !== 'M')) {
    throw new Error(`Derivation path must start with 'm', got: ${path}`)
  }

  const indices: number[] = []
  for (let i = 1; i < parts.length; i++) {
    const part = parts[i]
    const isHardened =
      part.endsWith("'") || part.endsWith('h') || part.endsWith('H')
    if (!isHardened) {
      throw new Error(
        `SLIP-0010 Ed25519 derivation only supports hardened path segments (got unhardened segment: ${part} in path ${path})`,
      )
    }
    const rawNum = parseInt(part.slice(0, -1), 10)
    if (isNaN(rawNum) || rawNum < 0) {
      throw new Error(`Invalid path segment: ${part} in path ${path}`)
    }
    indices.push((rawNum + HARDENED_BIT) >>> 0)
  }
  return indices
}

/**
 * SLIP-0010 master key generation for Curve Ed25519:
 * I = HMAC-SHA512(Key = "ed25519 seed", Data = Seed)
 * masterKey = I[0..32], masterChainCode = I[32..64]
 */
export function deriveEd25519MasterNode(seed: Uint8Array): Ed25519Node {
  if (seed.length < 16 || seed.length > 64) {
    throw new RangeError(
      `SLIP-0010 seed length must be between 16 and 64 bytes, got ${seed.length}`,
    )
  }
  const I = hmac(sha512, ED25519_CURVE_KEY, seed)
  return {
    key: I.slice(0, 32),
    chainCode: I.slice(32, 64),
  }
}

/**
 * SLIP-0010 hardened child key derivation for Curve Ed25519:
 * I = HMAC-SHA512(Key = c_par, Data = 0x00 || k_par || ser32(i))
 * k_i = I[0..32], c_i = I[32..64]
 */
export function deriveEd25519ChildNode(
  parent: Ed25519Node,
  hardenedIndex: number,
): Ed25519Node {
  const data = new Uint8Array(1 + 32 + 4)
  data[0] = 0x00
  data.set(parent.key, 1)
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength)
  view.setUint32(33, hardenedIndex, false)

  const I = hmac(sha512, parent.chainCode, data)
  return {
    key: I.slice(0, 32),
    chainCode: I.slice(32, 64),
  }
}

/**
 * Traverses a parsed list of hardened segment indices from the master node.
 */
export function deriveEd25519PathNode(
  master: Ed25519Node,
  path: string,
): { node: Ed25519Node; path: string } {
  const segmentIndices = parseEd25519Path(path)
  let current = master
  for (const index of segmentIndices) {
    current = deriveEd25519ChildNode(current, index)
  }
  return { node: current, path }
}

/**
 * Base Ed25519 HD Keyring using SLIP-0010.
 * Supports arbitrary BIP-44 path configurations (coinType, account, branch) or custom path prefixes.
 */
export class Ed25519HdKeyring {
  readonly masterNode: Ed25519Node
  readonly pathPrefix: string

  constructor(
    masterNode: Ed25519Node,
    pathConfigOrPrefix: Ed25519Bip44Config | string = {
      coinType: 501,
      branch: 0,
    },
  ) {
    this.masterNode = masterNode
    this.pathPrefix = resolveEd25519Bip44Path(pathConfigOrPrefix)
  }

  /**
   * Initializes keyring from a raw binary master seed (16-64 bytes).
   */
  static fromSeed(
    seed: Uint8Array,
    pathConfigOrPrefix: Ed25519Bip44Config | string = {
      coinType: 501,
      branch: 0,
    },
  ): Ed25519HdKeyring {
    const master = deriveEd25519MasterNode(seed)
    return new Ed25519HdKeyring(master, pathConfigOrPrefix)
  }

  /**
   * Initializes keyring from a BIP-39 mnemonic phrase.
   */
  static async fromMnemonic(
    mnemonic: string,
    pathConfigOrPrefix: Ed25519Bip44Config | string = {
      coinType: 501,
      branch: 0,
    },
    passphrase = '',
  ): Promise<Ed25519HdKeyring> {
    if (!bip39.validateMnemonic(mnemonic)) {
      throw new Error('Invalid BIP-39 mnemonic')
    }
    const seed = await bip39.mnemonicToSeed(mnemonic, passphrase)
    return Ed25519HdKeyring.fromSeed(new Uint8Array(seed), pathConfigOrPrefix)
  }

  /**
   * Generates a fresh random mnemonic and corresponding Ed25519HdKeyring.
   */
  static async generate(
    pathConfigOrPrefix: Ed25519Bip44Config | string = {
      coinType: 501,
      branch: 0,
    },
  ): Promise<{ keyring: Ed25519HdKeyring; mnemonic: string }> {
    const mnemonic = bip39.generateMnemonic()
    const keyring = await Ed25519HdKeyring.fromMnemonic(
      mnemonic,
      pathConfigOrPrefix,
    )
    return { keyring, mnemonic }
  }

  /**
   * Computes the full derivation path for a sub-account under this keyring's branch prefix.
   */
  subAccountPath(index: number): string {
    return ed25519SubAccountPathFor(this.pathPrefix, index)
  }

  /**
   * Synchronously derives the raw node and public key for a path.
   */
  deriveNode(path: string): {
    node: Ed25519Node
    publicKeyBytes: Uint8Array
    base58Address: string
  } {
    const { node } = deriveEd25519PathNode(this.masterNode, path)
    const publicKeyBytes = ed25519.getPublicKey(node.key)
    const base58Address = new PublicKey(publicKeyBytes).toBase58()
    return { node, publicKeyBytes, base58Address }
  }

  /**
   * Deterministically derives a sub-account at `${this.pathPrefix}/${index}'`.
   */
  async deriveSubAccount(index: number): Promise<Ed25519DerivedAccount> {
    const fullPath = this.subAccountPath(index)
    return this.derivePath(fullPath, index)
  }

  /**
   * Alias to deriveSubAccount for interface compatibility with change keyrings.
   */
  async deriveChangeAccount(index: number): Promise<Ed25519DerivedAccount> {
    return this.deriveSubAccount(index)
  }

  /**
   * Deterministically derives an account for any explicit SLIP-0010 hardened path.
   */
  async derivePath(path: string, index = 0): Promise<Ed25519DerivedAccount> {
    const { node, publicKeyBytes, base58Address } = this.deriveNode(path)
    const publicKey = new PublicKey(publicKeyBytes)
    const keypair = await Keypair.fromSeed(node.key)
    return {
      index,
      path,
      address: base58Address,
      publicKey,
      keypair,
      privateKeyBytes: node.key,
    }
  }

  /**
   * Returns a neutered descriptor of this branch's public key and chain code
   * without exposing any private keys.
   */
  publicBranchDescriptor(): Ed25519PublicBranchDescriptor {
    const { node, publicKeyBytes } = this.deriveNode(this.pathPrefix)
    return {
      path: this.pathPrefix,
      publicKey: publicKeyBytes,
      chainCode: node.chainCode,
    }
  }
}

/**
 * Standard Solana HD Spend Keyring: SLIP-0010 path m/44'/501'/0'/0'/i'
 */
export class SolanaHdKeyring extends Ed25519HdKeyring {
  constructor(masterNode: Ed25519Node) {
    super(masterNode, { coinType: 501, branch: 0 })
  }

  static override fromSeed(seed: Uint8Array): SolanaHdKeyring {
    const master = deriveEd25519MasterNode(seed)
    return new SolanaHdKeyring(master)
  }

  static override async fromMnemonic(
    mnemonic: string,
    passphrase = '',
  ): Promise<SolanaHdKeyring> {
    const base = await Ed25519HdKeyring.fromMnemonic(
      mnemonic,
      { coinType: 501, branch: 0 },
      passphrase,
    )
    return new SolanaHdKeyring(base.masterNode)
  }

  static override async generate(): Promise<{
    keyring: SolanaHdKeyring
    mnemonic: string
  }> {
    const { keyring, mnemonic } = await Ed25519HdKeyring.generate({
      coinType: 501,
      branch: 0,
    })
    return { keyring: new SolanaHdKeyring(keyring.masterNode), mnemonic }
  }
}

/**
 * Standard Solana HD Change Keyring: SLIP-0010 path m/44'/501'/0'/1'/i'
 */
export class SolanaChangeKeyring extends Ed25519HdKeyring {
  constructor(masterNode: Ed25519Node) {
    super(masterNode, { coinType: 501, branch: 1 })
  }

  static override fromSeed(seed: Uint8Array): SolanaChangeKeyring {
    const master = deriveEd25519MasterNode(seed)
    return new SolanaChangeKeyring(master)
  }

  static override async fromMnemonic(
    mnemonic: string,
    passphrase = '',
  ): Promise<SolanaChangeKeyring> {
    const base = await Ed25519HdKeyring.fromMnemonic(
      mnemonic,
      { coinType: 501, branch: 1 },
      passphrase,
    )
    return new SolanaChangeKeyring(base.masterNode)
  }

  static override async generate(): Promise<{
    keyring: SolanaChangeKeyring
    mnemonic: string
  }> {
    const { keyring, mnemonic } = await Ed25519HdKeyring.generate({
      coinType: 501,
      branch: 1,
    })
    return { keyring: new SolanaChangeKeyring(keyring.masterNode), mnemonic }
  }
}
