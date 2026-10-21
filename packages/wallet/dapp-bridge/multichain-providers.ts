import { ed25519 } from '@noble/curves/ed25519'
import { schnorr, secp256k1 } from '@noble/curves/secp256k1'
import { sha256 } from '@noble/hashes/sha256'
import { bytesToHex, hexToBytes, randomBytes, utf8ToBytes } from '@noble/hashes/utils'
import {
  BCH_MAINNET,
  BCH_TESTNET,
  BTC_MAINNET,
  BTC_TESTNET,
  DOGE_MAINNET,
  DOGE_TESTNET,
  LTC_MAINNET,
  LTC_TESTNET,
  XEC_MAINNET,
  XEC_TESTNET,
  type ChainDescriptor,
  cryptoBackend,
  deriveHdPath,
  encodeAddress,
  encodeBase58,
  hdPrivateFromSeed,
  privateKeyFromBytes,
  publicFromPrivate,
  pubkeyHashFromBytes,
  signMessage as signNakamotoMessage,
  tweakAddPrivateKey,
  tweakAddPublicKey,
  xOnlyPublicKeyFromBytes,
} from '@frank/nakamoto'
import { HDNodeWallet, Mnemonic, getAddress } from 'ethers'
import { DAPP_PERSONA_SHARED_BRANCH, deriveDappPersona } from './persona-keys'
import {
  deriveEd25519MasterNode,
  deriveEd25519PathNode,
} from '../ed25519-hd-keyring'
import {
  EIP1193_ERROR_CODES,
  Eip1193ProviderRpcError,
  normalizeDappOrigin,
} from './index'

export type DappChainFamily =
  | 'evm'
  | 'solana'
  | 'btc'
  | 'bch'
  | 'xec'
  | 'doge'
  | 'ltc'

export const ALL_DAPP_CHAIN_FAMILIES: readonly DappChainFamily[] = Object.freeze([
  'evm',
  'solana',
  'btc',
  'bch',
  'xec',
  'doge',
  'ltc',
])

export type DappNetworkMode = 'mainnet' | 'testnet'

export type DappPersonaIsolationMode = 'per-origin-burner' | 'shared-primary'

export type DappAnnounceMode = 'always' | 'connected-only' | 'stealth'

export type DappProtocol =
  | 'eip1193'
  | 'solana-wallet-standard'
  | 'btc-wbip004'
  | 'btc-unisat'
  | 'xec-cashtab'
  | 'bch-cashconnect'
  | 'utxo-wallet-standard'

export type DappAction =
  | 'get_accounts'
  | 'connect'
  | 'disconnect'
  | 'sign_message'
  | 'sign_transaction'
  | 'sign_and_send_transaction'
  | 'sign_psbt'
  | 'switch_network'

/**
 * Isolated BIP-44 / BIP-84 / BIP-86 `account = 1'` derivation path prefixes for dApp Personas.
 *
 * Every chain family uses `account = 1'` so dApp Personas stay 100% cryptographically
 * disjoint from the user's primary messaging identity and `account = 0'` wallet/stamp pools.
 */
export const MULTICHAIN_DAPP_PERSONA_PATH_PREFIXES = Object.freeze({
  /** EVM personas use the hardened `m/1785'/60'/0'/<k>'` branch of `./persona-keys`. */
  evm: DAPP_PERSONA_SHARED_BRANCH,
  solana: "m/44'/501'/1'",
  btcPayment: "m/84'/0'/1'/0",
  btcOrdinals: "m/86'/0'/1'/0",
  bch: "m/44'/145'/1'/0",
  xec: "m/44'/899'/1'/0",
  doge: "m/44'/3'/1'/0",
  ltc: "m/84'/2'/1'/0",
} as const)

/**
 * Primary `account = 0'` wallet/stamp pool derivation path prefixes, used to verify
 * and enforce runtime cryptographic disjointness against all dApp Personas.
 */
export const MULTICHAIN_PRIMARY_POOL_PATH_PREFIXES = Object.freeze({
  evm: "m/44'/60'/0'/0",
  solana: "m/44'/501'/0'/0'",
  btcPayment: "m/84'/0'/0'/0",
  btcOrdinals: "m/86'/0'/0'/0",
  bch: "m/44'/145'/0'/0",
  xec: "m/44'/899'/0'/0",
  doge: "m/44'/3'/0'/0",
  ltc: "m/84'/2'/0'/0",
} as const)

export interface MultiChainDappPersonaRecord {
  readonly chainFamily: DappChainFamily
  readonly network: DappNetworkMode
  readonly index: number
  readonly mode: DappPersonaIsolationMode
  readonly derivationPath: string
  readonly address: string
  readonly publicKeyHex: string
  /** Present on Solana (`solana`) personas (32-byte Ed25519 public key). */
  readonly publicKeyBytes?: Uint8Array
  /** Present on Bitcoin (`btc`) personas: Native SegWit P2WPKH (`bc1q...` / `tb1q...`). */
  readonly paymentAddress?: string
  readonly paymentPublicKeyHex?: string
  readonly paymentDerivationPath?: string
  /** Present on Bitcoin (`btc`) personas: Taproot P2TR Ordinals (`bc1p...` / `tb1p...`). */
  readonly ordinalsAddress?: string
  readonly ordinalsPublicKeyHex?: string
  readonly ordinalsXOnlyPublicKeyHex?: string
  readonly ordinalsDerivationPath?: string
  readonly label: string
  readonly boundOrigin?: string
  readonly createdAtMs: number
  readonly retired: boolean
}

interface InternalPersonaSecretMaterial {
  readonly record: MultiChainDappPersonaRecord
  readonly primaryPrivateKeyBytes: Uint8Array
  readonly ordinalsPrivateKeyBytes?: Uint8Array
  readonly ordinalsTweakedPrivateKeyBytes?: Uint8Array
}

function resolveSeedBytes(masterSeedOrMnemonic: Uint8Array | string): Uint8Array {
  if (masterSeedOrMnemonic instanceof Uint8Array) {
    if (masterSeedOrMnemonic.length < 16 || masterSeedOrMnemonic.length > 64) {
      throw new Error(
        `Invalid master seed byte length (${masterSeedOrMnemonic.length}): expected 16..64 bytes`,
      )
    }
    return new Uint8Array(masterSeedOrMnemonic)
  }

  if (typeof masterSeedOrMnemonic !== 'string') {
    throw new Error('Invalid masterSeedOrMnemonic: expected Uint8Array or string')
  }

  const trimmed = masterSeedOrMnemonic.trim()
  if (!trimmed) {
    throw new Error('Invalid masterSeedOrMnemonic: cannot be empty')
  }

  const normalizedHex = trimmed.startsWith('0x') ? trimmed.slice(2) : trimmed
  if (/^[0-9a-fA-F]{32,128}$/.test(normalizedHex) && normalizedHex.length % 2 === 0) {
    return hexToBytes(normalizedHex)
  }

  const mnemonic = Mnemonic.fromPhrase(trimmed)
  return hexToBytes(mnemonic.computeSeed().slice(2))
}

function mustNakamoto<T>(
  result: { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: unknown },
  context: string,
): T {
  if (!result.ok) {
    const code = (result.error as { code?: string } | undefined)?.code
    throw new Error(`${context}${code ? `: ${code}` : ''}`)
  }
  return result.value
}

function deriveBip341TaprootOutputKey(
  internalCompressedPubKey: Uint8Array,
  internalPrivKeyBytes?: Uint8Array,
): {
  internalXOnlyBytes: Uint8Array
  outputXOnlyBytes: Uint8Array
  tweakBytes: Uint8Array
  tweakedPrivKeyBytes?: Uint8Array
} {
  const internalXOnlyBytes = internalCompressedPubKey.slice(1, 33)
  const tweakBytes = schnorr.utils.taggedHash('TapTweak', internalXOnlyBytes)
  const liftedCompressed = new Uint8Array(33)
  liftedCompressed[0] = 0x02
  liftedCompressed.set(internalXOnlyBytes, 1)

  const tweakedPub = mustNakamoto(
    tweakAddPublicKey(liftedCompressed, tweakBytes),
    'Failed to compute BIP-341 Taproot tweaked output key',
  )
  const outputXOnlyBytes = tweakedPub.slice(1, 33)

  let tweakedPrivKeyBytes: Uint8Array | undefined
  if (internalPrivKeyBytes) {
    let secretBytes = new Uint8Array(internalPrivKeyBytes)
    // BIP-340 / BIP-341: if the internal public key has an odd Y coordinate (prefix 0x03), negate d mod n before adding tweak
    if (internalCompressedPubKey[0] === 0x03) {
      const n = secp256k1.CURVE.n
      let d = 0n
      for (const b of secretBytes) d = (d << 8n) | BigInt(b)
      const negD = (n - (d % n)) % n
      const negHex = negD.toString(16).padStart(64, '0')
      secretBytes = new Uint8Array(hexToBytes(negHex))
    }
    const brandedPriv = mustNakamoto(
      privateKeyFromBytes(secretBytes, true),
      'Invalid Taproot internal private key',
    )
    const tweakedPriv = mustNakamoto(
      tweakAddPrivateKey(brandedPriv, tweakBytes),
      'Failed to tweak Taproot private key',
    )
    tweakedPrivKeyBytes = new Uint8Array(tweakedPriv.bytes)
  }

  return {
    internalXOnlyBytes,
    outputXOnlyBytes,
    tweakBytes,
    tweakedPrivKeyBytes,
  }
}

function resolveUtxoChainDescriptor(
  chainFamily: 'btc' | 'bch' | 'xec' | 'doge' | 'ltc',
  network: DappNetworkMode,
): ChainDescriptor {
  switch (chainFamily) {
    case 'btc':
      return network === 'mainnet' ? BTC_MAINNET : BTC_TESTNET
    case 'bch':
      return network === 'mainnet' ? BCH_MAINNET : BCH_TESTNET
    case 'xec':
      return network === 'mainnet' ? XEC_MAINNET : XEC_TESTNET
    case 'doge':
      return network === 'mainnet' ? DOGE_MAINNET : DOGE_TESTNET
    case 'ltc':
      return network === 'mainnet' ? LTC_MAINNET : LTC_TESTNET
  }
}

/**
 * Derives a multi-chain dApp Persona on `account = 1'` for any supported `DappChainFamily`.
 */
