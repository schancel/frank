import { expand, extract } from '@noble/hashes/hkdf.js'
import { sha256 } from '@noble/hashes/sha256.js'

export const RECOVERY_FORMAT_ID = 'codex32-master-v1' as const
export const RECOVERY_FORMAT_CODE = 1 as const
export const DERIVATION_REGISTRY_ID = 'frank-domain-roots-v1' as const
export const DERIVATION_REGISTRY_CODE = 1 as const
export const DERIVATION_ALGORITHM_ID = 'hkdf-sha256-rfc5869' as const

const ROOT_LENGTH = 32
const OUTPUT_LENGTH = 32
const EXTRACT_SALT = ascii('frank/domain-root-registry/v1')

const registry = Object.freeze({
  'ecash-bch-wallet': Object.freeze({
    code: 1,
    label: 'frank/domain-root/v1/ecash-bch-wallet',
    interpretation: 'bip32-secp256k1-master-seed',
  }),
  'evm-wallet': Object.freeze({
    code: 2,
    label: 'frank/domain-root/v1/evm-wallet',
    interpretation: 'bip32-secp256k1-master-seed',
  }),
  'solana-wallet': Object.freeze({
    code: 3,
    label: 'frank/domain-root/v1/solana-wallet',
    interpretation: 'ed25519-keypair-seed',
  }),
  'messaging-encryption': Object.freeze({
    code: 4,
    label: 'frank/domain-root/v1/messaging-encryption',
    interpretation: 'bip32-secp256k1-master-seed',
  }),
  'identity-authentication': Object.freeze({
    code: 5,
    label: 'frank/domain-root/v1/identity-authentication',
    interpretation: 'bip32-secp256k1-master-seed',
  }),
} as const)

export type DomainPurpose = keyof typeof registry

export type DomainInterpretation =
  (typeof registry)[DomainPurpose]['interpretation']

export interface DomainRegistryEntry<Purpose extends DomainPurpose> {
  readonly purpose: Purpose
  readonly code: (typeof registry)[Purpose]['code']
  readonly label: (typeof registry)[Purpose]['label']
  readonly outputLength: typeof OUTPUT_LENGTH
  readonly interpretation: (typeof registry)[Purpose]['interpretation']
}

export interface DomainRoot<Purpose extends DomainPurpose = DomainPurpose> {
  readonly registry: typeof DERIVATION_REGISTRY_ID
  readonly purpose: Purpose
  readonly bytes: Uint8Array
}

export const DOMAIN_PURPOSES = Object.freeze(
  Object.keys(registry) as DomainPurpose[],
)

export function registryEntry<Purpose extends DomainPurpose>(
  purpose: Purpose,
): DomainRegistryEntry<Purpose> {
  if (!Object.prototype.hasOwnProperty.call(registry, purpose)) {
    throw new Error('Unknown domain-root purpose')
  }
  const entry = registry[purpose]
  return Object.freeze({
    purpose,
    code: entry.code,
    label: entry.label,
    outputLength: OUTPUT_LENGTH,
    interpretation: entry.interpretation,
  }) as DomainRegistryEntry<Purpose>
}

export function deriveDomainRoot<Purpose extends DomainPurpose>(
  accountRoot: Uint8Array,
  purpose: Purpose,
): DomainRoot<Purpose> {
  const root = snapshotRoot(accountRoot)
  let prk: Uint8Array | undefined
  try {
    const entry = registryEntry(purpose)
    prk = extract(sha256, root, EXTRACT_SALT)
    const bytes = expand(sha256, prk, derivationInfo(entry), OUTPUT_LENGTH)
    return Object.freeze({
      registry: DERIVATION_REGISTRY_ID,
      purpose,
      bytes,
    })
  } finally {
    root.fill(0)
    prk?.fill(0)
  }
}

function derivationInfo(entry: DomainRegistryEntry<DomainPurpose>): Uint8Array {
  const registryId = ascii(DERIVATION_REGISTRY_ID)
  const label = ascii(entry.label)
  return concatenate([
    u16be(registryId.length),
    registryId,
    u16be(entry.code),
    u16be(label.length),
    label,
    u16be(entry.outputLength),
  ])
}

function snapshotRoot(value: unknown): Uint8Array {
  if (!(value instanceof Uint8Array) || value.length !== ROOT_LENGTH) {
    throw new Error('Frank account root must contain exactly 32 bytes')
  }
  return Uint8Array.from(value)
}

function ascii(value: string): Uint8Array {
  const bytes = new Uint8Array(value.length)
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (code > 0x7f) throw new Error('Registry constants must be ASCII')
    bytes[index] = code
  }
  return bytes
}

function u16be(value: number): Uint8Array {
  if (!Number.isSafeInteger(value) || value < 0 || value > 0xffff) {
    throw new Error('Registry field does not fit u16')
  }
  return Uint8Array.of(value >>> 8, value & 0xff)
}

function concatenate(parts: readonly Uint8Array[]): Uint8Array {
  const length = parts.reduce((total, part) => total + part.length, 0)
  const output = new Uint8Array(length)
  let offset = 0
  for (const part of parts) {
    output.set(part, offset)
    offset += part.length
  }
  return output
}
