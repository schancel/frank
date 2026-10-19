import {
  HDNodeWallet,
  Mnemonic,
  Transaction,
  TypedDataEncoder,
  Wallet,
  getAddress,
  hexlify,
  isAddress,
  keccak256,
  toUtf8Bytes,
} from 'ethers'
import { secp256k1 } from '@noble/curves/secp256k1'
import { sha256 } from '@noble/hashes/sha256'
import { bytesToHex, hexToBytes, randomBytes, utf8ToBytes } from '@noble/hashes/utils'
import {
  type DerivedDevicePairingKeys,
  type DevicePairingQrPayload,
  type DevicePairingSession,
  type DeviceSyncBundle,
  type EncryptedDeviceSyncBundle,
  createDevicePairingSession,
  decryptDeviceSyncBundle,
  deriveDevicePairingKeys,
  encryptDeviceSyncBundle,
  zeroizePairingKeys,
} from '../device-pairing'

export const FRANK_EIP6963_RDNS = 'mx.signet.frank' as const
export const FRANK_EIP6963_NAME = 'Frank' as const
export const FRANK_EIP6963_ICON_DATA_URI =
  "data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'><rect width='64' height='64' rx='14' fill='%230B0F17'/><path d='M20 16h26v8H28v8h14v8H28v10h-8V16z' fill='%2310B981'/></svg>" as const

export const DAPP_PERSONA_BIP44_PATH_PREFIX = "m/44'/60'/1'/0" as const
export const STAMP_POOL_BIP44_PATH_PREFIX = "m/44'/60'/0'/0" as const

export const EIP1193_ERROR_CODES = {
  USER_REJECTED_REQUEST: 4001,
  UNAUTHORIZED: 4100,
  UNSUPPORTED_METHOD: 4200,
  DISCONNECTED: 4900,
  CHAIN_DISCONNECTED: 4901,
  UNRECOGNIZED_CHAIN_ID: 4902,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
} as const

export interface Eip6963ProviderInfo {
  uuid: string
  name: string
  icon: string
  rdns: string
}