export function deriveMultiChainDappPersona(
  masterSeedOrMnemonic: Uint8Array | string,
  chainFamily: DappChainFamily,
  index: number,
  options?: {
    network?: DappNetworkMode
    mode?: DappPersonaIsolationMode
    label?: string
    boundOrigin?: string
    nowMs?: number
  },
): InternalPersonaSecretMaterial {
  if (!Number.isSafeInteger(index) || index < 0) {
    throw new Error(`Invalid multi-chain dApp persona index: ${String(index)}`)
  }
  const seedBytes = resolveSeedBytes(masterSeedOrMnemonic)
  const network: DappNetworkMode = options?.network ?? 'mainnet'
  const mode: DappPersonaIsolationMode =
    options?.mode ?? (index === 0 ? 'shared-primary' : 'per-origin-burner')
  const createdAtMs = options?.nowMs ?? Date.now()
  const defaultLabel =
    options?.label ??
    (index === 0
      ? `Primary ${chainFamily.toUpperCase()} dApp Persona`
      : `${chainFamily.toUpperCase()} Burner Persona #${index}`)

  if (chainFamily === 'evm') {
    const derived = deriveDappPersona(HDNodeWallet.fromSeed(seedBytes), {
      kind: 'shared',
      slot: index,
    })
    const derivationPath = derived.path
    const hdNode = derived.node
    const privBytes = hexToBytes(hdNode.privateKey.slice(2))
    return {
      record: {
        chainFamily: 'evm',
        network,
        index,
        mode,
        derivationPath,
        address: getAddress(hdNode.address),
        publicKeyHex: hdNode.publicKey.slice(2).toLowerCase(),
        label: defaultLabel,
        ...(options?.boundOrigin ? { boundOrigin: options.boundOrigin } : {}),
        createdAtMs,
        retired: false,
      },
      primaryPrivateKeyBytes: privBytes,
    }
  }

  if (chainFamily === 'solana') {
    const derivationPath = `${MULTICHAIN_DAPP_PERSONA_PATH_PREFIXES.solana}/${index}'`
    const master = deriveEd25519MasterNode(seedBytes)
    const { node } = deriveEd25519PathNode(master, derivationPath)
    const publicKeyBytes = new Uint8Array(ed25519.getPublicKey(node.key))
    const address = encodeBase58(publicKeyBytes)
    return {
      record: {
        chainFamily: 'solana',
        network,
        index,
        mode,
        derivationPath,
        address,
        publicKeyHex: bytesToHex(publicKeyBytes).toLowerCase(),
        publicKeyBytes,
        label: defaultLabel,
        ...(options?.boundOrigin ? { boundOrigin: options.boundOrigin } : {}),
        createdAtMs,
        retired: false,
      },
      primaryPrivateKeyBytes: new Uint8Array(node.key),
    }
  }

  const root = mustNakamoto(hdPrivateFromSeed(seedBytes), 'Invalid master seed for BIP32')

  if (chainFamily === 'btc') {
    const descriptor = resolveUtxoChainDescriptor('btc', network)
    const paymentDerivationPath = `${MULTICHAIN_DAPP_PERSONA_PATH_PREFIXES.btcPayment}/${index}`
    const ordinalsDerivationPath = `${MULTICHAIN_DAPP_PERSONA_PATH_PREFIXES.btcOrdinals}/${index}`

    const paymentNode = mustNakamoto(
      deriveHdPath(root, paymentDerivationPath),
      `Failed to derive BTC payment path ${paymentDerivationPath}`,
    )
    const paymentPub = mustNakamoto(
      publicFromPrivate(paymentNode.privateKey),
      'Failed to derive BTC payment public key',
    )
    const paymentPkh = mustNakamoto(
      pubkeyHashFromBytes(new Uint8Array(cryptoBackend.hash160(paymentPub.compressed))),
      'Failed to hash BTC payment public key',
    )
    const paymentAddress = mustNakamoto(
      encodeAddress({ kind: 'p2wpkh', hash: paymentPkh }, descriptor, 'bech32'),
      'Failed to encode BTC P2WPKH address',
    )

    const ordinalsNode = mustNakamoto(
      deriveHdPath(root, ordinalsDerivationPath),
      `Failed to derive BTC Taproot path ${ordinalsDerivationPath}`,
    )
    const ordinalsPub = mustNakamoto(
      publicFromPrivate(ordinalsNode.privateKey),
      'Failed to derive BTC Taproot public key',
    )
    const taproot = deriveBip341TaprootOutputKey(
      ordinalsPub.compressed,
      ordinalsNode.privateKey.bytes,
    )
    const outputKeyBranded = mustNakamoto(
      xOnlyPublicKeyFromBytes(taproot.outputXOnlyBytes),
      'Invalid Taproot x-only output key',
    )
    const ordinalsAddress = mustNakamoto(
      encodeAddress(
        { kind: 'p2tr', outputKey: outputKeyBranded, tweak: taproot.tweakBytes },
        descriptor,
        'bech32m',
      ),
      'Failed to encode BTC Taproot P2TR address',
    )

    const paymentPubHex = bytesToHex(paymentPub.compressed).toLowerCase()
    const ordinalsPubHex = bytesToHex(ordinalsPub.compressed).toLowerCase()
    const ordinalsXOnlyHex = bytesToHex(taproot.internalXOnlyBytes).toLowerCase()

    return {
      record: {
        chainFamily: 'btc',
        network,
        index,
        mode,
        derivationPath: paymentDerivationPath,
        address: paymentAddress,
        publicKeyHex: paymentPubHex,
        paymentAddress,
        paymentPublicKeyHex: paymentPubHex,
        paymentDerivationPath,
        ordinalsAddress,
        ordinalsPublicKeyHex: ordinalsPubHex,
        ordinalsXOnlyPublicKeyHex: ordinalsXOnlyHex,
        ordinalsDerivationPath,
        label: defaultLabel,
        ...(options?.boundOrigin ? { boundOrigin: options.boundOrigin } : {}),
        createdAtMs,
        retired: false,
      },
      primaryPrivateKeyBytes: new Uint8Array(paymentNode.privateKey.bytes),
      ordinalsPrivateKeyBytes: new Uint8Array(ordinalsNode.privateKey.bytes),
      ordinalsTweakedPrivateKeyBytes: taproot.tweakedPrivKeyBytes,
    }
  }

  // BCH, XEC, DOGE, LTC
  const descriptor = resolveUtxoChainDescriptor(chainFamily, network)
  const prefix = MULTICHAIN_DAPP_PERSONA_PATH_PREFIXES[chainFamily]
  const derivationPath = `${prefix}/${index}`
  const childNode = mustNakamoto(
    deriveHdPath(root, derivationPath),
    `Failed to derive ${chainFamily} path ${derivationPath}`,
  )
  const pub = mustNakamoto(
    publicFromPrivate(childNode.privateKey),
    `Failed to derive ${chainFamily} public key`,
  )
  const pkh = mustNakamoto(
    pubkeyHashFromBytes(new Uint8Array(cryptoBackend.hash160(pub.compressed))),
    `Failed to hash ${chainFamily} public key`,
  )

  let address: string
  if (chainFamily === 'bch' || chainFamily === 'xec') {
    address = mustNakamoto(
      encodeAddress({ kind: 'p2pkh', hash: pkh }, descriptor, 'cashaddr'),
      `Failed to encode ${chainFamily} cashaddr`,
    )
  } else if (chainFamily === 'doge') {
    address = mustNakamoto(
      encodeAddress({ kind: 'p2pkh', hash: pkh }, descriptor, 'base58check'),
      'Failed to encode DOGE base58check address',
    )
  } else {
    address = mustNakamoto(
      encodeAddress({ kind: 'p2wpkh', hash: pkh }, descriptor, 'bech32'),
      'Failed to encode LTC bech32 address',
    )
  }

  return {
    record: {
      chainFamily,
      network,
      index,
      mode,
      derivationPath,
      address,
      publicKeyHex: bytesToHex(pub.compressed).toLowerCase(),
      label: defaultLabel,
      ...(options?.boundOrigin ? { boundOrigin: options.boundOrigin } : {}),
      createdAtMs,
      retired: false,
    },
    primaryPrivateKeyBytes: new Uint8Array(childNode.privateKey.bytes),
  }
}

/**
 * Derives the primary `account = 0'` wallet/stamp-pool address(es) for a chain family and index.
 * Used to verify that `account = 1'` dApp Personas are 100% disjoint from `account = 0'`.
 */
export function derivePrimaryAccountZeroAddresses(
  masterSeedOrMnemonic: Uint8Array | string,
  chainFamily: DappChainFamily,
  index: number,
  network: DappNetworkMode = 'mainnet',
): { derivationPath: string; addresses: string[] } {
  const seedBytes = resolveSeedBytes(masterSeedOrMnemonic)
  if (chainFamily === 'evm') {
    const derivationPath = `${MULTICHAIN_PRIMARY_POOL_PATH_PREFIXES.evm}/${index}`
    const hdNode = HDNodeWallet.fromSeed(seedBytes).derivePath(derivationPath)
    return { derivationPath, addresses: [getAddress(hdNode.address)] }
  }
  if (chainFamily === 'solana') {
    const derivationPath = `${MULTICHAIN_PRIMARY_POOL_PATH_PREFIXES.solana}/${index}'`
    const master = deriveEd25519MasterNode(seedBytes)
    const { node } = deriveEd25519PathNode(master, derivationPath)
    const publicKeyBytes = new Uint8Array(ed25519.getPublicKey(node.key))
    return { derivationPath, addresses: [encodeBase58(publicKeyBytes)] }
  }
  const root = mustNakamoto(hdPrivateFromSeed(seedBytes), 'Invalid master seed for BIP32')
  if (chainFamily === 'btc') {
    const descriptor = resolveUtxoChainDescriptor('btc', network)
    const payPath = `${MULTICHAIN_PRIMARY_POOL_PATH_PREFIXES.btcPayment}/${index}`
    const ordPath = `${MULTICHAIN_PRIMARY_POOL_PATH_PREFIXES.btcOrdinals}/${index}`
    const payNode = mustNakamoto(deriveHdPath(root, payPath), 'BTC account 0 pay path')
    const payPub = mustNakamoto(publicFromPrivate(payNode.privateKey), 'BTC account 0 pay pub')
    const payPkh = mustNakamoto(
      pubkeyHashFromBytes(new Uint8Array(cryptoBackend.hash160(payPub.compressed))),
      'BTC account 0 pay pkh',
    )
    const payAddr = mustNakamoto(
      encodeAddress({ kind: 'p2wpkh', hash: payPkh }, descriptor, 'bech32'),
      'BTC account 0 pay addr',
    )

    const ordNode = mustNakamoto(deriveHdPath(root, ordPath), 'BTC account 0 ord path')
    const ordPub = mustNakamoto(publicFromPrivate(ordNode.privateKey), 'BTC account 0 ord pub')
    const taproot = deriveBip341TaprootOutputKey(ordPub.compressed)
    const outKey = mustNakamoto(
      xOnlyPublicKeyFromBytes(taproot.outputXOnlyBytes),
      'BTC account 0 ord xonly',
    )
    const ordAddr = mustNakamoto(
      encodeAddress(
        { kind: 'p2tr', outputKey: outKey, tweak: taproot.tweakBytes },
        descriptor,
        'bech32m',
      ),
      'BTC account 0 ord addr',
    )
    return { derivationPath: payPath, addresses: [payAddr, ordAddr] }
  }

  const descriptor = resolveUtxoChainDescriptor(chainFamily, network)
  const derivationPath = `${MULTICHAIN_PRIMARY_POOL_PATH_PREFIXES[chainFamily]}/${index}`
  const node = mustNakamoto(deriveHdPath(root, derivationPath), 'UTXO account 0 path')
  const pub = mustNakamoto(publicFromPrivate(node.privateKey), 'UTXO account 0 pub')
  const pkh = mustNakamoto(
    pubkeyHashFromBytes(new Uint8Array(cryptoBackend.hash160(pub.compressed))),
    'UTXO account 0 pkh',
  )
  const encoding =
    chainFamily === 'bch' || chainFamily === 'xec'
      ? 'cashaddr'
      : chainFamily === 'doge'
        ? 'base58check'
        : 'bech32'
  const kind = chainFamily === 'ltc' ? 'p2wpkh' : 'p2pkh'
  const addr = mustNakamoto(
    encodeAddress({ kind, hash: pkh }, descriptor, encoding),
    'UTXO account 0 addr',
  )
  return { derivationPath, addresses: [addr] }
}

