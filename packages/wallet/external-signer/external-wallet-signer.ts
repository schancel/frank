import { hkdf } from '@noble/hashes/hkdf'
import { sha256 } from '@noble/hashes/sha256'
import { bytesToHex, hexToBytes, utf8ToBytes } from '@noble/hashes/utils'
import { getAddress, hexlify } from 'ethers'
import { PublicKey } from '@solana/web3.js'
import { deriveDomainRoot } from '../../domain-roots/src'
import { selfOpenKeyFromRoot } from '@frank/crypto-box'
import type { MonadRootBundle } from '../monad-wallet-material'
import {
  ColdVaultSweepConfig,
  DEFAULT_COLD_VAULT_HYSTERESIS_BPS,
  DEFAULT_MAX_HOT_BALANCE_AVU,
  defaultMaxHotBalanceForChain,
} from '../hygiene/cold-vault-sweeper'

export type ExternalSignerFamily = 'evm' | 'solana'

export const EXTERNAL_SIGNER_DOMAIN_NAME = 'Signet Cashweb Messaging' as const
export const EXTERNAL_SIGNER_DOMAIN_VERSION = '1' as const
export const EXTERNAL_SIGNER_HKDF_SALT = 'frank/external-signer/v1' as const
export const EXTERNAL_SIGNER_EIP712_PRIMARY_TYPE =
  'CashwebMessagingAuth' as const

/** Minimum distinct byte count required across a 64/65-byte cryptographic signature. */
const MIN_SIGNATURE_DISTINCT_BYTES = 8

export interface Eip712TypeField {
  readonly name: string
  readonly type: string
}

export interface EvmExternalSignerTypedData {
  readonly domain: {
    readonly name: typeof EXTERNAL_SIGNER_DOMAIN_NAME
    readonly version: typeof EXTERNAL_SIGNER_DOMAIN_VERSION
    readonly chainId?: number
  }
  readonly types: {
    readonly EIP712Domain: ReadonlyArray<Eip712TypeField>
    readonly CashwebMessagingAuth: ReadonlyArray<Eip712TypeField>
  }
  readonly primaryType: typeof EXTERNAL_SIGNER_EIP712_PRIMARY_TYPE
  readonly message: {
    readonly account: string
    readonly statement: string
  }
}

export interface EvmExternalSignerChallenge {
  readonly family: 'evm'
  readonly canonicalAddress: string
  readonly checksumAddress: string
  readonly statement: string
  readonly typedData: EvmExternalSignerTypedData
  readonly personalSignMessage: string
  readonly personalSignHex: string
}

export interface SolanaExternalSignerChallenge {
  readonly family: 'solana'
  readonly canonicalAddress: string
  readonly statement: string
  readonly messageText: string
  readonly messageBytes: Uint8Array
}

export interface Eip1193Provider {
  request(args: {
    readonly method: string
    readonly params?: ReadonlyArray<unknown>
  }): Promise<unknown>
}

export interface SolanaWalletStandardSigner {
  signMessage(
    message: Uint8Array,
  ): Promise<Uint8Array | { readonly signature: Uint8Array }>
}

export interface ExternalWalletMessagingKeys {
  readonly family: ExternalSignerFamily
  readonly canonicalAddress: string
  /** 32-byte deterministic root derived via HKDF-SHA256 from the external signature. */
  readonly messagingRoot: Uint8Array
  /** 32-byte deterministic identity authentication private key seed. */
  readonly identityPrivateKey: Uint8Array
  /** 32-byte deterministic messaging encryption private key seed. */
  readonly messagingPrivateKey: Uint8Array
  /** 32-byte deterministic self-open key for reading own sent messages. */
  readonly selfOpenKey: Uint8Array
  /** Purpose-tagged Frank domain roots compatible with `createMonadWalletMaterial`. */
  readonly domainRoots: MonadRootBundle
  /**
   * Automatically populated with the external hardware/extension wallet's main address
   * so excess incoming stamps/payments above `maxHotBalance` sweep directly back in 1 hop.
   */
  readonly externalVaultAddress?: string
  readonly coldVaultSweepConfig?: ColdVaultSweepConfig
  dispose(): void
}