function generateUuidV4(): string {
  const bytes = randomBytes(16)
  bytes[6] = (bytes[6] & 0x0f) | 0x40
  bytes[8] = (bytes[8] & 0x3f) | 0x80
  const hex = bytesToHex(bytes)
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`
}

/**
 * Builds the EIP-6963 provider announcement descriptor for Frank.
 */
export function createFrankEip6963ProviderInfo(uuid?: string): Eip6963ProviderInfo {
  const resolvedUuid = uuid?.trim() ? uuid.trim() : generateUuidV4()
  return {
    uuid: resolvedUuid,
    name: FRANK_EIP6963_NAME,
    icon: FRANK_EIP6963_ICON_DATA_URI,
    rdns: FRANK_EIP6963_RDNS,
  }
}

export interface DappPersonaRecord {
  index: number
  derivationPath: string
  address: string
  publicKeyHex: string
  label: string
  boundOrigin?: string
  createdAtMs: number
  retired?: boolean
}

export interface DerivedDappPersonaKeypair {
  index: number
  derivationPath: string
  address: string
  publicKeyHex: string
  privateKeyHex: string
}

function resolveMasterSeedBytes(masterSeedOrMnemonic: Uint8Array | string): Uint8Array {
  if (masterSeedOrMnemonic instanceof Uint8Array) {
    if (masterSeedOrMnemonic.length < 16 || masterSeedOrMnemonic.length > 64) {
      throw new Error(
        `Invalid master seed byte length (${masterSeedOrMnemonic.length}): expected 16..64 bytes`,
      )
    }
    return masterSeedOrMnemonic
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

/**
 * Derives a dedicated dApp Persona EOA keypair on BIP-44 account 1 (`m/44'/60'/1'/0/${index}`),
 * ensuring 100% cryptographic separation from both the Frank messaging identity key
 * and the `EvmStampPayer` sub-account pool (`m/44'/60'/0'/0/${i}`).
 */
export function deriveDappPersonaKeypair(
  masterSeedOrMnemonic: Uint8Array | string,
  index: number,
): DerivedDappPersonaKeypair {
  if (!Number.isSafeInteger(index) || index < 0) {
    throw new Error(`Invalid dApp persona index: ${String(index)} (expected non-negative integer)`)
  }
  const seedBytes = resolveMasterSeedBytes(masterSeedOrMnemonic)
  const derivationPath = `${DAPP_PERSONA_BIP44_PATH_PREFIX}/${index}`
  const hdNode = HDNodeWallet.fromSeed(seedBytes).derivePath(derivationPath)
  return {
    index,
    derivationPath,
    address: getAddress(hdNode.address),
    publicKeyHex: hdNode.publicKey,
    privateKeyHex: hdNode.privateKey,
  }
}

/**
 * Helper to derive a Stamp Pool sub-account (`m/44'/60'/0'/0/${index}`) for disjointness verification.
 */
export function deriveStampPoolSubAccountAddress(
  masterSeedOrMnemonic: Uint8Array | string,
  index: number,
): { index: number; derivationPath: string; address: string } {
  if (!Number.isSafeInteger(index) || index < 0) {
    throw new Error(`Invalid stamp pool index: ${String(index)}`)
  }
  const seedBytes = resolveMasterSeedBytes(masterSeedOrMnemonic)
  const derivationPath = `${STAMP_POOL_BIP44_PATH_PREFIX}/${index}`
  const hdNode = HDNodeWallet.fromSeed(seedBytes).derivePath(derivationPath)
  return {
    index,
    derivationPath,
    address: getAddress(hdNode.address),
  }
}

/**
 * Normalizes and validates a dApp origin URL.
 * Rejects opaque (`"null"`), `file://`, `javascript:`, `data:`, and non-HTTPS origins
 * (except `http://localhost` / `http://127.0.0.1` by default, and browser extension origins when enabled).
 */
export function normalizeDappOrigin(
  rawOrigin: string,
  options?: {
    allowExtensionOrigins?: boolean
    allowLocalhostHttp?: boolean
  },
): string {
  if (typeof rawOrigin !== 'string') {
    throw new Error('Invalid dApp origin: expected string')
  }
  const trimmed = rawOrigin.trim()
  if (!trimmed || trimmed.toLowerCase() === 'null') {
    throw new Error('Rejected opaque or empty dApp origin')
  }

  let parsed: URL
  try {
    parsed = new URL(trimmed)
  } catch {
    throw new Error(`Malformed dApp origin URL: ${trimmed}`)
  }

  const protocol = parsed.protocol.toLowerCase()
  const allowLocalhostHttp = options?.allowLocalhostHttp ?? true
  const allowExtensionOrigins = options?.allowExtensionOrigins ?? false

  if (protocol === 'https:') {
    if (!parsed.hostname) {
      throw new Error(`Invalid HTTPS dApp origin hostname: ${trimmed}`)
    }
    return parsed.origin.toLowerCase()
  }

  if (protocol === 'http:') {
    const host = parsed.hostname.toLowerCase()
    if (
      allowLocalhostHttp &&
      (host === 'localhost' || host === '127.0.0.1' || host === '[::1]')
    ) {
      return parsed.origin.toLowerCase()
    }
    throw new Error(`Rejected insecure HTTP dApp origin: ${trimmed}`)
  }

  if (
    allowExtensionOrigins &&
    (protocol === 'chrome-extension:' ||
      protocol === 'moz-extension:' ||
      protocol === 'safari-web-extension:')
  ) {
    if (!parsed.hostname) {
      throw new Error(`Invalid browser extension origin: ${trimmed}`)
    }
    return `${protocol}//${parsed.hostname.toLowerCase()}`
  }

  throw new Error(`Unsupported or forbidden dApp origin protocol (${protocol}): ${trimmed}`)
}

/**
 * Enforces the core security invariant of `#1708`: a dApp-exposed address must NEVER match
 * the user's messaging identity address or any `EvmStampPayer` pool sub-account address.
 */
export function assertNotIdentityOrStampPoolAddress(
  address: string,
  forbiddenAddresses: Iterable<string>,
): void {
  if (!isAddress(address)) {
    throw new Error(`Invalid Ethereum address: ${String(address)}`)
  }
  const normalizedCandidate = getAddress(address).toLowerCase()
  for (const forbidden of forbiddenAddresses) {
    if (!forbidden || !isAddress(forbidden)) continue
    if (getAddress(forbidden).toLowerCase() === normalizedCandidate) {
      throw new Error(
        `Security invariant violation: address ${getAddress(address)} collides with protected identity or stamp pool sub-account`,
      )
    }
  }
}

export interface DappPersonaKeyringOptions {
  masterSeedOrMnemonic: Uint8Array | string
  forbiddenAddresses?: Iterable<string>
  stampPoolGuardCount?: number
  nowMs?: () => number
}

/**
 * Manages Frank's dedicated dApp Persona EOAs (`m/44'/60'/1'/0/k`) and origin-level permissions.
 *
 * - Index `0` is the primary dApp checking persona (`m/44'/60'/1'/0/0`).
 * - Indices `1..N` are isolated per-origin burner personas so unfamiliar dApps cannot correlate
 *   addresses across sites (`app.uniswap.org` vs `opensea.io`).
 */
export class DappPersonaKeyring {
  private readonly masterSeedBytes: Uint8Array
  private readonly forbiddenAddressSet: Set<string>
  private readonly nowMs: () => number
  private readonly personasByIndex = new Map<number, DappPersonaRecord>()
  private readonly privateKeysByIndex = new Map<number, string>()
  private readonly originToPersonaIndex = new Map<string, number>()

  constructor(options: DappPersonaKeyringOptions) {
    this.masterSeedBytes = new Uint8Array(resolveMasterSeedBytes(options.masterSeedOrMnemonic))
    this.nowMs = options.nowMs ?? (() => Date.now())
    this.forbiddenAddressSet = new Set<string>()

    if (options.forbiddenAddresses) {
      for (const addr of options.forbiddenAddresses) {
        if (addr && isAddress(addr)) {
          this.forbiddenAddressSet.add(getAddress(addr).toLowerCase())
        }
      }
    }

    const guardCount = options.stampPoolGuardCount ?? 32
    for (let i = 0; i < guardCount; i++) {
      const sub = deriveStampPoolSubAccountAddress(this.masterSeedBytes, i)
      this.forbiddenAddressSet.add(sub.address.toLowerCase())
    }

    // Always pre-initialize index 0 (Primary dApp Checking Persona)
    this.ensurePersona(0, { label: 'Primary dApp Persona' })
  }

  private ensurePersona(
    index: number,
    meta?: { label?: string; boundOrigin?: string; nowMs?: number },
  ): DappPersonaRecord {
    const existing = this.personasByIndex.get(index)
    if (existing) {
      return existing
    }

    const derived = deriveDappPersonaKeypair(this.masterSeedBytes, index)
    this.assertNotIdentityOrStampPoolAddress(derived.address)

    const record: DappPersonaRecord = {
      index,
      derivationPath: derived.derivationPath,
      address: derived.address,
      publicKeyHex: derived.publicKeyHex,
      label:
        meta?.label ??
        (index === 0 ? 'Primary dApp Persona' : `Burner Persona #${index}`),
      ...(meta?.boundOrigin ? { boundOrigin: meta.boundOrigin } : {}),
      createdAtMs: meta?.nowMs ?? this.nowMs(),
      retired: false,
    }

    this.personasByIndex.set(index, record)
    this.privateKeysByIndex.set(index, derived.privateKeyHex)
    return record
  }

  assertNotIdentityOrStampPoolAddress(
    address: string,
    extraForbiddenAddresses?: Iterable<string>,
  ): void {
    assertNotIdentityOrStampPoolAddress(address, this.forbiddenAddressSet)
    if (extraForbiddenAddresses) {
      assertNotIdentityOrStampPoolAddress(address, extraForbiddenAddresses)
    }
  }

  registerForbiddenAddresses(addresses: Iterable<string>): void {
    for (const addr of addresses) {
      if (addr && isAddress(addr)) {
        const normalized = getAddress(addr).toLowerCase()
        for (const persona of this.personasByIndex.values()) {
          if (persona.address.toLowerCase() === normalized) {
            throw new Error(
              `Cannot register active dApp persona ${persona.address} as a forbidden address`,
            )
          }
        }
        this.forbiddenAddressSet.add(normalized)
      }
    }
  }

  connectOrigin(
    rawOrigin: string,
    options?: {
      burner?: boolean
      label?: string
      personaIndex?: number
      nowMs?: number
    },
  ): DappPersonaRecord {
    const origin = normalizeDappOrigin(rawOrigin)
    const existingIdx = this.originToPersonaIndex.get(origin)
    if (existingIdx !== undefined && options?.personaIndex === undefined) {
      const existingPersona = this.personasByIndex.get(existingIdx)
      if (existingPersona && !existingPersona.retired) {
        if (options?.burner === true && existingPersona.index === 0) {
          // Upgrade from primary persona to dedicated burner persona
        } else if (options?.burner === false && existingPersona.index !== 0) {
          // Switch from burner persona to primary persona
        } else {
          return { ...existingPersona }
        }
      }
    }

    let targetIndex: number
    if (options?.personaIndex !== undefined) {
      if (!Number.isSafeInteger(options.personaIndex) || options.personaIndex < 0) {
        throw new Error(`Invalid personaIndex: ${String(options.personaIndex)}`)
      }
      targetIndex = options.personaIndex
    } else if (options?.burner) {
      // Find existing non-retired burner bound to this origin or allocate next index >= 1
      let boundBurner: DappPersonaRecord | undefined
      for (const persona of this.personasByIndex.values()) {
        if (persona.index > 0 && persona.boundOrigin === origin && !persona.retired) {
          boundBurner = persona
          break
        }
      }
      if (boundBurner) {
        targetIndex = boundBurner.index
      } else {
        const maxIndex = Math.max(0, ...Array.from(this.personasByIndex.keys()))
        targetIndex = maxIndex + 1
      }
    } else {
      targetIndex = 0
    }

    const hostLabel = new URL(origin).hostname
    const persona = this.ensurePersona(targetIndex, {
      label:
        options?.label ??
        (targetIndex === 0 ? 'Primary dApp Persona' : `${hostLabel} Burner Persona`),
      boundOrigin: targetIndex > 0 ? origin : undefined,
      nowMs: options?.nowMs,
    })

    if (persona.retired) {
      throw new Error(`Cannot connect origin ${origin} to retired persona #${persona.index}`)
    }

    this.originToPersonaIndex.set(origin, persona.index)
    return { ...persona }
  }

  disconnectOrigin(rawOrigin: string): boolean {
    const origin = normalizeDappOrigin(rawOrigin)
    return this.originToPersonaIndex.delete(origin)
  }

  getConnectedPersonaForOrigin(rawOrigin: string): DappPersonaRecord | null {
    const origin = normalizeDappOrigin(rawOrigin)
    const idx = this.originToPersonaIndex.get(origin)
    if (idx === undefined) return null
    const persona = this.personasByIndex.get(idx)
    if (!persona || persona.retired) return null
    return { ...persona }
  }

  getPersonaByIndex(index: number): DappPersonaRecord | null {
    const persona = this.personasByIndex.get(index)
    return persona ? { ...persona } : null
  }

  getPersonaByAddress(address: string): DappPersonaRecord | null {
    if (!isAddress(address)) return null
    const normalized = getAddress(address).toLowerCase()
    for (const persona of this.personasByIndex.values()) {
      if (persona.address.toLowerCase() === normalized) {
        return { ...persona }
      }
    }
    return null
  }

  retirePersona(index: number): DappPersonaRecord {
    if (index === 0) {
      throw new Error('Cannot retire primary dApp persona (index 0)')
    }
    const persona = this.personasByIndex.get(index)
    if (!persona) {
      throw new Error(`Unknown dApp persona index: ${index}`)
    }
    persona.retired = true
    for (const [origin, mappedIdx] of this.originToPersonaIndex.entries()) {
      if (mappedIdx === index) {
        this.originToPersonaIndex.delete(origin)
      }
    }
    return { ...persona }
  }

  listPersonas(): DappPersonaRecord[] {
    return Array.from(this.personasByIndex.values())
      .sort((a, b) => a.index - b.index)
      .map((p) => ({ ...p }))
  }

  listConnectedOrigins(): Array<{ origin: string; persona: DappPersonaRecord }> {
    const result: Array<{ origin: string; persona: DappPersonaRecord }> = []
    for (const [origin, idx] of this.originToPersonaIndex.entries()) {
      const persona = this.personasByIndex.get(idx)
      if (persona && !persona.retired) {
        result.push({ origin, persona: { ...persona } })
      }
    }
    return result
  }

  getPrivateKeyHex(index: number): string {
    const persona = this.ensurePersona(index)
    this.assertNotIdentityOrStampPoolAddress(persona.address)
    const priv = this.privateKeysByIndex.get(index)
    if (!priv) {
      throw new Error(`Private key unavailable for dApp persona index ${index}`)
    }
    return priv
  }
}

export interface DappJitSweepCalculationParams {
  personaBalanceWei: bigint
  txValueWei: bigint
  gasLimit: bigint
  maxFeePerGasWei: bigint
  sweepTxGasLimit?: bigint
}

export interface DappJitSweepRequirement {
  requiresSweep: boolean
  shortfallWei: bigint
  sweepFeeOverheadWei: bigint
  totalPoolClaimWei: bigint
  requiredPersonaWei: bigint
}

/**
 * Computes the exact Just-In-Time (JIT) pre-funding requirement for a dApp transaction:
 *
 * $$
 * \Delta_{\text{shortfall}} = \max\bigl(0,\; (V_{\text{tx}} + G_{\text{dapp}} \cdot F_{\max}) - B_{\text{persona}}\bigr)
 * $$
 *
 * When a shortfall exists, also computes `sweepFeeOverheadWei` ($21{,}000 \cdot F_{\max}$ by default)
 * and `totalPoolClaimWei = shortfallWei + sweepFeeOverheadWei`.
 */
export function calculateDappJitSweepRequirement(
  params: DappJitSweepCalculationParams,
): DappJitSweepRequirement {
  if (params.personaBalanceWei < 0n) {
    throw new Error('personaBalanceWei must be non-negative')
  }
  if (params.txValueWei < 0n) {
    throw new Error('txValueWei must be non-negative')
  }
  if (params.gasLimit <= 0n) {
    throw new Error('gasLimit must be positive')
  }
  if (params.maxFeePerGasWei < 0n) {
    throw new Error('maxFeePerGasWei must be non-negative')
  }
  const sweepTxGasLimit = params.sweepTxGasLimit ?? 21_000n
  if (sweepTxGasLimit <= 0n) {
    throw new Error('sweepTxGasLimit must be positive')
  }

  const requiredPersonaWei = params.txValueWei + params.gasLimit * params.maxFeePerGasWei
  if (params.personaBalanceWei >= requiredPersonaWei) {
    return {
      requiresSweep: false,
      shortfallWei: 0n,
      sweepFeeOverheadWei: 0n,
      totalPoolClaimWei: 0n,
      requiredPersonaWei,
    }
  }

  const shortfallWei = requiredPersonaWei - params.personaBalanceWei
  const sweepFeeOverheadWei = sweepTxGasLimit * params.maxFeePerGasWei
  return {
    requiresSweep: true,
    shortfallWei,
    sweepFeeOverheadWei,
    totalPoolClaimWei: shortfallWei + sweepFeeOverheadWei,
    requiredPersonaWei,
  }
}

export interface DappEip1559TxRequest {
  to: string
  value?: bigint
  data?: string
  nonce: number
  gasLimit: bigint
  maxFeePerGasWei: bigint
  maxPriorityFeePerGasWei?: bigint
  chainId: bigint
}

export interface ExecuteDappJitSweepAndSignParams {
  keyring: DappPersonaKeyring
  personaIndex: number
  personaBalanceWei: bigint
  txRequest: DappEip1559TxRequest
  sweepFromPool?: (
    shortfallWei: bigint,
    recipientPersonaAddress: string,
  ) => Promise<{ sweepTxHashes: string[]; fundedWei: bigint }>
}

export interface ExecuteDappJitSweepAndSignResult {
  signedTxHex: string
  txHash: string
  personaAddress: string
  sweepExecuted: boolean
  sweepTxHashes: string[]
  shortfallWei: bigint
  requiredPersonaWei: bigint
}

/**
 * Consolidates any shortfall from the Frank `EvmStampPayer` pool into the target dApp Persona EOA
 * Just-In-Time (JIT), then signs the EIP-1559 (Type 2) transaction with the Persona EOA's key.
 */
export async function executeDappJitSweepAndSignTx(
  params: ExecuteDappJitSweepAndSignParams,
): Promise<ExecuteDappJitSweepAndSignResult> {
  const persona = params.keyring.getPersonaByIndex(params.personaIndex)
  if (!persona) {
    throw new Error(`Unknown dApp persona index: ${params.personaIndex}`)
  }
  if (persona.retired) {
    throw new Error(`dApp persona #${params.personaIndex} is retired`)
  }
  params.keyring.assertNotIdentityOrStampPoolAddress(persona.address)

  if (!isAddress(params.txRequest.to)) {
    throw new Error(`Invalid transaction recipient address: ${params.txRequest.to}`)
  }

  const txValueWei = params.txRequest.value ?? 0n
  const requirement = calculateDappJitSweepRequirement({
    personaBalanceWei: params.personaBalanceWei,
    txValueWei,
    gasLimit: params.txRequest.gasLimit,
    maxFeePerGasWei: params.txRequest.maxFeePerGasWei,
  })

  let sweepExecuted = false
  let sweepTxHashes: string[] = []

  if (requirement.requiresSweep) {
    if (!params.sweepFromPool) {
      throw new Error(
        `Insufficient dApp persona balance: shortfall ${requirement.shortfallWei.toString()} wei and no sweepFromPool handler provided`,
      )
    }
    const sweepOutcome = await params.sweepFromPool(
      requirement.shortfallWei,
      persona.address,
    )
    if (sweepOutcome.fundedWei < requirement.shortfallWei) {
      throw new Error(
        `JIT pool sweep underfunded persona: needed ${requirement.shortfallWei.toString()} wei, funded ${sweepOutcome.fundedWei.toString()} wei`,
      )
    }
    sweepExecuted = true
    sweepTxHashes = [...sweepOutcome.sweepTxHashes]
  }

  const privateKeyHex = params.keyring.getPrivateKeyHex(params.personaIndex)
  const wallet = new Wallet(privateKeyHex)
  const maxPriorityFeePerGas =
    params.txRequest.maxPriorityFeePerGasWei ??
    (params.txRequest.maxFeePerGasWei > 1_000_000_000n
      ? 1_000_000_000n
      : params.txRequest.maxFeePerGasWei)

  const tx = Transaction.from({
    type: 2,
    to: getAddress(params.txRequest.to),
    value: txValueWei,
    data: params.txRequest.data ?? '0x',
    nonce: params.txRequest.nonce,
    gasLimit: params.txRequest.gasLimit,
    maxFeePerGas: params.txRequest.maxFeePerGasWei,
    maxPriorityFeePerGas,
    chainId: params.txRequest.chainId,
  })

  const signedTxHex = await wallet.signTransaction(tx)
  const txHash = keccak256(signedTxHex)

  return {
    signedTxHex,
    txHash,
    personaAddress: persona.address,
    sweepExecuted,
    sweepTxHashes,
    shortfallWei: requirement.shortfallWei,
    requiredPersonaWei: requirement.requiredPersonaWei,
  }
}

export interface BuildPersonaReturnSweepTxParams {
  keyring: DappPersonaKeyring
  personaIndex: number
  observedBalanceWei: bigint
  destinationPoolAddress: string
  nonce: number
  chainId: bigint
  maxFeePerGasWei: bigint
  maxPriorityFeePerGasWei?: bigint
  gasLimit?: bigint
}

export interface PersonaReturnSweepTxResult {
  signedTxHex: string
  txHash: string
  fromPersonaAddress: string
  destinationPoolAddress: string
  sweptValueWei: bigint
  feeWei: bigint
  remainingDustWei: 0n
}

/**
 * Sweeps the entire remaining balance (`observedBalanceWei - gasLimit * maxFeePerGasWei`)
 * from a dApp Persona EOA back into a fresh Frank pool sub-account, leaving zero dust (`0n`).
 */
export async function buildPersonaReturnSweepTx(
  params: BuildPersonaReturnSweepTxParams,
): Promise<PersonaReturnSweepTxResult> {
  const persona = params.keyring.getPersonaByIndex(params.personaIndex)
  if (!persona) {
    throw new Error(`Unknown dApp persona index: ${params.personaIndex}`)
  }
  if (!isAddress(params.destinationPoolAddress)) {
    throw new Error(`Invalid destinationPoolAddress: ${params.destinationPoolAddress}`)
  }
  const normalizedDestination = getAddress(params.destinationPoolAddress)
  if (normalizedDestination.toLowerCase() === persona.address.toLowerCase()) {
    throw new Error('destinationPoolAddress must differ from the source dApp persona address')
  }

  const gasLimit = params.gasLimit ?? 21_000n
  if (gasLimit <= 0n) {
    throw new Error('gasLimit must be positive')
  }
  if (params.maxFeePerGasWei <= 0n) {
    throw new Error('maxFeePerGasWei must be positive')
  }

  const feeWei = gasLimit * params.maxFeePerGasWei
  if (params.observedBalanceWei <= feeWei) {
    throw new Error(
      `Observed balance (${params.observedBalanceWei.toString()} wei) is insufficient to cover return sweep gas fee (${feeWei.toString()} wei)`,
    )
  }

  const sweptValueWei = params.observedBalanceWei - feeWei
  const maxPriorityFeePerGas = params.maxPriorityFeePerGasWei ?? params.maxFeePerGasWei
  const privateKeyHex = params.keyring.getPrivateKeyHex(params.personaIndex)
  const wallet = new Wallet(privateKeyHex)

  const tx = Transaction.from({
    type: 2,
    to: normalizedDestination,
    value: sweptValueWei,
    data: '0x',
    nonce: params.nonce,
    gasLimit,
    maxFeePerGas: params.maxFeePerGasWei,
    maxPriorityFeePerGas,
    chainId: params.chainId,
  })

  const signedTxHex = await wallet.signTransaction(tx)
  const txHash = keccak256(signedTxHex)

  return {
    signedTxHex,
    txHash,
    fromPersonaAddress: persona.address,
    destinationPoolAddress: normalizedDestination,
    sweptValueWei,
    feeWei,
    remainingDustWei: 0n,
  }
}

export class Eip1193ProviderRpcError extends Error {
  readonly code: number
  readonly data?: unknown

  constructor(code: number, message: string, data?: unknown) {
    super(message)
    this.name = 'Eip1193ProviderRpcError'
    this.code = code
    this.data = data
  }
}

export type DappApprovalKind =
  | 'connect'
  | 'personal_sign'
  | 'sign_typed_data'
  | 'send_transaction'
  | 'switch_chain'
  | 'add_chain'

export interface DappCustomChainMetadata {
  chainId: bigint
  chainIdHex: string
  chainName: string
  nativeCurrency: {
    name: string
    symbol: string
    decimals: number
  }
  rpcUrls: string[]
  blockExplorerUrls?: string[]
}

export interface PendingDappApproval {
  id: string
  kind: DappApprovalKind
  origin: string
  method: string
  params: unknown[]
  personaAddress?: string
  chainIdHex: string
  createdAtMs: number
  jitRequirement?: DappJitSweepRequirement
}

export interface Eip1193RequestArguments {
  readonly method: string
  readonly params?: readonly unknown[] | object
}

export interface FrankDappRpcBackend {
  getBalanceWei?: (address: string, chainId: bigint) => Promise<bigint>
  getTransactionCount?: (address: string, chainId: bigint) => Promise<number>
  estimateGas?: (tx: Record<string, unknown>, chainId: bigint) => Promise<bigint>
  getMaxFeePerGasWei?: (chainId: bigint) => Promise<bigint>
  ethCall?: (tx: Record<string, unknown>, blockTag: string, chainId: bigint) => Promise<string>
  getBlockNumber?: (chainId: bigint) => Promise<bigint>
  getTransactionReceipt?: (txHash: string, chainId: bigint) => Promise<unknown>
  broadcastSignedTransaction?: (
    signedTxHex: string,
    chainId: bigint,
    meta: {
      origin: string
      personaAddress: string
      sweepExecuted: boolean
      sweepTxHashes: string[]
      shortfallWei: bigint
    },
  ) => Promise<string>
  sweepFromPool?: (
    shortfallWei: bigint,
    recipientPersonaAddress: string,
    chainId?: bigint,
  ) => Promise<{ sweepTxHashes: string[]; fundedWei: bigint }>
}

export interface FrankDappBridgeRouterOptions {
  keyring: DappPersonaKeyring
  initialChainId?: bigint | number
  /**
   * Dedicated chain ID used for Frank's anti-spam message stamps (completely decoupled
   * from whichever EVM chain a connected dApp is transacting on).
   */
  stampChainId?: bigint | number
  /**
   * Chain IDs where Frank maintains a multi-EOA sub-account/stealth pool eligible for JIT sweeps.
   * Defaults to `[initialChainId]` (and `stampChainId` if provided).
   */
  poolEnabledChainIds?: Iterable<bigint | number>
  supportedChainIds?: Iterable<bigint | number>
  rpcBackend?: FrankDappRpcBackend
  defaultBurnerForNewOrigins?: boolean
  nowMs?: () => number
}

interface InternalPendingApproval {
  record: PendingDappApproval
  onApprove: (options?: { burner?: boolean; personaIndex?: number }) => Promise<unknown>
  onReject: (error: Eip1193ProviderRpcError) => void
}

function parseHexOrDecimalBigInt(raw: unknown, fallback: bigint): bigint {
  if (typeof raw === 'bigint') return raw
  if (typeof raw === 'number' && Number.isSafeInteger(raw) && raw >= 0) {
    return BigInt(raw)
  }
  if (typeof raw === 'string') {
    const trimmed = raw.trim()
    if (!trimmed) return fallback
    return BigInt(trimmed)
  }
  return fallback
}

function normalizeMessageBytes(rawMessage: string): Uint8Array {
  if (/^0x[0-9a-fA-F]*$/.test(rawMessage) && rawMessage.length % 2 === 0) {
    return hexToBytes(rawMessage.slice(2))
  }
  return toUtf8Bytes(rawMessage)
}

/**
 * Origin-verified EIP-1193 JSON-RPC request router and non-blocking inline approval queue (`#1709`).
 *
 * Key Multi-Chain & Stamp-Chain Decoupling Invariants:
 * 1. Frank's messaging stamp chain (`stampChainId`) is completely independent from the dApp chain.
 * 2. Each connected dApp origin tracks its own pinned `chainId` (`originChainIds`) so switching
 *    chains on Uniswap (e.g. Arbitrum `0xa4b1`) never breaks Polymarket (Polygon `0x89`) or Monad (`0x279f`).
 * 3. Supports `wallet_addEthereumChain` (EIP-3085) for dynamic EVM chain registration.
 * 4. Gates JIT sub-account pool sweeps behind `poolEnabledChainIds` so pool sweeps only run on chains
 *    where a sub-account pool actually exists for that chain's gas token.
 */
export class FrankDappBridgeRouter {
  private readonly keyring: DappPersonaKeyring
  private defaultChainId: bigint
  private currentChainId: bigint
  private stampChainId: bigint
  private readonly originChainIds = new Map<string, bigint>()
  private readonly supportedChainIds: Set<bigint>
  private readonly poolEnabledChainIds: Set<bigint>
  private readonly customChains = new Map<bigint, DappCustomChainMetadata>()
  private readonly rpcBackend: FrankDappRpcBackend
  private readonly defaultBurnerForNewOrigins: boolean
  private readonly nowMs: () => number
  private readonly pendingApprovals = new Map<string, InternalPendingApproval>()
  private approvalSeq = 0

  constructor(options: FrankDappBridgeRouterOptions) {
    this.keyring = options.keyring
    this.defaultChainId = BigInt(options.initialChainId ?? 10143)
    this.currentChainId = this.defaultChainId
    this.stampChainId = BigInt(options.stampChainId ?? this.defaultChainId)
    this.supportedChainIds = new Set<bigint>([
      this.defaultChainId,
      this.stampChainId,
      1n,        // Ethereum Mainnet
      10n,       // Optimism
      56n,       // BNB Smart Chain
      97n,       // BNB Testnet
      137n,      // Polygon PoS
      999n,      // HyperEVM
      8453n,     // Base
      10143n,    // Monad Testnet
      31337n,    // Hardhat / Anvil
      42161n,    // Arbitrum One
      80002n,    // Polygon Amoy
      84532n,    // Base Sepolia
      421614n,   // Arbitrum Sepolia
      11155111n, // Ethereum Sepolia
    ])
    if (options.supportedChainIds) {
      for (const id of options.supportedChainIds) {
        this.supportedChainIds.add(BigInt(id))
      }
    }
    this.poolEnabledChainIds = new Set<bigint>(
      options.poolEnabledChainIds
        ? Array.from(options.poolEnabledChainIds, (id) => BigInt(id))
        : [this.defaultChainId],
    )
    this.rpcBackend = options.rpcBackend ?? {}
    this.defaultBurnerForNewOrigins = options.defaultBurnerForNewOrigins ?? false
    this.nowMs = options.nowMs ?? (() => Date.now())
  }

  getStampChainId(): bigint {
    return this.stampChainId
  }

  getStampChainIdHex(): string {
    return `0x${this.stampChainId.toString(16)}`
  }

  setStampChainId(chainId: bigint | number): void {
    const id = BigInt(chainId)
    this.stampChainId = id
    this.supportedChainIds.add(id)
  }

  isPoolSweepEnabledForChain(chainId: bigint | number): boolean {
    return this.poolEnabledChainIds.has(BigInt(chainId))
  }

  getChainIdForOrigin(rawOrigin?: string): bigint {
    if (rawOrigin) {
      const normalized = normalizeDappOrigin(rawOrigin)
      const pinned = this.originChainIds.get(normalized)
      if (pinned !== undefined) {
        return pinned
      }
    }
    return this.defaultChainId
  }

  getChainIdHexForOrigin(rawOrigin?: string): string {
    return `0x${this.getChainIdForOrigin(rawOrigin).toString(16)}`
  }

  setChainIdForOrigin(rawOrigin: string, chainId: bigint | number): void {
    const normalized = normalizeDappOrigin(rawOrigin)
    const id = BigInt(chainId)
    if (!this.supportedChainIds.has(id)) {
      throw new Error(`Unsupported chainId: ${id.toString()}`)
    }
    this.originChainIds.set(normalized, id)
    this.currentChainId = id
  }

  getCustomChain(chainId: bigint | number): DappCustomChainMetadata | null {
    return this.customChains.get(BigInt(chainId)) ?? null
  }

  getChainIdHex(): string {
    return `0x${this.currentChainId.toString(16)}`
  }

  getChainId(): bigint {
    return this.currentChainId
  }

  listPendingApprovals(): PendingDappApproval[] {
    return Array.from(this.pendingApprovals.values()).map((entry) => ({
      ...entry.record,
    }))
  }

  async approveRequest(
    approvalId: string,
    options?: { burner?: boolean; personaIndex?: number },
  ): Promise<unknown> {
    const entry = this.pendingApprovals.get(approvalId)
    if (!entry) {
      throw new Error(`Unknown or already resolved approval ID: ${approvalId}`)
    }
    this.pendingApprovals.delete(approvalId)
    return await entry.onApprove(options)
  }

  rejectRequest(approvalId: string, message = 'User Rejected Request'): void {
    const entry = this.pendingApprovals.get(approvalId)
    if (!entry) {
      throw new Error(`Unknown or already resolved approval ID: ${approvalId}`)
    }
    this.pendingApprovals.delete(approvalId)
    entry.onReject(
      new Eip1193ProviderRpcError(
        EIP1193_ERROR_CODES.USER_REJECTED_REQUEST,
        message,
      ),
    )
  }

  private enqueueApproval<T>(
    meta: {
      kind: DappApprovalKind
      origin: string
      method: string
      params: unknown[]
      personaAddress?: string
      chainIdHex?: string
      jitRequirement?: DappJitSweepRequirement
    },
    handler: (options?: { burner?: boolean; personaIndex?: number }) => Promise<T>,
  ): Promise<T> {
    this.approvalSeq += 1
    const id = `dapp-approval-${this.approvalSeq}-${bytesToHex(randomBytes(4))}`
    const record: PendingDappApproval = {
      id,
      kind: meta.kind,
      origin: meta.origin,
      method: meta.method,
      params: meta.params,
      personaAddress: meta.personaAddress,
      chainIdHex: meta.chainIdHex ?? this.getChainIdHexForOrigin(meta.origin),
      createdAtMs: this.nowMs(),
      ...(meta.jitRequirement ? { jitRequirement: meta.jitRequirement } : {}),
    }

    return new Promise<T>((resolve, reject) => {
      this.pendingApprovals.set(id, {
        record,
        onApprove: async (options) => {
          try {
            const result = await handler(options)
            resolve(result)
            return result
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

  async handleRequest(
    rawOrigin: string,
    request: Eip1193RequestArguments,
  ): Promise<unknown> {
    const origin = normalizeDappOrigin(rawOrigin)
    if (!request || typeof request.method !== 'string') {
      throw new Eip1193ProviderRpcError(
        EIP1193_ERROR_CODES.INVALID_PARAMS,
        'Invalid EIP-1193 request object',
      )
    }

    const paramsArray: unknown[] = Array.isArray(request.params)
      ? [...request.params]
      : request.params && typeof request.params === 'object'
        ? [request.params]
        : []

    const originChainId = this.getChainIdForOrigin(origin)

    switch (request.method) {
      case 'eth_chainId':
        return `0x${originChainId.toString(16)}`

      case 'net_version':
        return originChainId.toString(10)

      case 'eth_accounts': {
        const connected = this.keyring.getConnectedPersonaForOrigin(origin)
        return connected ? [connected.address] : []
      }

      case 'eth_requestAccounts': {
        const existing = this.keyring.getConnectedPersonaForOrigin(origin)
        if (existing) {
          if (!this.originChainIds.has(origin)) {
            this.originChainIds.set(origin, this.defaultChainId)
          }
          return [existing.address]
        }
        return await this.enqueueApproval(
          {
            kind: 'connect',
            origin,
            method: request.method,
            params: paramsArray,
          },
          async (approveOpts) => {
            const persona = this.keyring.connectOrigin(origin, {
              burner: approveOpts?.burner ?? this.defaultBurnerForNewOrigins,
              personaIndex: approveOpts?.personaIndex,
            })
            if (!this.originChainIds.has(origin)) {
              this.originChainIds.set(origin, this.defaultChainId)
            }
            return [persona.address]
          },
        )
      }

      case 'wallet_getPermissions': {
        const connected = this.keyring.getConnectedPersonaForOrigin(origin)
        if (!connected) return []
        return [
          {
            parentCapability: 'eth_accounts',
            invoker: origin,
            caveats: [
              {
                type: 'restrictReturnedAccounts',
                value: [connected.address],
              },
            ],
          },
        ]
      }

      case 'wallet_requestPermissions': {
        return await this.enqueueApproval(
          {
            kind: 'connect',
            origin,
            method: request.method,
            params: paramsArray,
          },
          async (approveOpts) => {
            const persona = this.keyring.connectOrigin(origin, {
              burner: approveOpts?.burner ?? this.defaultBurnerForNewOrigins,
              personaIndex: approveOpts?.personaIndex,
            })
            if (!this.originChainIds.has(origin)) {
              this.originChainIds.set(origin, this.defaultChainId)
            }
            return [
              {
                parentCapability: 'eth_accounts',
                invoker: origin,
                caveats: [
                  {
                    type: 'restrictReturnedAccounts',
                    value: [persona.address],
                  },
                ],
              },
            ]
          },
        )
      }

      case 'wallet_revokePermissions': {
        this.keyring.disconnectOrigin(origin)
        this.originChainIds.delete(origin)
        return null
      }

      case 'wallet_switchEthereumChain': {
        const arg = paramsArray[0] as { chainId?: string } | undefined
        if (!arg || typeof arg.chainId !== 'string' || !/^0x[0-9a-fA-F]+$/.test(arg.chainId)) {
          throw new Eip1193ProviderRpcError(
            EIP1193_ERROR_CODES.INVALID_PARAMS,
            'wallet_switchEthereumChain requires a hex chainId parameter',
          )
        }
        const targetChainId = BigInt(arg.chainId)
        if (!this.supportedChainIds.has(targetChainId)) {
          throw new Eip1193ProviderRpcError(
            EIP1193_ERROR_CODES.UNRECOGNIZED_CHAIN_ID,
            `Unrecognized or unsupported chainId: ${arg.chainId}. Call wallet_addEthereumChain first.`,
          )
        }
        if (targetChainId === originChainId) {
          this.originChainIds.set(origin, targetChainId)
          return null
        }
        return await this.enqueueApproval(
          {
            kind: 'switch_chain',
            origin,
            method: request.method,
            params: paramsArray,
            chainIdHex: `0x${targetChainId.toString(16)}`,
          },
          async () => {
            this.originChainIds.set(origin, targetChainId)
            this.currentChainId = targetChainId
            return null
          },
        )
      }

      case 'wallet_addEthereumChain': {
        const arg = paramsArray[0] as {
          chainId?: string
          chainName?: string
          nativeCurrency?: { name?: string; symbol?: string; decimals?: number }
          rpcUrls?: string[]
          blockExplorerUrls?: string[]
        } | undefined
        if (
          !arg ||
          typeof arg.chainId !== 'string' ||
          !/^0x[0-9a-fA-F]+$/.test(arg.chainId) ||
          !arg.chainName ||
          !Array.isArray(arg.rpcUrls) ||
          arg.rpcUrls.length === 0
        ) {
          throw new Eip1193ProviderRpcError(
            EIP1193_ERROR_CODES.INVALID_PARAMS,
            'wallet_addEthereumChain requires chainId, chainName, and rpcUrls',
          )
        }
        const targetChainId = BigInt(arg.chainId)
        const chainIdHex = `0x${targetChainId.toString(16)}`
        return await this.enqueueApproval(
          {
            kind: 'add_chain',
            origin,
            method: request.method,
            params: paramsArray,
            chainIdHex,
          },
          async () => {
            this.supportedChainIds.add(targetChainId)
            this.customChains.set(targetChainId, {
              chainId: targetChainId,
              chainIdHex,
              chainName: String(arg.chainName),
              nativeCurrency: {
                name: String(arg.nativeCurrency?.name ?? arg.chainName),
                symbol: String(arg.nativeCurrency?.symbol ?? 'ETH'),
                decimals: Number(arg.nativeCurrency?.decimals ?? 18),
              },
              rpcUrls: arg.rpcUrls!.map(String),
              blockExplorerUrls: Array.isArray(arg.blockExplorerUrls)
                ? arg.blockExplorerUrls.map(String)
                : undefined,
            })
            this.originChainIds.set(origin, targetChainId)
            this.currentChainId = targetChainId
            return null
          },
        )
      }

      case 'eth_blockNumber': {
        const blockNum = this.rpcBackend.getBlockNumber
          ? await this.rpcBackend.getBlockNumber(originChainId)
          : 0n
        return `0x${blockNum.toString(16)}`
      }

      case 'eth_getBalance': {
        const address = String(paramsArray[0] ?? '')
        if (!isAddress(address)) {
          throw new Eip1193ProviderRpcError(
            EIP1193_ERROR_CODES.INVALID_PARAMS,
            `Invalid address for eth_getBalance: ${address}`,
          )
        }
        const balanceWei = this.rpcBackend.getBalanceWei
          ? await this.rpcBackend.getBalanceWei(getAddress(address), originChainId)
          : 0n
        return `0x${balanceWei.toString(16)}`
      }

      case 'eth_getTransactionCount': {
        const address = String(paramsArray[0] ?? '')
        if (!isAddress(address)) {
          throw new Eip1193ProviderRpcError(
            EIP1193_ERROR_CODES.INVALID_PARAMS,
            `Invalid address for eth_getTransactionCount: ${address}`,
          )
        }
        const nonce = this.rpcBackend.getTransactionCount
          ? await this.rpcBackend.getTransactionCount(
              getAddress(address),
              originChainId,
            )
          : 0
        return `0x${nonce.toString(16)}`
      }

      case 'eth_estimateGas': {
        const txObj = (paramsArray[0] ?? {}) as Record<string, unknown>
        const gas = this.rpcBackend.estimateGas
          ? await this.rpcBackend.estimateGas(txObj, originChainId)
          : 21_000n
        return `0x${gas.toString(16)}`
      }

      case 'eth_call': {
        const txObj = (paramsArray[0] ?? {}) as Record<string, unknown>
        const blockTag = typeof paramsArray[1] === 'string' ? paramsArray[1] : 'latest'
        if (!this.rpcBackend.ethCall) {
          return '0x'
        }
        return await this.rpcBackend.ethCall(txObj, blockTag, originChainId)
      }

      case 'eth_getTransactionReceipt': {
        const txHash = String(paramsArray[0] ?? '')
        if (!this.rpcBackend.getTransactionReceipt) {
          return null
        }
        return await this.rpcBackend.getTransactionReceipt(txHash, originChainId)
      }

      case 'personal_sign': {
        const connected = this.keyring.getConnectedPersonaForOrigin(origin)
        if (!connected) {
          throw new Eip1193ProviderRpcError(
            EIP1193_ERROR_CODES.UNAUTHORIZED,
            `Origin ${origin} is not connected to a dApp persona`,
          )
        }

        // personal_sign params are [message, address] (or occasionally [address, message])
        const first = String(paramsArray[0] ?? '')
        const second = String(paramsArray[1] ?? '')
        let rawMessage: string
        let requestedAddress: string
        if (isAddress(first) && !isAddress(second)) {
          requestedAddress = first
          rawMessage = second
        } else {
          rawMessage = first
          requestedAddress = second || connected.address
        }

        if (
          !isAddress(requestedAddress) ||
          getAddress(requestedAddress).toLowerCase() !== connected.address.toLowerCase()
        ) {
          throw new Eip1193ProviderRpcError(
            EIP1193_ERROR_CODES.UNAUTHORIZED,
            `Requested signer ${requestedAddress} is not authorized for origin ${origin}`,
          )
        }

        return await this.enqueueApproval(
          {
            kind: 'personal_sign',
            origin,
            method: request.method,
            params: paramsArray,
            personaAddress: connected.address,
          },
          async () => {
            const privKey = this.keyring.getPrivateKeyHex(connected.index)
            const wallet = new Wallet(privKey)
            return await wallet.signMessage(normalizeMessageBytes(rawMessage))
          },
        )
      }

      case 'eth_signTypedData_v4': {
        const connected = this.keyring.getConnectedPersonaForOrigin(origin)
        if (!connected) {
          throw new Eip1193ProviderRpcError(
            EIP1193_ERROR_CODES.UNAUTHORIZED,
            `Origin ${origin} is not connected to a dApp persona`,
          )
        }
        const signerAddress = String(paramsArray[0] ?? '')
        const rawTypedData = paramsArray[1]
        if (
          !isAddress(signerAddress) ||
          getAddress(signerAddress).toLowerCase() !== connected.address.toLowerCase()
        ) {
          throw new Eip1193ProviderRpcError(
            EIP1193_ERROR_CODES.UNAUTHORIZED,
            `Requested signer ${signerAddress} is not authorized for origin ${origin}`,
          )
        }

        const parsedTypedData =
          typeof rawTypedData === 'string'
            ? (JSON.parse(rawTypedData) as {
                domain?: Record<string, unknown>
                types?: Record<string, Array<{ name: string; type: string }>>
                primaryType?: string
                message?: Record<string, unknown>
              })
            : (rawTypedData as {
                domain?: Record<string, unknown>
                types?: Record<string, Array<{ name: string; type: string }>>
                primaryType?: string
                message?: Record<string, unknown>
              })

        if (
          !parsedTypedData ||
          typeof parsedTypedData !== 'object' ||
          !parsedTypedData.types ||
          !parsedTypedData.message
        ) {
          throw new Eip1193ProviderRpcError(
            EIP1193_ERROR_CODES.INVALID_PARAMS,
            'Invalid EIP-712 typed data payload',
          )
        }

        const domainChainId = parsedTypedData.domain?.chainId
        if (
          domainChainId !== undefined &&
          BigInt(String(domainChainId)) !== originChainId
        ) {
          throw new Eip1193ProviderRpcError(
            EIP1193_ERROR_CODES.INVALID_PARAMS,
            `EIP-712 domain chainId (${String(domainChainId)}) mismatches active chainId (${originChainId.toString()})`,
          )
        }

        return await this.enqueueApproval(
          {
            kind: 'sign_typed_data',
            origin,
            method: request.method,
            params: paramsArray,
            personaAddress: connected.address,
          },
          async () => {
            const typesCopy = { ...parsedTypedData.types }
            delete typesCopy.EIP712Domain
            const privKey = this.keyring.getPrivateKeyHex(connected.index)
            const wallet = new Wallet(privKey)
            // Validate encoding with TypedDataEncoder first
            TypedDataEncoder.hash(
              parsedTypedData.domain ?? {},
              typesCopy,
              parsedTypedData.message ?? {},
            )
            return await wallet.signTypedData(
              parsedTypedData.domain ?? {},
              typesCopy,
              parsedTypedData.message ?? {},
            )
          },
        )
      }

      case 'eth_sendTransaction': {
        const connected = this.keyring.getConnectedPersonaForOrigin(origin)
        if (!connected) {
          throw new Eip1193ProviderRpcError(
            EIP1193_ERROR_CODES.UNAUTHORIZED,
            `Origin ${origin} is not connected to a dApp persona`,
          )
        }

        const txParam = (paramsArray[0] ?? {}) as Record<string, unknown>
        const fromField = txParam.from ? String(txParam.from) : connected.address
        if (
          !isAddress(fromField) ||
          getAddress(fromField).toLowerCase() !== connected.address.toLowerCase()
        ) {
          throw new Eip1193ProviderRpcError(
            EIP1193_ERROR_CODES.UNAUTHORIZED,
            `Transaction 'from' (${fromField}) does not match connected persona (${connected.address})`,
          )
        }
        const toField = String(txParam.to ?? '')
        if (!isAddress(toField)) {
          throw new Eip1193ProviderRpcError(
            EIP1193_ERROR_CODES.INVALID_PARAMS,
            `Invalid transaction 'to' address: ${toField}`,
          )
        }

        const txValueWei = parseHexOrDecimalBigInt(txParam.value, 0n)
        const initialGasLimit = txParam.gas
          ? parseHexOrDecimalBigInt(txParam.gas, 21_000n)
          : txParam.gasLimit
            ? parseHexOrDecimalBigInt(txParam.gasLimit, 21_000n)
            : 21_000n

        const initialMaxFeePerGasWei = txParam.maxFeePerGas
          ? parseHexOrDecimalBigInt(txParam.maxFeePerGas, 1_000_000_000n)
          : txParam.gasPrice
            ? parseHexOrDecimalBigInt(txParam.gasPrice, 1_000_000_000n)
            : 1_000_000_000n

        const maxPriorityFeePerGasWei = txParam.maxPriorityFeePerGas
          ? parseHexOrDecimalBigInt(txParam.maxPriorityFeePerGas, initialMaxFeePerGasWei)
          : undefined

        const initialJitRequirement = calculateDappJitSweepRequirement({
          personaBalanceWei: 0n,
          txValueWei,
          gasLimit: initialGasLimit,
          maxFeePerGasWei: initialMaxFeePerGasWei,
        })

        const prepPromise = (async () => {
          const gasLimit = txParam.gas
            ? parseHexOrDecimalBigInt(txParam.gas, 21_000n)
            : txParam.gasLimit
              ? parseHexOrDecimalBigInt(txParam.gasLimit, 21_000n)
              : this.rpcBackend.estimateGas
                ? await this.rpcBackend.estimateGas(txParam, originChainId)
                : 21_000n

          const maxFeePerGasWei = txParam.maxFeePerGas
            ? parseHexOrDecimalBigInt(txParam.maxFeePerGas, 1_000_000_000n)
            : txParam.gasPrice
              ? parseHexOrDecimalBigInt(txParam.gasPrice, 1_000_000_000n)
              : this.rpcBackend.getMaxFeePerGasWei
                ? await this.rpcBackend.getMaxFeePerGasWei(originChainId)
                : 1_000_000_000n

          const personaBalanceWei = this.rpcBackend.getBalanceWei
            ? await this.rpcBackend.getBalanceWei(connected.address, originChainId)
            : 0n

          const jitRequirement = calculateDappJitSweepRequirement({
            personaBalanceWei,
            txValueWei,
            gasLimit,
            maxFeePerGasWei,
          })

          return { gasLimit, maxFeePerGasWei, personaBalanceWei, jitRequirement }
        })()

        const approvalPromise = this.enqueueApproval(
          {
            kind: 'send_transaction',
            origin,
            method: request.method,
            params: paramsArray,
            personaAddress: connected.address,
            jitRequirement: initialJitRequirement,
          },
          async () => {
            const { gasLimit, maxFeePerGasWei, personaBalanceWei } = await prepPromise
            const nonce =
              txParam.nonce !== undefined
                ? Number(parseHexOrDecimalBigInt(txParam.nonce, 0n))
                : this.rpcBackend.getTransactionCount
                  ? await this.rpcBackend.getTransactionCount(
                      connected.address,
                      originChainId,
                    )
                  : 0

            const currentBalanceWei = this.rpcBackend.getBalanceWei
              ? await this.rpcBackend.getBalanceWei(
                  connected.address,
                  originChainId,
                )
              : personaBalanceWei

            const chainScopedSweepFromPool =
              this.rpcBackend.sweepFromPool && this.isPoolSweepEnabledForChain(originChainId)
                ? (shortfallWei: bigint, recipientAddr: string) =>
                    this.rpcBackend.sweepFromPool!(shortfallWei, recipientAddr, originChainId)
                : undefined

            const signed = await executeDappJitSweepAndSignTx({
              keyring: this.keyring,
              personaIndex: connected.index,
              personaBalanceWei: currentBalanceWei,
              txRequest: {
                to: getAddress(toField),
                value: txValueWei,
                data: typeof txParam.data === 'string' ? txParam.data : '0x',
                nonce,
                gasLimit,
                maxFeePerGasWei,
                maxPriorityFeePerGasWei,
                chainId: originChainId,
              },
              sweepFromPool: chainScopedSweepFromPool,
            })

            if (this.rpcBackend.broadcastSignedTransaction) {
              return await this.rpcBackend.broadcastSignedTransaction(
                signed.signedTxHex,
                originChainId,
                {
                  origin,
                  personaAddress: signed.personaAddress,
                  sweepExecuted: signed.sweepExecuted,
                  sweepTxHashes: signed.sweepTxHashes,
                  shortfallWei: signed.shortfallWei,
                },
              )
            }
            return signed.txHash
          },
        )

        void prepPromise.then(({ jitRequirement }) => {
          for (const entry of this.pendingApprovals.values()) {
            if (
              entry.record.origin === origin &&
              entry.record.kind === 'send_transaction'
            ) {
              entry.record.jitRequirement = jitRequirement
            }
          }
        })

        return await approvalPromise
      }

      default:
        throw new Eip1193ProviderRpcError(
          EIP1193_ERROR_CODES.UNSUPPORTED_METHOD,
          `Unsupported EIP-1193 method: ${request.method}`,
        )
    }
  }
}

export interface ExtensionOriginSyncHandshakeParams {
  pwaOrigin: string
  extensionOrigin: string
  pwaDeviceId?: string
  extensionDeviceId?: string
  nowMs?: number
  ttlMs?: number
}

export interface ExtensionOriginSyncHandshake {
  sessionId: string
  qrUri: string
  qrPayload: DevicePairingQrPayload
  pwaOrigin: string
  extensionOrigin: string
  sasDigits: string
  sasWords: [string, string, string, string]
  transcriptHashHex: string
  encryptFromPwa: (bundle: DeviceSyncBundle) => EncryptedDeviceSyncBundle
  decryptInExtension: (encrypted: EncryptedDeviceSyncBundle) => DeviceSyncBundle
  encryptFromExtension: (bundle: DeviceSyncBundle) => EncryptedDeviceSyncBundle
  decryptInPwa: (encrypted: EncryptedDeviceSyncBundle) => DeviceSyncBundle
  zeroize: () => void
}

function deriveOriginBindingFingerprintSha256(
  normalizedOrigin: string,
  ephemeralPubKeyHex: string,
): string {
  const digest = sha256(
    utf8ToBytes(`frank-extension-origin-fp-v1|${normalizedOrigin}|${ephemeralPubKeyHex.toLowerCase()}`),
  )
  const hex = bytesToHex(digest).toUpperCase()
  const pairs: string[] = []
  for (let i = 0; i < hex.length; i += 2) {
    pairs.push(hex.slice(i, i + 2))
  }
  return pairs.join(':')
}

/**
 * Establishes an origin-bound E2EE `DeviceSyncBundle` bridge between the standalone PWA
 * (`https://signet.mx` or `http://localhost`) and the Frank Browser Extension
 * (`chrome-extension://`, `moz-extension://`, or `safari-web-extension://`) using
 * `#1710` / `#1707` ephemeral secp256k1 ECDH + HKDF-SHA256 + ChaCha20-Poly1305 + SAS verification.
 */
export function createExtensionOriginSyncHandshake(
  params: ExtensionOriginSyncHandshakeParams,
): ExtensionOriginSyncHandshake {
  const normalizedPwaOrigin = normalizeDappOrigin(params.pwaOrigin, {
    allowExtensionOrigins: false,
    allowLocalhostHttp: true,
  })
  const normalizedExtensionOrigin = normalizeDappOrigin(params.extensionOrigin, {
    allowExtensionOrigins: true,
    allowLocalhostHttp: false,
  })

  if (
    !normalizedExtensionOrigin.startsWith('chrome-extension://') &&
    !normalizedExtensionOrigin.startsWith('moz-extension://') &&
    !normalizedExtensionOrigin.startsWith('safari-web-extension://')
  ) {
    throw new Error(
      `Invalid extensionOrigin (${params.extensionOrigin}): expected chrome-extension://, moz-extension://, or safari-web-extension://`,
    )
  }

  const pwaSeedFp = deriveOriginBindingFingerprintSha256(normalizedPwaOrigin, 'initiator')
  const { session, qrUri }: { session: DevicePairingSession; qrUri: string } =
    createDevicePairingSession({
      initiatorDeviceId: params.pwaDeviceId ?? 'frank-pwa',
      dtlsFingerprintSha256: pwaSeedFp,
      nowMs: params.nowMs,
      ttlMs: params.ttlMs,
    })

  const extensionPrivKey = secp256k1.utils.randomPrivateKey()
  const extensionPubKeyHex = bytesToHex(
    secp256k1.getPublicKey(extensionPrivKey, true),
  ).toLowerCase()
  const extensionFp = deriveOriginBindingFingerprintSha256(
    normalizedExtensionOrigin,
    extensionPubKeyHex,
  )

  const pwaKeys: DerivedDevicePairingKeys = deriveDevicePairingKeys({
    localEphemeralPrivKey: session.ephemeralPrivKey,
    remoteEphemeralPubKeyHex: extensionPubKeyHex,
    sessionId: session.sessionId,
    initiatorDtlsFingerprintSha256: session.dtlsFingerprintSha256,
    responderDtlsFingerprintSha256: extensionFp,
  })

  const extensionKeys: DerivedDevicePairingKeys = deriveDevicePairingKeys({
    localEphemeralPrivKey: extensionPrivKey,
    remoteEphemeralPubKeyHex: session.ephemeralPubKeyHex,
    sessionId: session.sessionId,
    initiatorDtlsFingerprintSha256: session.dtlsFingerprintSha256,
    responderDtlsFingerprintSha256: extensionFp,
  })

  return {
    sessionId: session.sessionId,
    qrUri,
    qrPayload: session.payload,
    pwaOrigin: normalizedPwaOrigin,
    extensionOrigin: normalizedExtensionOrigin,
    sasDigits: pwaKeys.sasDigits,
    sasWords: pwaKeys.sasWords,
    transcriptHashHex: pwaKeys.transcriptHashHex,
    encryptFromPwa: (bundle: DeviceSyncBundle) =>
      encryptDeviceSyncBundle(bundle, pwaKeys.encryptionKey, session.sessionId),
    decryptInExtension: (encrypted: EncryptedDeviceSyncBundle) =>
      decryptDeviceSyncBundle(encrypted, extensionKeys.encryptionKey, session.sessionId),
    encryptFromExtension: (bundle: DeviceSyncBundle) =>
      encryptDeviceSyncBundle(bundle, extensionKeys.encryptionKey, session.sessionId),
    decryptInPwa: (encrypted: EncryptedDeviceSyncBundle) =>
      decryptDeviceSyncBundle(encrypted, pwaKeys.encryptionKey, session.sessionId),
    zeroize: () => {
      zeroizePairingKeys(session)
      zeroizePairingKeys(extensionPrivKey)
      zeroizePairingKeys(pwaKeys)
      zeroizePairingKeys(extensionKeys)
    },
  }
}