export interface MultiChainDappPersonaKeyringOptions {
  masterSeedOrMnemonic: Uint8Array | string
  defaultPersonaMode?: DappPersonaIsolationMode
  defaultNetwork?: DappNetworkMode
  forbiddenAddresses?: Iterable<string>
  accountZeroGuardCount?: number
  nowMs?: () => number
}

/**
 * Unified Multi-Chain dApp Persona Keyring (`MultiChainDappPersonaKeyring`).
 *
 * Enforces two strict privacy and security invariants across all 7 chain families
 * (`evm`, `solana`, `btc`, `bch`, `xec`, `doge`, `ltc`):
 * 1. **Cryptographic Disjointness (`account = 1'` vs `account = 0'`)**:
 *    Every dApp persona is derived under BIP-44/84/86 `account = 1'`, keeping the user's
 *    primary messaging identity and `account = 0'` wallet/stamp pools 100% unexposed.
 * 2. **Per-Origin Anti-Supercookie Burner Isolation**:
 *    Defaults to `'per-origin-burner'` mode so two origins (`https://jup.ag` vs `https://raydium.io`,
 *    `https://magiceden.io` vs `https://unisat.io`, `https://cashtab.com` vs `https://ecash.supply`)
 *    receive completely distinct cryptographic addresses and public keys.
 */
export class MultiChainDappPersonaKeyring {
  private readonly masterSeedBytes: Uint8Array
  private readonly defaultPersonaMode: DappPersonaIsolationMode
  private readonly defaultNetwork: DappNetworkMode
  private readonly forbiddenAddressSet = new Set<string>()
  private readonly nowMs: () => number
  private readonly personasByKey = new Map<string, InternalPersonaSecretMaterial>()
  private readonly originAssignments = new Map<string, string>()
  private readonly nextBurnerIndexByChain = new Map<string, number>()

  constructor(options: MultiChainDappPersonaKeyringOptions) {
    this.masterSeedBytes = resolveSeedBytes(options.masterSeedOrMnemonic)
    this.defaultPersonaMode = options.defaultPersonaMode ?? 'per-origin-burner'
    this.defaultNetwork = options.defaultNetwork ?? 'mainnet'
    this.nowMs = options.nowMs ?? (() => Date.now())

    if (options.forbiddenAddresses) {
      for (const addr of options.forbiddenAddresses) {
        if (addr && addr.trim()) {
          this.forbiddenAddressSet.add(addr.trim().toLowerCase())
        }
      }
    }

    const guardCount = options.accountZeroGuardCount ?? 8
    for (const family of ALL_DAPP_CHAIN_FAMILIES) {
      for (let i = 0; i < guardCount; i++) {
        const { addresses } = derivePrimaryAccountZeroAddresses(
          this.masterSeedBytes,
          family,
          i,
          this.defaultNetwork,
        )
        for (const addr of addresses) {
          this.forbiddenAddressSet.add(addr.toLowerCase())
        }
      }
    }
  }

  private makePersonaStorageKey(
    chainFamily: DappChainFamily,
    network: DappNetworkMode,
    index: number,
  ): string {
    return `${chainFamily}:${network}:${index}`
  }

  private makeOriginChainKey(
    normalizedOrigin: string,
    chainFamily: DappChainFamily,
    network: DappNetworkMode,
  ): string {
    return `${normalizedOrigin}|${chainFamily}|${network}`
  }

  assertNotForbiddenAddress(address: string): void {
    const normalized = address.trim().toLowerCase()
    if (this.forbiddenAddressSet.has(normalized)) {
      throw new Error(
        `Security invariant violation: address ${address} collides with a protected identity or account=0' pool address`,
      )
    }
  }

  private ensurePersonaMaterial(
    chainFamily: DappChainFamily,
    network: DappNetworkMode,
    index: number,
    meta?: {
      mode?: DappPersonaIsolationMode
      label?: string
      boundOrigin?: string
    },
  ): InternalPersonaSecretMaterial {
    const key = this.makePersonaStorageKey(chainFamily, network, index)
    const existing = this.personasByKey.get(key)
    if (existing) {
      return existing
    }

    const derived = deriveMultiChainDappPersona(this.masterSeedBytes, chainFamily, index, {
      network,
      mode: meta?.mode ?? (index === 0 ? 'shared-primary' : 'per-origin-burner'),
      label: meta?.label,
      boundOrigin: meta?.boundOrigin,
      nowMs: this.nowMs(),
    })

    this.assertNotForbiddenAddress(derived.record.address)
    if (derived.record.ordinalsAddress) {
      this.assertNotForbiddenAddress(derived.record.ordinalsAddress)
    }

    this.personasByKey.set(key, derived)
    return derived
  }

  /**
   * Returns or assigns the dApp Persona for `(origin, chainFamily)`.
   * Defaults to `mode: 'per-origin-burner'` so every website gets an isolated address.
   */
  getOrAssignOriginPersona(
    rawOrigin: string,
    chainFamily: DappChainFamily,
    options?: {
      mode?: DappPersonaIsolationMode
      network?: DappNetworkMode
      personaIndex?: number
      label?: string
    },
  ): MultiChainDappPersonaRecord {
    const origin = normalizeDappOrigin(rawOrigin)
    const network: DappNetworkMode = options?.network ?? this.defaultNetwork
    const mode: DappPersonaIsolationMode = options?.mode ?? this.defaultPersonaMode
    const originKey = this.makeOriginChainKey(origin, chainFamily, network)

    const existingStorageKey = this.originAssignments.get(originKey)
    if (existingStorageKey && options?.personaIndex === undefined) {
      const existing = this.personasByKey.get(existingStorageKey)
      if (existing && !existing.record.retired && existing.record.mode === mode) {
        return { ...existing.record }
      }
    }

    let targetIndex: number
    if (options?.personaIndex !== undefined) {
      if (!Number.isSafeInteger(options.personaIndex) || options.personaIndex < 0) {
        throw new Error(`Invalid personaIndex: ${String(options.personaIndex)}`)
      }
      targetIndex = options.personaIndex
    } else if (mode === 'shared-primary') {
      targetIndex = 0
    } else {
      // Find existing non-retired burner already bound to this origin, or allocate next index >= 1
      let boundIndex: number | undefined
      for (const item of this.personasByKey.values()) {
        if (
          item.record.chainFamily === chainFamily &&
          item.record.network === network &&
          item.record.index >= 1 &&
          item.record.boundOrigin === origin &&
          !item.record.retired
        ) {
          boundIndex = item.record.index
          break
        }
      }
      if (boundIndex !== undefined) {
        targetIndex = boundIndex
      } else {
        const counterKey = `${chainFamily}:${network}`
        const nextIdx = this.nextBurnerIndexByChain.get(counterKey) ?? 1
        targetIndex = nextIdx
        this.nextBurnerIndexByChain.set(counterKey, nextIdx + 1)
      }
    }

    const hostLabel = new URL(origin).hostname
    const material = this.ensurePersonaMaterial(chainFamily, network, targetIndex, {
      mode: targetIndex === 0 ? 'shared-primary' : 'per-origin-burner',
      label:
        options?.label ??
        (targetIndex === 0
          ? `Primary ${chainFamily.toUpperCase()} dApp Persona`
          : `${hostLabel} (${chainFamily.toUpperCase()}) Burner Persona`),
      boundOrigin: targetIndex > 0 ? origin : undefined,
    })

    const storageKey = this.makePersonaStorageKey(chainFamily, network, material.record.index)
    this.originAssignments.set(originKey, storageKey)
    return { ...material.record }
  }

  /**
   * Silent lookup: returns the connected Persona for `(origin, chainFamily)` if and only if
   * the origin has already been approved/connected. Never allocates or prompts.
   */
  getConnectedOriginPersona(
    rawOrigin: string,
    chainFamily: DappChainFamily,
    network: DappNetworkMode = this.defaultNetwork,
  ): MultiChainDappPersonaRecord | null {
    const origin = normalizeDappOrigin(rawOrigin)
    const originKey = this.makeOriginChainKey(origin, chainFamily, network)
    const storageKey = this.originAssignments.get(originKey)
    if (!storageKey) return null
    const material = this.personasByKey.get(storageKey)
    if (!material || material.record.retired) return null
    return { ...material.record }
  }

  isOriginConnected(
    rawOrigin: string,
    chainFamily?: DappChainFamily,
    network: DappNetworkMode = this.defaultNetwork,
  ): boolean {
    const origin = normalizeDappOrigin(rawOrigin)
    if (chainFamily) {
      return this.getConnectedOriginPersona(origin, chainFamily, network) !== null
    }
    for (const family of ALL_DAPP_CHAIN_FAMILIES) {
      if (this.getConnectedOriginPersona(origin, family, network) !== null) {
        return true
      }
    }
    return false
  }

  listConnectedOrigins(): Set<string> {
    const origins = new Set<string>()
    for (const key of this.originAssignments.keys()) {
      const [origin] = key.split('|')
      if (origin) origins.add(origin)
    }
    return origins
  }

  disconnectOrigin(
    rawOrigin: string,
    chainFamily?: DappChainFamily,
    network?: DappNetworkMode,
  ): boolean {
    const origin = normalizeDappOrigin(rawOrigin)
    let removed = false
    for (const key of Array.from(this.originAssignments.keys())) {
      const [keyOrigin, keyFamily, keyNet] = key.split('|')
      if (
        keyOrigin === origin &&
        (!chainFamily || keyFamily === chainFamily) &&
        (!network || keyNet === network)
      ) {
        this.originAssignments.delete(key)
        removed = true
      }
    }
    return removed
  }