/**
 * Normalizes and validates an external wallet address for domain-separated HKDF binding.
 * - EVM: validates 20-byte hex address and normalizes to lowercase `0x...`
 * - Solana: validates Ed25519 base58 public key and normalizes to canonical base58
 */
export function canonicalizeExternalSignerAddress(
  family: ExternalSignerFamily,
  address: string,
): string {
  if (typeof address !== 'string' || !address.trim()) {
    throw new Error(`Invalid ${family} address: address must be a non-empty string`)
  }
  const trimmed = address.trim()
  if (family === 'evm') {
    if (!/^0x[0-9a-fA-F]{40}$/.test(trimmed)) {
      throw new Error(
        `Invalid EVM address "${trimmed}": expected 0x followed by 40 hex characters`,
      )
    }
    return getAddress(trimmed.toLowerCase()).toLowerCase()
  }
  if (family === 'solana') {
    try {
      const pubkey = new PublicKey(trimmed)
      return pubkey.toBase58()
    } catch {
      throw new Error(
        `Invalid Solana address "${trimmed}": expected valid base58 Ed25519 public key`,
      )
    }
  }
  throw new Error(`Unsupported external signer family: ${String(family)}`)
}

/**
 * Builds the canonical human-readable authorization statement:
 * `"Authorize deterministic Cashweb messaging keys for account <address>. Never sign this on untrusted origins."`
 */
export function buildExternalSignerStatement(address: string): string {
  const trimmed = (address || '').trim()
  if (!trimmed) {
    throw new Error('Address is required to build external signer statement')
  }
  return `Authorize deterministic Cashweb messaging keys for account ${trimmed}. Never sign this on untrusted origins.`
}

/**
 * Constructs the canonical EVM signing challenge supporting both `EIP-712` (`eth_signTypedData_v4`)
 * and `personal_sign` fallback for hardware/extension wallets.
 */
export function buildEvmExternalSignerChallenge(
  address: string,
  options?: { readonly chainId?: number },
): EvmExternalSignerChallenge {
  const canonicalAddress = canonicalizeExternalSignerAddress('evm', address)
  const checksumAddress = getAddress(canonicalAddress)
  const statement = buildExternalSignerStatement(canonicalAddress)

  const domainFields: Eip712TypeField[] = [
    { name: 'name', type: 'string' },
    { name: 'version', type: 'string' },
    ...(options?.chainId !== undefined
      ? [{ name: 'chainId', type: 'uint256' }]
      : []),
  ]

  const typedData: EvmExternalSignerTypedData = {
    domain: {
      name: EXTERNAL_SIGNER_DOMAIN_NAME,
      version: EXTERNAL_SIGNER_DOMAIN_VERSION,
      ...(options?.chainId !== undefined ? { chainId: options.chainId } : {}),
    },
    types: {
      EIP712Domain: domainFields,
      CashwebMessagingAuth: [
        { name: 'account', type: 'address' },
        { name: 'statement', type: 'string' },
      ],
    },
    primaryType: EXTERNAL_SIGNER_EIP712_PRIMARY_TYPE,
    message: {
      account: canonicalAddress,
      statement,
    },
  }

  const personalSignMessage = [
    `${EXTERNAL_SIGNER_DOMAIN_NAME} (v${EXTERNAL_SIGNER_DOMAIN_VERSION})`,
    `Account: ${canonicalAddress}`,
    statement,
  ].join('\n')

  return {
    family: 'evm',
    canonicalAddress,
    checksumAddress,
    statement,
    typedData,
    personalSignMessage,
    personalSignHex: hexlify(utf8ToBytes(personalSignMessage)),
  }
}