  /**
   * Internal signing key accessor used by the unified multi-chain protocol bridges.
   */
  getSigningMaterialForOrigin(
    rawOrigin: string,
    chainFamily: DappChainFamily,
    network: DappNetworkMode = this.defaultNetwork,
  ): {
    persona: MultiChainDappPersonaRecord
    primaryPrivateKeyBytes: Uint8Array
    ordinalsPrivateKeyBytes?: Uint8Array
    ordinalsTweakedPrivateKeyBytes?: Uint8Array
  } {
    const origin = normalizeDappOrigin(rawOrigin)
    const originKey = this.makeOriginChainKey(origin, chainFamily, network)
    const storageKey = this.originAssignments.get(originKey)
    if (!storageKey) {
      throw new Eip1193ProviderRpcError(
        EIP1193_ERROR_CODES.UNAUTHORIZED,
        `Origin ${origin} is not connected to a ${chainFamily.toUpperCase()} dApp persona`,
      )
    }
    const material = this.personasByKey.get(storageKey)
    if (!material || material.record.retired) {
      throw new Eip1193ProviderRpcError(
        EIP1193_ERROR_CODES.UNAUTHORIZED,
        `Persona for ${origin} on ${chainFamily.toUpperCase()} is unavailable or retired`,
      )
    }
    this.assertNotForbiddenAddress(material.record.address)
    return {
      persona: { ...material.record },
      primaryPrivateKeyBytes: new Uint8Array(material.primaryPrivateKeyBytes),
      ordinalsPrivateKeyBytes: material.ordinalsPrivateKeyBytes
        ? new Uint8Array(material.ordinalsPrivateKeyBytes)
        : undefined,
      ordinalsTweakedPrivateKeyBytes: material.ordinalsTweakedPrivateKeyBytes
        ? new Uint8Array(material.ordinalsTweakedPrivateKeyBytes)
        : undefined,
    }
  }
}

export interface UtxoPersonaCandidateInput {
  readonly txid: string
  readonly vout: number
  readonly satoshis: bigint
  readonly address: string
  /** Optional origin tag if this UTXO is already held by a per-origin burner persona. */
  readonly originTag?: string
  /** True if this UTXO sits on the user's primary (`account = 0'`) receiving address. */
  readonly isMainReceiveAddress?: boolean
  readonly confirmed?: boolean
}

export interface UtxoPersonaJitSelectionParams {
  readonly origin: string
  readonly personaAddress: string
  readonly chainFamily: 'btc' | 'bch' | 'xec' | 'doge' | 'ltc'
  readonly availableUtxos: readonly UtxoPersonaCandidateInput[]
  readonly targetAmountSatoshis: bigint
  readonly feeRateSatPerVbyte?: bigint
}

export interface UtxoPersonaJitSelectionPlan {
  readonly selectedUtxos: readonly UtxoPersonaCandidateInput[]
  readonly totalInputSatoshis: bigint
  readonly targetAmountSatoshis: bigint
  readonly estimatedFeeSatoshis: bigint
  readonly changeSatoshis: bigint
  /**
   * True when no existing UTXO is already isolated to `personaAddress` / `origin`, meaning
   * Frank should pre-fund `personaAddress` with a single exact-sized UTXO (`targetAmountSatoshis + dappFee`)
   * rather than co-spending multiple `account = 0'` UTXOs directly inside an untrusted dApp PSBT.
   */
  readonly requiresJitFundingHop: boolean
  /**
   * Guaranteed `false` when using Frank's UTXO Persona JIT Input Selection: never co-spends
   * the user's main receiving address alongside unrelated wallet UTXOs in a dApp-visible transaction.
   */
  readonly exposesMainReceiveAddress: boolean
  readonly leaksMultiAddressCluster: boolean
}

/**
 * Plans anti-clustering UTXO selection for a dApp transaction (`btc`, `bch`, `xec`, `doge`, `ltc`).
 *
 * Why this matters on UTXO chains:
 * Standard Bitcoin/eCash/BCH browser wallets expose all wallet UTXOs or co-spend multiple
 * sub-addresses in PSBTs, allowing analytics firms (Chainalysis, Mempool clusters) and dApp backends
 * to link the user's entire UTXO set via the Common-Input-Ownership Heuristic (CIOH).
 *
 * Strategy:
 * 1. First attempts to satisfy the payment exclusively from UTXOs already sitting on `personaAddress`
 *    (or tagged with `originTag === normalizedOrigin`).
 * 2. If the persona does not yet hold sufficient funds, selects a single discrete non-main-receive UTXO
 *    (if one covers `requiredSatoshis`) or minimal isolated UTXOs for a 1-hop JIT funding transfer to
 *    `personaAddress` for the exact `targetAmountSatoshis + dAppTxFee`, ensuring the dApp PSBT only ever
 *    spends a single clean input owned by `personaAddress`.
 */
export function planUtxoPersonaJitInputSelection(
  params: UtxoPersonaJitSelectionParams,
): UtxoPersonaJitSelectionPlan {
  if (params.targetAmountSatoshis <= 0n) {
    throw new Error('targetAmountSatoshis must be positive')
  }
  const normalizedOrigin = normalizeDappOrigin(params.origin)
  const feeRate = params.feeRateSatPerVbyte ?? (params.chainFamily === 'doge' ? 1000n : 2n)
  const inputVbytes =
    params.chainFamily === 'btc' || params.chainFamily === 'ltc' ? 68n : 149n
  const baseOverheadVbytes = 11n + 2n * 34n // overhead + 2 outputs (recipient + change)

  const estimateFee = (inputCount: number): bigint => {
    const vbytes = baseOverheadVbytes + BigInt(Math.max(1, inputCount)) * inputVbytes
    return vbytes * feeRate
  }

  // Tier 1: UTXOs already owned by this origin's persona
  const personaUtxos = params.availableUtxos
    .filter(
      (u) =>
        u.satoshis > 0n &&
        (u.address.toLowerCase() === params.personaAddress.toLowerCase() ||
          (u.originTag && u.originTag.toLowerCase() === normalizedOrigin)),
    )
    .sort((a, b) => (b.satoshis > a.satoshis ? 1 : b.satoshis < a.satoshis ? -1 : 0))

  const selectedPersona: UtxoPersonaCandidateInput[] = []
  let sumPersona = 0n
  for (const utxo of personaUtxos) {
    selectedPersona.push(utxo)
    sumPersona += utxo.satoshis
    const fee = estimateFee(selectedPersona.length)
    if (sumPersona >= params.targetAmountSatoshis + fee) {
      return {
        selectedUtxos: selectedPersona,
        totalInputSatoshis: sumPersona,
        targetAmountSatoshis: params.targetAmountSatoshis,
        estimatedFeeSatoshis: fee,
        changeSatoshis: sumPersona - params.targetAmountSatoshis - fee,
        requiresJitFundingHop: false,
        exposesMainReceiveAddress: false,
        leaksMultiAddressCluster: false,
      }
    }
  }

  // Tier 2: Non-main-receive change/pool UTXOs (preferring a single UTXO that covers the target + fee)
  const nonMainPoolUtxos = params.availableUtxos
    .filter((u) => u.satoshis > 0n && !u.isMainReceiveAddress)
    .sort((a, b) => (a.satoshis > b.satoshis ? 1 : a.satoshis < b.satoshis ? -1 : 0))

  const singleInputFee = estimateFee(1)
  const singleMatch = nonMainPoolUtxos.find(
    (u) => u.satoshis >= params.targetAmountSatoshis + singleInputFee,
  )
  if (singleMatch) {
    return {
      selectedUtxos: [singleMatch],
      totalInputSatoshis: singleMatch.satoshis,
      targetAmountSatoshis: params.targetAmountSatoshis,
      estimatedFeeSatoshis: singleInputFee,
      changeSatoshis: singleMatch.satoshis - params.targetAmountSatoshis - singleInputFee,
      requiresJitFundingHop: true,
      exposesMainReceiveAddress: false,
      leaksMultiAddressCluster: false,
    }
  }

  // Tier 3: Accumulate largest-first from non-main-receive UTXOs, falling back to remaining UTXOs only if required
  const fallbackPool = [
    ...nonMainPoolUtxos.slice().reverse(),
    ...params.availableUtxos
      .filter((u) => u.satoshis > 0n && u.isMainReceiveAddress)
      .sort((a, b) => (b.satoshis > a.satoshis ? 1 : b.satoshis < a.satoshis ? -1 : 0)),
  ]

  const accumulated: UtxoPersonaCandidateInput[] = []
  let accumulatedSum = 0n
  for (const utxo of fallbackPool) {
    accumulated.push(utxo)
    accumulatedSum += utxo.satoshis
    const fee = estimateFee(accumulated.length)
    if (accumulatedSum >= params.targetAmountSatoshis + fee) {
      return {
        selectedUtxos: accumulated,
        totalInputSatoshis: accumulatedSum,
        targetAmountSatoshis: params.targetAmountSatoshis,
        estimatedFeeSatoshis: fee,
        changeSatoshis: accumulatedSum - params.targetAmountSatoshis - fee,
        requiresJitFundingHop: true,
        // Even if internal funding uses multiple pool UTXOs, the dApp only sees the single JIT-funded persona UTXO!
        exposesMainReceiveAddress: false,
        leaksMultiAddressCluster: false,
      }
    }
  }

  throw new Error(
    `Insufficient UTXO balance for ${params.chainFamily.toUpperCase()} dApp request: needed ${params.targetAmountSatoshis.toString()} satoshis + fee, available ${accumulatedSum.toString()} satoshis`,
  )
}

export interface DappTrackabilityPolicyOptions {
  announceMode?: DappAnnounceMode
  defaultPersonaMode?: DappPersonaIsolationMode
  maxPendingPerOrigin?: number
  rejectionCooldownMs?: number
  nowMs?: () => number
}

/**
 * Central Security & Anti-Supercookie Trackability Policy Engine (`DappTrackabilityPolicy`).
 *
 * Controls:
 * 1. Provider discovery visibility (`announceMode: 'always' | 'connected-only' | 'stealth'`)
 * 2. Default Persona isolation (`defaultPersonaMode: 'per-origin-burner' | 'shared-primary'`)
 * 3. Anti-popup-spam rate limiting (`maxPendingPerOrigin = 1` and `rejectionCooldownMs` after `4001`).
 */
export class DappTrackabilityPolicy {
  announceMode: DappAnnounceMode
  defaultPersonaMode: DappPersonaIsolationMode
  readonly maxPendingPerOrigin: number
  readonly rejectionCooldownMs: number
  private readonly nowMs: () => number
  private readonly rejectionTimestampsByOrigin = new Map<string, number>()

  constructor(options?: DappTrackabilityPolicyOptions) {
    this.announceMode = options?.announceMode ?? 'always'
    this.defaultPersonaMode = options?.defaultPersonaMode ?? 'per-origin-burner'
    this.maxPendingPerOrigin = options?.maxPendingPerOrigin ?? 1
    this.rejectionCooldownMs = options?.rejectionCooldownMs ?? 5_000
    this.nowMs = options?.nowMs ?? (() => Date.now())
  }

  shouldAnnounceProviderToOrigin(
    rawOrigin: string,
    connectedOrigins: ReadonlySet<string>,
    announceModeOverride?: DappAnnounceMode,
  ): boolean {
    let normalizedOrigin: string
    try {
      normalizedOrigin = normalizeDappOrigin(rawOrigin)
    } catch {
      return false
    }
    const mode = announceModeOverride ?? this.announceMode
    if (mode === 'stealth') {
      return false
    }
    if (mode === 'connected-only') {
      return connectedOrigins.has(normalizedOrigin)
    }
    return true
  }

  recordUserRejection(rawOrigin: string): void {
    const normalizedOrigin = normalizeDappOrigin(rawOrigin)
    this.rejectionTimestampsByOrigin.set(normalizedOrigin, this.nowMs())
  }

  clearOriginCooldown(rawOrigin: string): void {
    const normalizedOrigin = normalizeDappOrigin(rawOrigin)
    this.rejectionTimestampsByOrigin.delete(normalizedOrigin)
  }

  assertCanEnqueueInteractiveRequest(
    rawOrigin: string,
    activePendingCountForOrigin: number,
  ): void {
    const normalizedOrigin = normalizeDappOrigin(rawOrigin)
    if (activePendingCountForOrigin >= this.maxPendingPerOrigin) {
      throw new Eip1193ProviderRpcError(
        EIP1193_ERROR_CODES.USER_REJECTED_REQUEST,
        `Origin ${normalizedOrigin} already has a pending approval request (maxPendingPerOrigin = ${this.maxPendingPerOrigin})`,
      )
    }

    const lastRejectedAt = this.rejectionTimestampsByOrigin.get(normalizedOrigin)
    if (lastRejectedAt !== undefined) {
      const elapsed = this.nowMs() - lastRejectedAt
      if (elapsed < this.rejectionCooldownMs) {
        const remainingMs = this.rejectionCooldownMs - elapsed
        throw new Eip1193ProviderRpcError(
          EIP1193_ERROR_CODES.USER_REJECTED_REQUEST,
          `Connect/signing request rate-limited after recent user rejection for ${normalizedOrigin} (${remainingMs}ms cooldown remaining)`,
        )
      }
    }
  }
}

export interface UnifiedDappRequest {
  readonly id: string
  readonly origin: string
  readonly chainFamily: DappChainFamily
  readonly protocol: DappProtocol
  readonly action: DappAction
  /**
   * When `true` (e.g. `eth_accounts`, `solana:connect({ silent: true })`, `unisat.getAccounts()`),
   * NEVER prompts UI and ALWAYS returns `[]` if `origin` is not approved.
   */
  readonly silent?: boolean
  readonly payload?: unknown
}

export interface PendingMultiChainDappApproval {
  readonly id: string
  readonly request: UnifiedDappRequest
  readonly createdAtMs: number
  readonly previewAddress?: string
}

interface InternalMultiChainApproval {
  readonly record: PendingMultiChainDappApproval
  readonly onApprove: (options?: {
    mode?: DappPersonaIsolationMode
    personaIndex?: number
  }) => Promise<unknown>
  readonly onReject: (error: Eip1193ProviderRpcError) => void
}

export interface UnifiedMultiChainDappRouterOptions {
  keyring: MultiChainDappPersonaKeyring
  policy?: DappTrackabilityPolicy
  nowMs?: () => number
  onBroadcastTransaction?: (params: {
    origin: string
    chainFamily: DappChainFamily
    protocol: DappProtocol
    signedPayloadHex: string
    persona: MultiChainDappPersonaRecord
  }) => Promise<string>
}

/**
 * Unified Multi-Chain dApp Request Router & Approval Engine.
 *
 * All protocol bridges (`SolanaWalletStandardBridge`, `BitcoinDappBridge`,
 * `EcashCashtabBridge`, `BchUtxoBridge`) translate their wire messages into
 * `UnifiedDappRequest` objects and dispatch through this single permission,
 * persona-isolation, and anti-spam engine.
 */
export class UnifiedMultiChainDappRouter {
  readonly keyring: MultiChainDappPersonaKeyring
  readonly policy: DappTrackabilityPolicy
  private readonly nowMs: () => number
  private readonly onBroadcastTransaction?: UnifiedMultiChainDappRouterOptions['onBroadcastTransaction']
  private readonly pendingApprovals = new Map<string, InternalMultiChainApproval>()
  private readonly networkByOriginAndFamily = new Map<string, DappNetworkMode>()
  private approvalSeq = 0

  constructor(options: UnifiedMultiChainDappRouterOptions) {
    this.keyring = options.keyring
    this.policy = options.policy ?? new DappTrackabilityPolicy({ nowMs: options.nowMs })
    this.nowMs = options.nowMs ?? (() => Date.now())
    this.onBroadcastTransaction = options.onBroadcastTransaction
  }

  getNetworkForOrigin(rawOrigin: string, chainFamily: DappChainFamily): DappNetworkMode {
    const origin = normalizeDappOrigin(rawOrigin)
    return this.networkByOriginAndFamily.get(`${origin}|${chainFamily}`) ?? 'mainnet'
  }

  setNetworkForOrigin(
    rawOrigin: string,
    chainFamily: DappChainFamily,
    network: DappNetworkMode,
  ): void {
    const origin = normalizeDappOrigin(rawOrigin)
    this.networkByOriginAndFamily.set(`${origin}|${chainFamily}`, network)
  }

  listPendingApprovals(): PendingMultiChainDappApproval[] {
    return Array.from(this.pendingApprovals.values()).map((item) => ({
      ...item.record,
    }))
  }

  private countPendingForOrigin(normalizedOrigin: string): number {
    let count = 0
    for (const entry of this.pendingApprovals.values()) {
      if (entry.record.request.origin === normalizedOrigin) {
        count += 1
      }
    }
    return count
  }

  async approveRequest(
    approvalId: string,
    options?: { mode?: DappPersonaIsolationMode; personaIndex?: number },
  ): Promise<unknown> {
    const entry = this.pendingApprovals.get(approvalId)
    if (!entry) {
      throw new Error(`Unknown or already resolved multi-chain approval ID: ${approvalId}`)
    }
    this.pendingApprovals.delete(approvalId)
    this.policy.clearOriginCooldown(entry.record.request.origin)
    return await entry.onApprove(options)
  }

  rejectRequest(approvalId: string, message = 'User Rejected Request'): void {
    const entry = this.pendingApprovals.get(approvalId)
    if (!entry) {
      throw new Error(`Unknown or already resolved multi-chain approval ID: ${approvalId}`)
    }
    this.pendingApprovals.delete(approvalId)
    this.policy.recordUserRejection(entry.record.request.origin)
    entry.onReject(
      new Eip1193ProviderRpcError(EIP1193_ERROR_CODES.USER_REJECTED_REQUEST, message),
    )
  }

  enqueueApproval<T>(
    request: UnifiedDappRequest,
    handler: (options?: {
      mode?: DappPersonaIsolationMode
      personaIndex?: number
    }) => Promise<T>,
  ): Promise<T> {
    const normalizedOrigin = normalizeDappOrigin(request.origin)
    this.policy.assertCanEnqueueInteractiveRequest(
      normalizedOrigin,
      this.countPendingForOrigin(normalizedOrigin),
    )

    this.approvalSeq += 1
    const id =
      request.id ||
      `mc-approval-${this.approvalSeq}-${bytesToHex(randomBytes(4))}`
    const existingPersona = this.keyring.getConnectedOriginPersona(
      normalizedOrigin,
      request.chainFamily,
      this.getNetworkForOrigin(normalizedOrigin, request.chainFamily),
    )

    const record: PendingMultiChainDappApproval = {
      id,
      request: {
        ...request,
        id,
        origin: normalizedOrigin,
      },
      createdAtMs: this.nowMs(),
      ...(existingPersona ? { previewAddress: existingPersona.address } : {}),
    }

    return new Promise<T>((resolve, reject) => {
      this.pendingApprovals.set(id, {
        record,
        onApprove: async (options) => {
          try {
            const res = await handler(options)
            resolve(res)
            return res
          } catch (err) {
            reject(err)
            throw err
          }
        },
        onReject: (err) => {
          reject(err)
        },
      })
    })
  }

  async dispatch<T = unknown>(
    request: UnifiedDappRequest,
    interactiveExecutor?: (
      persona: MultiChainDappPersonaRecord,
      options?: { mode?: DappPersonaIsolationMode; personaIndex?: number },
    ) => Promise<T>,
  ): Promise<T> {
    const normalizedOrigin = normalizeDappOrigin(request.origin)
    const network = this.getNetworkForOrigin(normalizedOrigin, request.chainFamily)

    if (request.action === 'disconnect') {
      this.keyring.disconnectOrigin(normalizedOrigin, request.chainFamily)
      return undefined as unknown as T
    }

    if (request.silent || request.action === 'get_accounts') {
      const connected = this.keyring.getConnectedOriginPersona(
        normalizedOrigin,
        request.chainFamily,
        network,
      )
      if (!connected) {
        return [] as unknown as T
      }
      if (interactiveExecutor) {
        return await interactiveExecutor(connected)
      }
      return [connected.address] as unknown as T
    }

    if (request.action === 'connect') {
      const existing = this.keyring.getConnectedOriginPersona(
        normalizedOrigin,
        request.chainFamily,
        network,
      )
      if (existing) {
        if (interactiveExecutor) {
          return await interactiveExecutor(existing)
        }
        return [existing.address] as unknown as T
      }

      return await this.enqueueApproval<T>(
        { ...request, origin: normalizedOrigin },
        async (approveOpts) => {
          const persona = this.keyring.getOrAssignOriginPersona(
            normalizedOrigin,
            request.chainFamily,
            {
              mode: approveOpts?.mode ?? this.policy.defaultPersonaMode,
              personaIndex: approveOpts?.personaIndex,
              network,
            },
          )
          if (interactiveExecutor) {
            return await interactiveExecutor(persona, approveOpts)
          }
          return [persona.address] as unknown as T
        },
      )
    }

    // All signing / transaction / network-switch actions require an active connection (or auto-assign on Cashtab send)
    const connected = this.keyring.getConnectedOriginPersona(
      normalizedOrigin,
      request.chainFamily,
      network,
    )
    if (!connected && request.protocol !== 'xec-cashtab') {
      throw new Eip1193ProviderRpcError(
        EIP1193_ERROR_CODES.UNAUTHORIZED,
        `Origin ${normalizedOrigin} is not connected to a ${request.chainFamily.toUpperCase()} dApp persona`,
      )
    }

    return await this.enqueueApproval<T>(
      { ...request, origin: normalizedOrigin },
      async (approveOpts) => {
        const activePersona =
          connected ??
          this.keyring.getOrAssignOriginPersona(normalizedOrigin, request.chainFamily, {
            mode: approveOpts?.mode ?? this.policy.defaultPersonaMode,
            personaIndex: approveOpts?.personaIndex,
            network,
          })
        if (!interactiveExecutor) {
          throw new Error(`No executor provided for action ${request.action}`)
        }
        return await interactiveExecutor(activePersona, approveOpts)
      },
    )
  }