/**
 * Constructs the canonical Solana `Wallet-Standard` `signMessage` UTF-8 domain-separated challenge.
 */
export function buildSolanaExternalSignerChallenge(
  address: string,
): SolanaExternalSignerChallenge {
  const canonicalAddress = canonicalizeExternalSignerAddress('solana', address)
  const statement = buildExternalSignerStatement(canonicalAddress)
  const messageText = [
    `${EXTERNAL_SIGNER_DOMAIN_NAME} (v${EXTERNAL_SIGNER_DOMAIN_VERSION})`,
    `Account: ${canonicalAddress}`,
    statement,
  ].join('\n')

  return {
    family: 'solana',
    canonicalAddress,
    statement,
    messageText,
    messageBytes: utf8ToBytes(messageText),
  }
}

/**
 * Verifies signature length and byte entropy, normalizing EVM recovery ID `v` (`0/1` -> `27/28`)
 * so Ledger and MetaMask produce identical canonical signature bytes.
 */
export function validateAndNormalizeSignatureBytes(
  family: ExternalSignerFamily,
  signatureBytes: Uint8Array,
): Uint8Array {
  if (!(signatureBytes instanceof Uint8Array)) {
    throw new Error('External signature must be a Uint8Array')
  }

  if (family === 'evm') {
    if (signatureBytes.length !== 64 && signatureBytes.length !== 65) {
      throw new Error(
        `Invalid EVM signature length ${signatureBytes.length}: expected 64 or 65 bytes`,
      )
    }
  } else if (family === 'solana') {
    if (signatureBytes.length !== 64) {
      throw new Error(
        `Invalid Solana signature length ${signatureBytes.length}: expected 64 bytes`,
      )
    }
  } else {
    throw new Error(`Unsupported external signer family: ${String(family)}`)
  }

  // Reject all-zero or low-entropy / constant-byte signatures
  const distinctBytes = new Set<number>()
  for (let i = 0; i < signatureBytes.length; i++) {
    distinctBytes.add(signatureBytes[i])
  }
  if (distinctBytes.size < MIN_SIGNATURE_DISTINCT_BYTES) {
    throw new Error(
      `External signature rejected: insufficient entropy (${distinctBytes.size} distinct byte values, minimum ${MIN_SIGNATURE_DISTINCT_BYTES})`,
    )
  }

  // Check that neither r (first 32 bytes) nor s (next 32 bytes) is all zeros
  const rAllZero = signatureBytes.subarray(0, 32).every(b => b === 0)
  const sAllZero = signatureBytes.subarray(32, 64).every(b => b === 0)
  if (rAllZero || sAllZero) {
    throw new Error(
      'External signature rejected: r or s component is all-zero',
    )
  }

  const normalized = Uint8Array.from(signatureBytes)
  if (family === 'evm' && normalized.length === 65) {
    const v = normalized[64]
    if (v === 0 || v === 1) {
      normalized[64] = v + 27
    }
  }
  return normalized
}

/**
 * Derives a deterministic 32-byte messaging seed from an external wallet signature:
 * `HKDF-SHA256(ikm = signatureBytes, salt = "frank/external-signer/v1", info = family + ":" + canonicalAddress, length = 32)`
 */
export function deriveMessagingRootFromExternalSignature(params: {
  family: ExternalSignerFamily
  address: string
  signatureBytes: Uint8Array
}): Uint8Array {
  const canonicalAddress = canonicalizeExternalSignerAddress(
    params.family,
    params.address,
  )
  const normalizedSignature = validateAndNormalizeSignatureBytes(
    params.family,
    params.signatureBytes,
  )
  const saltBytes = utf8ToBytes(EXTERNAL_SIGNER_HKDF_SALT)
  const infoBytes = utf8ToBytes(`${params.family}:${canonicalAddress}`)

  try {
    return hkdf(sha256, normalizedSignature, saltBytes, infoBytes, 32)
  } finally {
    normalizedSignature.fill(0)
  }
}