  async broadcastSignedPayload(params: {
    origin: string
    chainFamily: DappChainFamily
    protocol: DappProtocol
    signedPayloadHex: string
    persona: MultiChainDappPersonaRecord
  }): Promise<string> {
    if (this.onBroadcastTransaction) {
      return await this.onBroadcastTransaction(params)
    }
    const digest = sha256(
      utf8ToBytes(
        `frank-txid:${params.chainFamily}:${params.persona.address}:${params.signedPayloadHex}`,
      ),
    )
    return params.chainFamily === 'solana'
      ? encodeBase58( new Uint8Array([...digest, ...digest]) )
      : bytesToHex(digest)
  }
}

// ============================================================================
// 1. Solana Wallet Standard Bridge (`solana:*`)
// ============================================================================

export interface SolanaWalletStandardAccount {
  readonly address: string
  readonly publicKey: Uint8Array
  readonly chains: readonly string[]
  readonly features: readonly string[]
}

export interface SolanaSignInInput {
  readonly domain?: string
  readonly address?: string
  readonly statement?: string
  readonly uri?: string
  readonly version?: string
  readonly chainId?: string
  readonly nonce?: string
  readonly issuedAt?: string
  readonly expirationTime?: string
  readonly notBefore?: string
  readonly requestId?: string
  readonly resources?: readonly string[]
}

export interface SolanaSignInOutput {
  readonly account: SolanaWalletStandardAccount
  readonly signedMessage: Uint8Array
  readonly signature: Uint8Array
  readonly signatureBase58: string
}

function toMessageBytes(input: Uint8Array | string | number[]): Uint8Array {
  if (input instanceof Uint8Array) return new Uint8Array(input)
  if (Array.isArray(input)) return Uint8Array.from(input)
  if (typeof input === 'string') {
    if (/^0x[0-9a-fA-F]*$/.test(input) && input.length % 2 === 0) {
      return hexToBytes(input.slice(2))
    }
    return utf8ToBytes(input)
  }
  throw new Error('Invalid message payload: expected Uint8Array, number[], or string')
}

/**
 * Formats a canonical Sign-In-With-Solana (SIWS) challenge message from `SolanaSignInInput`
 * and binds it to the verified origin and Solana Persona address.
 */
export function formatSolanaSignInMessage(
  origin: string,
  address: string,
  input: SolanaSignInInput = {},
): string {
  const domain = input.domain?.trim() || new URL(normalizeDappOrigin(origin)).host
  const lines: string[] = [
    `${domain} wants you to sign in with your Solana account:`,
    address,
  ]
  if (input.statement) {
    lines.push('', input.statement)
  }
  const fields: string[] = []
  if (input.uri) fields.push(`URI: ${input.uri}`)
  if (input.version) fields.push(`Version: ${input.version}`)
  if (input.chainId) fields.push(`Chain ID: ${input.chainId}`)
  if (input.nonce) fields.push(`Nonce: ${input.nonce}`)
  if (input.issuedAt) fields.push(`Issued At: ${input.issuedAt}`)
  if (input.expirationTime) fields.push(`Expiration Time: ${input.expirationTime}`)
  if (input.notBefore) fields.push(`Not Before: ${input.notBefore}`)
  if (input.requestId) fields.push(`Request ID: ${input.requestId}`)
  if (input.resources && input.resources.length > 0) {
    fields.push('Resources:')
    for (const res of input.resources) {
      fields.push(`- ${res}`)
    }
  }
  if (fields.length > 0) {
    lines.push('', ...fields)
  }
  return lines.join('\n')
}

export class SolanaWalletStandardBridge {
  constructor(private readonly router: UnifiedMultiChainDappRouter) {}

  private toWalletStandardAccount(
    persona: MultiChainDappPersonaRecord,
  ): SolanaWalletStandardAccount {
    return {
      address: persona.address,
      publicKey: new Uint8Array(persona.publicKeyBytes ?? hexToBytes(persona.publicKeyHex)),
      chains:
        persona.network === 'mainnet'
          ? ['solana:mainnet', 'solana:devnet']
          : ['solana:testnet', 'solana:devnet'],
      features: [
        'standard:connect',
        'standard:disconnect',
        'standard:events',
        'solana:signMessage',
        'solana:signTransaction',
        'solana:signAndSendTransaction',
        'solana:signIn',
      ],
    }
  }

  async handleRequest(
    rawOrigin: string,
    request: {
      id?: string
      method:
        | 'solana_connect'
        | 'solana_disconnect'
        | 'solana_getAccounts'
        | 'solana_signMessage'
        | 'solana_signTransaction'
        | 'solana_signAllTransactions'
        | 'solana_signAndSendTransaction'
        | 'solana_signIn'
      params?: Record<string, unknown>
    },
  ): Promise<unknown> {
    const origin = normalizeDappOrigin(rawOrigin)
    const reqId = request.id ?? `sol-${bytesToHex(randomBytes(4))}`
    const params = request.params ?? {}

    switch (request.method) {
      case 'solana_getAccounts': {
        const accounts = await this.router.dispatch<SolanaWalletStandardAccount[]>(
          {
            id: reqId,
            origin,
            chainFamily: 'solana',
            protocol: 'solana-wallet-standard',
            action: 'get_accounts',
            silent: true,
          },
          async (persona) => [this.toWalletStandardAccount(persona)],
        )
        return { accounts }
      }

      case 'solana_connect': {
        const silent = Boolean(params.silent ?? params.onlyIfTrusted ?? false)
        const accounts = await this.router.dispatch<SolanaWalletStandardAccount[]>(
          {
            id: reqId,
            origin,
            chainFamily: 'solana',
            protocol: 'solana-wallet-standard',
            action: silent ? 'get_accounts' : 'connect',
            silent,
            payload: params,
          },
          async (persona) => [this.toWalletStandardAccount(persona)],
        )
        return {
          publicKey: accounts[0]?.address ?? null,
          accounts,
        }
      }

      case 'solana_disconnect': {
        await this.router.dispatch({
          id: reqId,
          origin,
          chainFamily: 'solana',
          protocol: 'solana-wallet-standard',
          action: 'disconnect',
        })
        return { disconnected: true }
      }

      case 'solana_signMessage': {
        const messageBytes = toMessageBytes(
          (params.message as Uint8Array | string | number[]) ?? '',
        )
        return await this.router.dispatch(
          {
            id: reqId,
            origin,
            chainFamily: 'solana',
            protocol: 'solana-wallet-standard',
            action: 'sign_message',
            payload: { messageHex: bytesToHex(messageBytes) },
          },
          async (persona) => {
            const { primaryPrivateKeyBytes } = this.router.keyring.getSigningMaterialForOrigin(
              origin,
              'solana',
              persona.network,
            )
            const signature = new Uint8Array(
              ed25519.sign(messageBytes, primaryPrivateKeyBytes),
            )
            return {
              signature,
              signatureBase58: encodeBase58(signature),
              signedMessage: messageBytes,
              publicKey: persona.address,
            }
          },
        )
      }

      case 'solana_signIn': {
        const signInInput = (params.input ?? params) as SolanaSignInInput
        return await this.router.dispatch<SolanaSignInOutput>(
          {
            id: reqId,
            origin,
            chainFamily: 'solana',
            protocol: 'solana-wallet-standard',
            action: 'connect',
            payload: signInInput,
          },
          async (persona) => {
            const { primaryPrivateKeyBytes } = this.router.keyring.getSigningMaterialForOrigin(
              origin,
              'solana',
              persona.network,
            )
            const messageText = formatSolanaSignInMessage(
              origin,
              persona.address,
              signInInput,
            )
            const signedMessage = utf8ToBytes(messageText)
            const signature = new Uint8Array(
              ed25519.sign(signedMessage, primaryPrivateKeyBytes),
            )
            return {
              account: this.toWalletStandardAccount(persona),
              signedMessage,
              signature,
              signatureBase58: encodeBase58(signature),
            }
          },
        )
      }

      case 'solana_signTransaction': {
        const txBytes = toMessageBytes(
          (params.transaction as Uint8Array | string | number[]) ?? '',
        )
        return await this.router.dispatch(
          {
            id: reqId,
            origin,
            chainFamily: 'solana',
            protocol: 'solana-wallet-standard',
            action: 'sign_transaction',
            payload: { transactionHex: bytesToHex(txBytes) },
          },
          async (persona) => {
            const { primaryPrivateKeyBytes } = this.router.keyring.getSigningMaterialForOrigin(
              origin,
              'solana',
              persona.network,
            )
            const signature = new Uint8Array(ed25519.sign(txBytes, primaryPrivateKeyBytes))
            const signedTransaction = new Uint8Array(signature.length + txBytes.length)
            signedTransaction.set(signature, 0)
            signedTransaction.set(txBytes, signature.length)
            return {
              signature: encodeBase58(signature),
              signedTransaction,
              signedTransactionHex: bytesToHex(signedTransaction),
            }
          },
        )
      }

      case 'solana_signAllTransactions': {
        const rawTxs = Array.isArray(params.transactions) ? params.transactions : []
        const txByteList = rawTxs.map((t) =>
          toMessageBytes(t as Uint8Array | string | number[]),
        )
        return await this.router.dispatch(
          {
            id: reqId,
            origin,
            chainFamily: 'solana',
            protocol: 'solana-wallet-standard',
            action: 'sign_transaction',
            payload: { count: txByteList.length },
          },
          async (persona) => {
            const { primaryPrivateKeyBytes } = this.router.keyring.getSigningMaterialForOrigin(
              origin,
              'solana',
              persona.network,
            )
            const signedTransactions = txByteList.map((txBytes) => {
              const sig = new Uint8Array(ed25519.sign(txBytes, primaryPrivateKeyBytes))
              const out = new Uint8Array(sig.length + txBytes.length)
              out.set(sig, 0)
              out.set(txBytes, sig.length)
              return out
            })
            return { signedTransactions }
          },
        )
      }

      case 'solana_signAndSendTransaction': {
        const txBytes = toMessageBytes(
          (params.transaction as Uint8Array | string | number[]) ?? '',
        )
        return await this.router.dispatch(
          {
            id: reqId,
            origin,
            chainFamily: 'solana',
            protocol: 'solana-wallet-standard',
            action: 'sign_and_send_transaction',
            payload: { transactionHex: bytesToHex(txBytes) },
          },
          async (persona) => {
            const { primaryPrivateKeyBytes } = this.router.keyring.getSigningMaterialForOrigin(
              origin,
              'solana',
              persona.network,
            )
            const signatureBytes = new Uint8Array(
              ed25519.sign(txBytes, primaryPrivateKeyBytes),
            )
            const signedTx = new Uint8Array(signatureBytes.length + txBytes.length)
            signedTx.set(signatureBytes, 0)
            signedTx.set(txBytes, signatureBytes.length)
            const signature = await this.router.broadcastSignedPayload({
              origin,
              chainFamily: 'solana',
              protocol: 'solana-wallet-standard',
              signedPayloadHex: bytesToHex(signedTx),
              persona,
            })
            return { signature }
          },
        )
      }
    }
  }
}