/**
 * Derives the full deterministic messaging key bundle (`messagingRoot`, `identityPrivateKey`,
 * `messagingPrivateKey`, `selfOpenKey`, and `domainRoots`) from an external wallet signature,
 * and optionally auto-configures `externalVaultAddress = address` for 1-hop Cold-Wallet Auto-Sweeping.
 */
export function deriveExternalWalletMessagingKeys(params: {
  family: ExternalSignerFamily
  address: string
  signatureBytes: Uint8Array
  chainId?: string
  /** Defaults to true: sets `externalVaultAddress = address` so hot-wallet excess sweeps back to the external wallet. */
  autoConfigureColdVault?: boolean
  maxHotBalanceAtomic?: bigint
}): ExternalWalletMessagingKeys {
  const canonicalAddress = canonicalizeExternalSignerAddress(
    params.family,
    params.address,
  )
  const messagingRoot = deriveMessagingRootFromExternalSignature(params)

  const authentication = deriveDomainRoot(
    messagingRoot,
    'identity-authentication',
  )
  const messaging = deriveDomainRoot(messagingRoot, 'messaging-encryption')
  const evm = deriveDomainRoot(messagingRoot, 'evm-wallet')
  const selfOpenKey = selfOpenKeyFromRoot(messaging.bytes)

  const identityPrivateKey = hkdf(
    sha256,
    authentication.bytes,
    utf8ToBytes(EXTERNAL_SIGNER_HKDF_SALT),
    utf8ToBytes(`${params.family}:${canonicalAddress}:identity-private-key`),
    32,
  )
  const messagingPrivateKey = hkdf(
    sha256,
    messaging.bytes,
    utf8ToBytes(EXTERNAL_SIGNER_HKDF_SALT),
    utf8ToBytes(`${params.family}:${canonicalAddress}:messaging-private-key`),
    32,
  )

  const autoVault = params.autoConfigureColdVault ?? true
  const resolvedChainId =
    params.chainId ??
    (params.family === 'evm' ? 'monad-testnet' : 'solana-devnet')
  const vaultAddress =
    params.family === 'evm' ? getAddress(canonicalAddress) : canonicalAddress

  const coldVaultSweepConfig: ColdVaultSweepConfig | undefined = autoVault
    ? {
        chainId: resolvedChainId,
        enabled: true,
        externalVaultAddress: vaultAddress,
        maxHotBalanceAtomic:
          params.maxHotBalanceAtomic ??
          defaultMaxHotBalanceForChain(resolvedChainId),
        maxHotBalanceAvu: DEFAULT_MAX_HOT_BALANCE_AVU,
        hysteresisBps: DEFAULT_COLD_VAULT_HYSTERESIS_BPS,
      }
    : undefined

  return {
    family: params.family,
    canonicalAddress,
    messagingRoot,
    identityPrivateKey,
    messagingPrivateKey,
    selfOpenKey,
    domainRoots: {
      evm,
      authentication,
      messaging,
    },
    ...(autoVault
      ? {
          externalVaultAddress: vaultAddress,
          coldVaultSweepConfig,
        }
      : {}),
    dispose() {
      messagingRoot.fill(0)
      identityPrivateKey.fill(0)
      messagingPrivateKey.fill(0)
      selfOpenKey.fill(0)
      evm.bytes.fill(0)
      authentication.bytes.fill(0)
      messaging.bytes.fill(0)
    },
  }
}

export function parseHexSignatureBytes(signatureHex: string): Uint8Array {
  if (typeof signatureHex !== 'string') {
    throw new Error('Expected hex string signature from EVM provider')
  }
  const clean = signatureHex.trim().replace(/^0x/i, '')
  if (!/^[0-9a-fA-F]+$/.test(clean) || clean.length % 2 !== 0) {
    throw new Error('Invalid hex signature returned by EVM provider')
  }
  return hexToBytes(clean)
}

function isUserRejectedProviderError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false
  const code = (err as { code?: unknown }).code
  return code === 4001 || code === 'ACTION_REJECTED'
}

/**
 * Requests a deterministic messaging authorization signature from an `EIP-1193` provider
 * (MetaMask, Rabby, Ledger, etc.), trying `eth_signTypedData_v4` (`EIP-712`) first and
 * falling back to `personal_sign` if the provider does not support typed data signing.
 */
export async function signWithEip1193Provider(params: {
  provider: Eip1193Provider
  address: string
  chainId?: number
  preferPersonalSign?: boolean
  autoConfigureColdVault?: boolean
  maxHotBalanceAtomic?: bigint
}): Promise<{
  challenge: EvmExternalSignerChallenge
  signatureBytes: Uint8Array
  signatureHex: string
  methodUsed: 'eth_signTypedData_v4' | 'personal_sign'
  keys: ExternalWalletMessagingKeys
}> {
  const challenge = buildEvmExternalSignerChallenge(params.address, {
    chainId: params.chainId,
  })

  let rawSig: unknown
  let methodUsed: 'eth_signTypedData_v4' | 'personal_sign' =
    'eth_signTypedData_v4'

  if (!params.preferPersonalSign) {
    try {
      rawSig = await params.provider.request({
        method: 'eth_signTypedData_v4',
        params: [
          challenge.canonicalAddress,
          JSON.stringify(challenge.typedData),
        ],
      })
    } catch (err) {
      if (isUserRejectedProviderError(err)) {
        throw err
      }
      methodUsed = 'personal_sign'
      rawSig = await params.provider.request({
        method: 'personal_sign',
        params: [challenge.personalSignHex, challenge.canonicalAddress],
      })
    }
  } else {
    methodUsed = 'personal_sign'
    rawSig = await params.provider.request({
      method: 'personal_sign',
      params: [challenge.personalSignHex, challenge.canonicalAddress],
    })
  }

  const parsedBytes = parseHexSignatureBytes(String(rawSig))
  const signatureBytes = validateAndNormalizeSignatureBytes('evm', parsedBytes)
  const keys = deriveExternalWalletMessagingKeys({
    family: 'evm',
    address: challenge.canonicalAddress,
    signatureBytes,
    autoConfigureColdVault: params.autoConfigureColdVault,
    maxHotBalanceAtomic: params.maxHotBalanceAtomic,
  })

  return {
    challenge,
    signatureBytes,
    signatureHex: '0x' + bytesToHex(signatureBytes),
    methodUsed,
    keys,
  }
}

/**
 * Requests a deterministic messaging authorization signature from a Solana `Wallet-Standard`
 * signer (Phantom, Solflare, Backpack, Ledger) via `signMessage`.
 */
export async function signWithSolanaWalletStandard(params: {
  signer: SolanaWalletStandardSigner
  address: string
  chainId?: string
  autoConfigureColdVault?: boolean
  maxHotBalanceAtomic?: bigint
}): Promise<{
  challenge: SolanaExternalSignerChallenge
  signatureBytes: Uint8Array
  keys: ExternalWalletMessagingKeys
}> {
  const challenge = buildSolanaExternalSignerChallenge(params.address)
  const response = await params.signer.signMessage(challenge.messageBytes)
  const rawBytes =
    response instanceof Uint8Array ? response : response.signature
  const signatureBytes = validateAndNormalizeSignatureBytes('solana', rawBytes)

  const keys = deriveExternalWalletMessagingKeys({
    family: 'solana',
    address: challenge.canonicalAddress,
    signatureBytes,
    chainId: params.chainId,
    autoConfigureColdVault: params.autoConfigureColdVault,
    maxHotBalanceAtomic: params.maxHotBalanceAtomic,
  })

  return {
    challenge,
    signatureBytes,
    keys,
  }
}