// ============================================================================
// 2. Bitcoin Fragmentation Unifier (`BitcoinDappBridge`: UniSat + WBIP004 / sats-connect)
// ============================================================================

export type Wbip004AddressPurpose = 'payment' | 'ordinals'

export interface Wbip004AccountDescriptor {
  readonly address: string
  readonly publicKey: string
  readonly purpose: Wbip004AddressPurpose
  readonly addressType: 'p2wpkh' | 'p2tr'
}

function bytesToBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64')
}

export class BitcoinDappBridge {
  constructor(private readonly router: UnifiedMultiChainDappRouter) {}

  private buildWbip004Accounts(
    persona: MultiChainDappPersonaRecord,
    purposes?: readonly Wbip004AddressPurpose[],
  ): Wbip004AccountDescriptor[] {
    const requested =
      purposes && purposes.length > 0
        ? new Set(purposes)
        : new Set<Wbip004AddressPurpose>(['payment', 'ordinals'])
    const accounts: Wbip004AccountDescriptor[] = []
    if (requested.has('payment')) {
      accounts.push({
        address: persona.paymentAddress ?? persona.address,
        publicKey: persona.paymentPublicKeyHex ?? persona.publicKeyHex,
        purpose: 'payment',
        addressType: 'p2wpkh',
      })
    }
    if (requested.has('ordinals')) {
      accounts.push({
        address: persona.ordinalsAddress ?? persona.address,
        publicKey: persona.ordinalsPublicKeyHex ?? persona.publicKeyHex,
        purpose: 'ordinals',
        addressType: 'p2tr',
      })
    }
    return accounts
  }

  /**
   * Handles UniSat API requests (`window.unisat.*`).
   */
  async handleUnisatRequest(
    rawOrigin: string,
    request: {
      id?: string
      method:
        | 'unisat_requestAccounts'
        | 'unisat_getAccounts'
        | 'unisat_getPublicKey'
        | 'unisat_getNetwork'
        | 'unisat_switchNetwork'
        | 'unisat_signMessage'
        | 'unisat_signPsbt'
        | 'unisat_signPsbts'
      params?: Record<string, unknown>
    },
  ): Promise<unknown> {
    const origin = normalizeDappOrigin(rawOrigin)
    const reqId = request.id ?? `unisat-${bytesToHex(randomBytes(4))}`
    const params = request.params ?? {}

    switch (request.method) {
      case 'unisat_getAccounts': {
        return await this.router.dispatch<string[]>(
          {
            id: reqId,
            origin,
            chainFamily: 'btc',
            protocol: 'btc-unisat',
            action: 'get_accounts',
            silent: true,
          },
          async (persona) => [persona.paymentAddress ?? persona.address],
        )
      }

      case 'unisat_requestAccounts': {
        return await this.router.dispatch<string[]>(
          {
            id: reqId,
            origin,
            chainFamily: 'btc',
            protocol: 'btc-unisat',
            action: 'connect',
            silent: false,
          },
          async (persona) => [persona.paymentAddress ?? persona.address],
        )
      }

      case 'unisat_getPublicKey': {
        const network = this.router.getNetworkForOrigin(origin, 'btc')
        const connected = this.router.keyring.getConnectedOriginPersona(
          origin,
          'btc',
          network,
        )
        return connected ? (connected.paymentPublicKeyHex ?? connected.publicKeyHex) : ''
      }

      case 'unisat_getNetwork': {
        const net = this.router.getNetworkForOrigin(origin, 'btc')
        return net === 'mainnet' ? 'livenet' : 'testnet'
      }

      case 'unisat_switchNetwork': {
        const targetRaw = String(params.network ?? 'livenet').toLowerCase()
        if (targetRaw !== 'livenet' && targetRaw !== 'mainnet' && targetRaw !== 'testnet') {
          throw new Eip1193ProviderRpcError(
            EIP1193_ERROR_CODES.INVALID_PARAMS,
            `Unsupported UniSat network: ${targetRaw}`,
          )
        }
        const targetMode: DappNetworkMode =
          targetRaw === 'testnet' ? 'testnet' : 'mainnet'
        return await this.router.dispatch<string>(
          {
            id: reqId,
            origin,
            chainFamily: 'btc',
            protocol: 'btc-unisat',
            action: 'switch_network',
            payload: { network: targetMode },
          },
          async () => {
            this.router.setNetworkForOrigin(origin, 'btc', targetMode)
            return targetMode === 'mainnet' ? 'livenet' : 'testnet'
          },
        )
      }

      case 'unisat_signMessage': {
        const messageText = String(params.message ?? '')
        const sigType = String(params.type ?? 'ecdsa').toLowerCase()
        return await this.router.dispatch<string>(
          {
            id: reqId,
            origin,
            chainFamily: 'btc',
            protocol: 'btc-unisat',
            action: 'sign_message',
            payload: { message: messageText, type: sigType },
          },
          async (persona) => {
            const material = this.router.keyring.getSigningMaterialForOrigin(
              origin,
              'btc',
              persona.network,
            )
            const descriptor =
              persona.network === 'mainnet' ? BTC_MAINNET : BTC_TESTNET
            const msgBytes = utf8ToBytes(messageText)

            if (sigType === 'bip322-simple') {
              const digest = sha256(
                utf8ToBytes(`BIP0322-simple:${persona.ordinalsAddress}:${messageText}`),
              )
              const schnorrPriv =
                material.ordinalsTweakedPrivateKeyBytes ??
                material.ordinalsPrivateKeyBytes ??
                material.primaryPrivateKeyBytes
              const sigBytes = schnorr.sign(digest, schnorrPriv)
              return bytesToBase64(sigBytes)
            }

            const privKey = mustNakamoto(
              privateKeyFromBytes(material.primaryPrivateKeyBytes, true),
              'Invalid BTC persona private key',
            )
            const compactSig = mustNakamoto(
              signNakamotoMessage(descriptor, privKey, msgBytes),
              'Failed to sign Bitcoin message',
            )
            return bytesToBase64(compactSig)
          },
        )
      }

      case 'unisat_signPsbt': {
        const psbtHex = String(params.psbtHex ?? '').trim()
        if (!psbtHex || !/^[0-9a-fA-F]+$/.test(psbtHex) || psbtHex.length % 2 !== 0) {
          throw new Eip1193ProviderRpcError(
            EIP1193_ERROR_CODES.INVALID_PARAMS,
            'unisat_signPsbt requires a valid even-length hex psbtHex string',
          )
        }
        return await this.router.dispatch<string>(
          {
            id: reqId,
            origin,
            chainFamily: 'btc',
            protocol: 'btc-unisat',
            action: 'sign_psbt',
            payload: { psbtHex, options: params.options },
          },
          async (persona) => {
            return this.signPsbtDeterministically(origin, persona, psbtHex)
          },
        )
      }

      case 'unisat_signPsbts': {
        const psbtHexs = Array.isArray(params.psbtHexs)
          ? params.psbtHexs.map((h) => String(h).trim())
          : []
        if (
          psbtHexs.length === 0 ||
          psbtHexs.some((h) => !h || !/^[0-9a-fA-F]+$/.test(h) || h.length % 2 !== 0)
        ) {
          throw new Eip1193ProviderRpcError(
            EIP1193_ERROR_CODES.INVALID_PARAMS,
            'unisat_signPsbts requires a non-empty array of valid hex PSBT strings',
          )
        }
        return await this.router.dispatch<string[]>(
          {
            id: reqId,
            origin,
            chainFamily: 'btc',
            protocol: 'btc-unisat',
            action: 'sign_psbt',
            payload: { psbtHexs, options: params.options },
          },
          async (persona) => {
            return psbtHexs.map((psbtHex) =>
              this.signPsbtDeterministically(origin, persona, psbtHex),
            )
          },
        )
      }
    }
  }

  /**
   * Handles WBIP004 / Xverse `sats-connect` requests (`BitcoinProvider`).
   */
  async handleWbip004Request(
    rawOrigin: string,
    request: {
      id?: string
      method: 'getAccounts' | 'wallet_connect' | 'signMessage' | 'signPsbt'
      params?: Record<string, unknown>
    },
  ): Promise<unknown> {
    const origin = normalizeDappOrigin(rawOrigin)
    const reqId = request.id ?? `wbip004-${bytesToHex(randomBytes(4))}`
    const params = request.params ?? {}

    switch (request.method) {
      case 'getAccounts':
      case 'wallet_connect': {
        const silent = Boolean(params.silent ?? false)
        const purposes = Array.isArray(params.purposes)
          ? (params.purposes as Wbip004AddressPurpose[])
          : undefined
        const accounts = await this.router.dispatch<Wbip004AccountDescriptor[]>(
          {
            id: reqId,
            origin,
            chainFamily: 'btc',
            protocol: 'btc-wbip004',
            action: silent ? 'get_accounts' : 'connect',
            silent,
            payload: { purposes, message: params.message },
          },
          async (persona) => this.buildWbip004Accounts(persona, purposes),
        )
        return { accounts }
      }

      case 'signMessage': {
        const messageText = String(params.message ?? '')
        const requestedAddress = String(params.address ?? '')
        return await this.router.dispatch(
          {
            id: reqId,
            origin,
            chainFamily: 'btc',
            protocol: 'btc-wbip004',
            action: 'sign_message',
            payload: { address: requestedAddress, message: messageText },
          },
          async (persona) => {
            const material = this.router.keyring.getSigningMaterialForOrigin(
              origin,
              'btc',
              persona.network,
            )
            const isOrdinals =
              requestedAddress &&
              persona.ordinalsAddress &&
              requestedAddress.toLowerCase() === persona.ordinalsAddress.toLowerCase()
            const targetAddress = isOrdinals
              ? persona.ordinalsAddress!
              : (persona.paymentAddress ?? persona.address)
            const descriptor =
              persona.network === 'mainnet' ? BTC_MAINNET : BTC_TESTNET
            const msgBytes = utf8ToBytes(messageText)

            if (isOrdinals) {
              const digest = sha256(
                utf8ToBytes(`BIP0322-simple:${targetAddress}:${messageText}`),
              )
              const schnorrPriv =
                material.ordinalsTweakedPrivateKeyBytes ??
                material.ordinalsPrivateKeyBytes ??
                material.primaryPrivateKeyBytes
              const sigBytes = schnorr.sign(digest, schnorrPriv)
              return {
                signature: bytesToBase64(sigBytes),
                messageHash: bytesToHex(digest),
                address: targetAddress,
              }
            }

            const privKey = mustNakamoto(
              privateKeyFromBytes(material.primaryPrivateKeyBytes, true),
              'Invalid BTC payment private key',
            )
            const compactSig = mustNakamoto(
              signNakamotoMessage(descriptor, privKey, msgBytes),
              'Failed to sign WBIP004 Bitcoin message',
            )
            return {
              signature: bytesToBase64(compactSig),
              messageHash: bytesToHex(sha256(msgBytes)),
              address: targetAddress,
            }
          },
        )
      }

      case 'signPsbt': {
        const psbtHexInput =
          typeof params.psbtHex === 'string'
            ? params.psbtHex.trim()
            : typeof params.psbtBase64 === 'string'
              ? Buffer.from(params.psbtBase64, 'base64').toString('hex')
              : ''
        if (
          !psbtHexInput ||
          !/^[0-9a-fA-F]+$/.test(psbtHexInput) ||
          psbtHexInput.length % 2 !== 0
        ) {
          throw new Eip1193ProviderRpcError(
            EIP1193_ERROR_CODES.INVALID_PARAMS,
            'WBIP004 signPsbt requires psbtHex or psbtBase64',
          )
        }
        return await this.router.dispatch(
          {
            id: reqId,
            origin,
            chainFamily: 'btc',
            protocol: 'btc-wbip004',
            action: 'sign_psbt',
            payload: { psbtHex: psbtHexInput, broadcast: Boolean(params.broadcast) },
          },
          async (persona) => {
            const signedPsbtHex = this.signPsbtDeterministically(
              origin,
              persona,
              psbtHexInput,
            )
            const psbtBase64 = Buffer.from(signedPsbtHex, 'hex').toString('base64')
            let txid: string | undefined
            if (params.broadcast) {
              txid = await this.router.broadcastSignedPayload({
                origin,
                chainFamily: 'btc',
                protocol: 'btc-wbip004',
                signedPayloadHex: signedPsbtHex,
                persona,
              })
            }
            return {
              psbtHex: signedPsbtHex,
              psbtBase64,
              ...(txid ? { txid } : {}),
            }
          },
        )
      }
    }
  }

  private signPsbtDeterministically(
    origin: string,
    persona: MultiChainDappPersonaRecord,
    psbtHex: string,
  ): string {
    const material = this.router.keyring.getSigningMaterialForOrigin(
      origin,
      'btc',
      persona.network,
    )
    const sighashDigest = sha256(
      utf8ToBytes(`frank-btc-psbt-v1:${persona.address}:${psbtHex.toLowerCase()}`),
    )
    const paymentSig = secp256k1
      .sign(sighashDigest, material.primaryPrivateKeyBytes, { lowS: true })
      .toCompactRawBytes()
    const taprootKey =
      material.ordinalsTweakedPrivateKeyBytes ??
      material.ordinalsPrivateKeyBytes ??
      material.primaryPrivateKeyBytes
    const taprootSig = schnorr.sign(sighashDigest, taprootKey)
    return `${psbtHex.toLowerCase()}${bytesToHex(paymentSig)}${bytesToHex(taprootSig)}`
  }
}

// ============================================================================
// 3. eCash Cashtab DOM / `window.postMessage` Bridge (`EcashCashtabBridge`)
// ============================================================================

export interface CashtabPageMessage {
  readonly type: 'FROM_PAGE'
  readonly text: 'Cashtab'
  readonly addressRequest?: boolean
  readonly txInfo?: {
    readonly address: string
    readonly value: string | number
    readonly opReturn?: string
  }
}

export interface CashtabExtensionResponse {
  readonly type: 'FROM_CASHTAB'
  readonly address?: string
  readonly txid?: string
  readonly txRejected?: boolean
  readonly reason?: string
}

export function isCashtabPageMessage(candidate: unknown): candidate is CashtabPageMessage {
  if (!candidate || typeof candidate !== 'object') return false
  const msg = candidate as Record<string, unknown>
  return msg.type === 'FROM_PAGE' && msg.text === 'Cashtab'
}

export class EcashCashtabBridge {
  constructor(private readonly router: UnifiedMultiChainDappRouter) {}

  async handlePagePostMessage(
    rawOrigin: string,
    message: unknown,
  ): Promise<CashtabExtensionResponse | null> {
    if (!isCashtabPageMessage(message)) {
      return null
    }
    const origin = normalizeDappOrigin(rawOrigin)
    const reqId = `cashtab-${bytesToHex(randomBytes(4))}`

    if (message.addressRequest) {
      try {
        const addresses = await this.router.dispatch<string[]>({
          id: reqId,
          origin,
          chainFamily: 'xec',
          protocol: 'xec-cashtab',
          action: 'connect',
          silent: false,
          payload: { addressRequest: true },
        })
        return {
          type: 'FROM_CASHTAB',
          address: addresses[0] ?? '',
        }
      } catch {
        return {
          type: 'FROM_CASHTAB',
          address: 'Address request denied by user',
        }
      }
    }

    if (message.txInfo) {
      const recipientAddress = String(message.txInfo.address ?? '').trim()
      const valueXec = String(message.txInfo.value ?? '').trim()
      if (!recipientAddress || !valueXec || Number(valueXec) <= 0) {
        throw new Eip1193ProviderRpcError(
          EIP1193_ERROR_CODES.INVALID_PARAMS,
          'Invalid Cashtab txInfo payload: requires positive value and recipient address',
        )
      }

      try {
        const txid = await this.router.dispatch<string>(
          {
            id: reqId,
            origin,
            chainFamily: 'xec',
            protocol: 'xec-cashtab',
            action: 'sign_and_send_transaction',
            silent: false,
            payload: message.txInfo,
          },
          async (persona) => {
            const material = this.router.keyring.getSigningMaterialForOrigin(
              origin,
              'xec',
              persona.network,
            )
            const preimage = utf8ToBytes(
              `frank-cashtab-tx-v1:${persona.address}->${recipientAddress}:${valueXec}:${message.txInfo?.opReturn ?? ''}`,
            )
            const digest = sha256(preimage)
            const sig = secp256k1
              .sign(digest, material.primaryPrivateKeyBytes, { lowS: true })
              .toCompactRawBytes()
            const signedTxHex = `${bytesToHex(preimage)}${bytesToHex(sig)}`
            return await this.router.broadcastSignedPayload({
              origin,
              chainFamily: 'xec',
              protocol: 'xec-cashtab',
              signedPayloadHex: signedTxHex,
              persona,
            })
          },
        )
        return {
          type: 'FROM_CASHTAB',
          txid,
        }
      } catch (err) {
        return {
          type: 'FROM_CASHTAB',
          txRejected: true,
          reason: err instanceof Error ? err.message : 'User rejected Cashtab transaction',
        }
      }
    }

    return null
  }
}

// ============================================================================
// 4. BCH / DOGE / LTC UTXO dApp Bridge (`BchUtxoBridge`)
// ============================================================================

export type BchUtxoRpcMethod =
  | 'bch_getAddresses'
  | 'bch_requestAccounts'
  | 'bch_signTransaction'
  | 'bch_signMessage'
  | 'doge_getAddresses'
  | 'doge_requestAccounts'
  | 'doge_signTransaction'
  | 'doge_signMessage'
  | 'ltc_getAddresses'
  | 'ltc_requestAccounts'
  | 'ltc_signTransaction'
  | 'ltc_signMessage'

export class BchUtxoBridge {
  constructor(private readonly router: UnifiedMultiChainDappRouter) {}

  async handleRequest(
    rawOrigin: string,
    request: {
      id?: string
      method: BchUtxoRpcMethod
      params?: Record<string, unknown>
    },
  ): Promise<unknown> {
    const origin = normalizeDappOrigin(rawOrigin)
    const reqId = request.id ?? `utxo-${bytesToHex(randomBytes(4))}`
    const params = request.params ?? {}

    const prefix = request.method.split('_')[0] as 'bch' | 'doge' | 'ltc'
    const actionPart = request.method.slice(prefix.length + 1)
    const protocol: DappProtocol =
      prefix === 'bch' ? 'bch-cashconnect' : 'utxo-wallet-standard'

    if (actionPart === 'getAddresses') {
      return await this.router.dispatch<string[]>({
        id: reqId,
        origin,
        chainFamily: prefix,
        protocol,
        action: 'get_accounts',
        silent: true,
      })
    }

    if (actionPart === 'requestAccounts') {
      return await this.router.dispatch<string[]>({
        id: reqId,
        origin,
        chainFamily: prefix,
        protocol,
        action: 'connect',
        silent: false,
      })
    }

    if (actionPart === 'signMessage') {
      const messageText = String(params.message ?? '')
      return await this.router.dispatch(
        {
          id: reqId,
          origin,
          chainFamily: prefix,
          protocol,
          action: 'sign_message',
          payload: { message: messageText },
        },
        async (persona) => {
          const material = this.router.keyring.getSigningMaterialForOrigin(
            origin,
            prefix,
            persona.network,
          )
          const msgBytes = utf8ToBytes(messageText)
          if (prefix === 'bch') {
            const descriptor =
              persona.network === 'mainnet' ? BCH_MAINNET : BCH_TESTNET
            const privKey = mustNakamoto(
              privateKeyFromBytes(material.primaryPrivateKeyBytes, true),
              'Invalid BCH persona private key',
            )
            const sig = mustNakamoto(
              signNakamotoMessage(descriptor, privKey, msgBytes),
              'Failed to sign BCH message',
            )
            return {
              address: persona.address,
              signature: bytesToBase64(sig),
            }
          }
          // DOGE and LTC message signing
          const magicPrefix =
            prefix === 'doge'
              ? 'Dogecoin Signed Message:\n'
              : 'Litecoin Signed Message:\n'
          const digest = sha256(
             sha256(utf8ToBytes(`${magicPrefix}${messageText}`)),
          )
          const sig = secp256k1
            .sign(digest, material.primaryPrivateKeyBytes, { lowS: true })
            .toCompactRawBytes()
          return {
            address: persona.address,
            signature: bytesToBase64(sig),
          }
        },
      )
    }

    if (actionPart === 'signTransaction') {
      const rawTxHex = String(params.txHex ?? params.transaction ?? '').trim()
      if (!rawTxHex) {
        throw new Eip1193ProviderRpcError(
          EIP1193_ERROR_CODES.INVALID_PARAMS,
          `${request.method} requires txHex or transaction`,
        )
      }
      return await this.router.dispatch(
        {
          id: reqId,
          origin,
          chainFamily: prefix,
          protocol,
          action: 'sign_transaction',
          payload: { txHex: rawTxHex },
        },
        async (persona) => {
          const material = this.router.keyring.getSigningMaterialForOrigin(
            origin,
            prefix,
            persona.network,
          )
          const digest = sha256(
            utf8ToBytes(`frank-${prefix}-tx-v1:${persona.address}:${rawTxHex}`),
          )
          const sig = secp256k1
            .sign(digest, material.primaryPrivateKeyBytes, { lowS: true })
            .toCompactRawBytes()
          const signedTxHex = `${rawTxHex}${bytesToHex(sig)}`
          return {
            address: persona.address,
            signedTxHex,
            txid: bytesToHex(sha256(utf8ToBytes(signedTxHex))),
          }
        },
      )
    }

    throw new Eip1193ProviderRpcError(
      EIP1193_ERROR_CODES.UNSUPPORTED_METHOD,
      `Unsupported UTXO dApp method: ${String(request.method)}`,
    )
  }
}
