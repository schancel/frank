import { sha256 } from '@noble/hashes/sha256.js'
import {
  GF32_ALPHABET,
  bytesToGf32Symbols,
  gf32SymbolsToBytes,
  createLongBchChecksum,
  verifyLongBchChecksum,
  splitGf32Symbols,
  createMasterPayload,
  interpolateGf32Symbols,
  type Codex32Result,
} from '@frank/codex32'
import { AccountRecoveryError } from './errors.js'
import { snapshotBytes } from './public-metadata.js'

export type RecoverySecretFormat = 'root' | 'historical'
export interface FrankRecoveryShare {
  readonly format: RecoverySecretFormat
  readonly byteLength: 32 | 64
  readonly threshold: number
  readonly identifier: string
  readonly index: string
  readonly commonMetadata: Uint8Array
  readonly group: string
  readonly payload: Uint8Array
  readonly seed: null
}
const PREFIX = 'fr'
const VERSION = 1
const DOMAIN = ascii('frank/recovery-share/v1\0')
const INDICES = Array.from(GF32_ALPHABET).filter(index => index !== 's')
function ascii(text: string): Uint8Array {
  return Uint8Array.from(text, character => character.charCodeAt(0))
}
function context(format: RecoverySecretFormat): Uint8Array {
  return ascii(format === 'root' ? 'frank-root-v1\0' : 'frank-bip39-bip32-v1\0')
}
function validation(
  secret: Uint8Array,
  common: Uint8Array,
  format: RecoverySecretFormat,
): Uint8Array {
  const tag = context(format)
  const preimage = new Uint8Array(
    DOMAIN.length + common.length + tag.length + secret.length,
  )
  try {
    preimage.set(DOMAIN)
    preimage.set(common, DOMAIN.length)
    preimage.set(tag, DOMAIN.length + common.length)
    preimage.set(secret, DOMAIN.length + common.length + tag.length)
    return sha256(preimage)
  } finally {
    preimage.fill(0)
  }
}

/** The sole new backup writer: both formats share the exact encoding/splitting pipeline. */
export function exportRecoveryShares(input: {
  readonly format: RecoverySecretFormat
  readonly secret: Uint8Array
  readonly threshold: number
  readonly shareCount: number
  readonly randomBytes: (length: number) => Uint8Array
  /** Signup can supply its already generated public set identifier. */
  readonly identifier?: string
  readonly indices?: readonly string[]
}): readonly string[] {
  const { format, threshold, shareCount, randomBytes } = input
  if (format !== 'root' && format !== 'historical')
    throw new AccountRecoveryError('bad-format')
  const length = format === 'root' ? 32 : 64
  const secret = snapshotBytes(input.secret, length, 'bad-format')
  let digest: Uint8Array | undefined, symbols: Uint8Array | undefined
  const payload = new Uint8Array(length + 32)
  let rows: readonly Uint8Array[] = []
  try {
    if (
      !Number.isInteger(threshold) ||
      threshold < 1 ||
      threshold > 9 ||
      !Number.isInteger(shareCount) ||
      shareCount < threshold ||
      shareCount > 31 ||
      (threshold === 1 && shareCount !== 1)
    )
      throw new AccountRecoveryError('invalid-threshold')
    let identifier = input.identifier
    if (identifier === undefined) {
      let random: Uint8Array
      try {
        random = snapshotBytes(randomBytes(4), 4, 'rng-failed')
      } catch {
        throw new AccountRecoveryError('rng-failed')
      }
      try {
        identifier = Array.from(random, byte => GF32_ALPHABET[byte & 31]).join(
          '',
        )
      } finally {
        random.fill(0)
      }
    }
    if (
      typeof identifier !== 'string' ||
      identifier.length !== 4 ||
      Array.from(identifier).some(char => !GF32_ALPHABET.includes(char))
    )
      throw new AccountRecoveryError('invalid-identifier')
    const common = Uint8Array.from([
      VERSION,
      format === 'root' ? 0 : 1,
      length >> 5,
      length & 31,
      threshold,
      ...Array.from(identifier, char => GF32_ALPHABET.indexOf(char)),
    ])
    const requestedIndices = input.indices
    const indices =
      requestedIndices === undefined
        ? INDICES.slice(0, shareCount)
        : [...requestedIndices]
    if (indices.length !== shareCount)
      throw new AccountRecoveryError('wrong-share-count')
    digest = validation(secret, common, format)
    payload.set(secret)
    payload.set(digest, length)
    symbols = bytesToGf32Symbols(payload)
    const split = splitGf32Symbols({
      payload: symbols,
      threshold,
      indices,
      randomBytes,
    })
    if (!split.ok) throw new AccountRecoveryError(split.error.code)
    rows = split.value
    const encoded = rows.map((row, position) => {
      const data = [
        ...common,
        GF32_ALPHABET.indexOf(indices[position]!),
        ...row,
      ]
      const check = createLongBchChecksum(PREFIX, data)
      try {
        return `${PREFIX}1${[...data, ...check]
          .map(value => GF32_ALPHABET[value])
          .join('')}`
      } finally {
        data.fill(0)
        check.fill(0)
      }
    })
    for (let first = 0; first < encoded.length; first++) {
      const decoded: FrankRecoveryShare[] = []
      let reconstructed: Uint8Array | undefined,
        recovered: Uint8Array | null = null
      try {
        for (let offset = 0; offset < threshold; offset++) {
          const item = decodeFrankRecoveryShare(
            encoded[(first + offset) % encoded.length]!,
          )
          if (!item.ok) throw new AccountRecoveryError('confirmation-mismatch')
          decoded.push(item.value)
        }
        const result = interpolateGf32Symbols(decoded, 's')
        if (!result.ok) throw new AccountRecoveryError('confirmation-mismatch')
        reconstructed = result.value
        recovered = validateFrankRecoverySymbols(reconstructed, decoded[0]!)
        if (!recovered || secret.some((byte, i) => byte !== recovered![i]))
          throw new AccountRecoveryError('confirmation-mismatch')
      } finally {
        decoded.forEach(share => share.payload.fill(0))
        reconstructed?.fill(0)
        recovered?.fill(0)
      }
    }
    return Object.freeze(encoded)
  } finally {
    secret.fill(0)
    digest?.fill(0)
    symbols?.fill(0)
    payload.fill(0)
    rows.forEach(row => row.fill(0))
  }
}

export function decodeFrankRecoveryShare(
  text: string,
): Codex32Result<FrankRecoveryShare> {
  const fail = (
    code:
      | 'bad-format'
      | 'bad-checksum'
      | 'unsupported-length'
      | 'invalid-threshold'
      | 'invalid-index',
  ): Codex32Result<FrankRecoveryShare> => ({ ok: false, error: { code } })
  if (
    typeof text !== 'string' ||
    (text !== text.toLowerCase() && text !== text.toUpperCase())
  )
    return fail('bad-format')
  const canonical = text.toLowerCase()
  if (!canonical.startsWith('fr1')) return fail('bad-format')
  if (canonical.length !== 131 && canonical.length !== 182)
    return fail('unsupported-length')
  const values = Array.from(canonical.slice(3), char =>
    GF32_ALPHABET.indexOf(char),
  )
  try {
    if (values.some(value => value < 0)) return fail('bad-format')
    if (!verifyLongBchChecksum(PREFIX, values)) return fail('bad-checksum')
    const version = values[0],
      kind = values[1],
      length = ((values[2] ?? 0) << 5) | (values[3] ?? 0),
      threshold = values[4] ?? 0
    if (
      version !== VERSION ||
      (kind !== 0 && kind !== 1) ||
      length !== (kind === 0 ? 32 : 64) ||
      canonical.length !== (kind === 0 ? 131 : 182)
    )
      return fail('bad-format')
    if (threshold < 1 || threshold > 9) return fail('invalid-threshold')
    const identifier = values
      .slice(5, 9)
      .map(value => GF32_ALPHABET[value])
      .join('')
    const index = GF32_ALPHABET[values[9] ?? -1] ?? ''
    if (!index || index === 's') return fail('invalid-index')
    return {
      ok: true,
      value: {
        format: kind === 0 ? 'root' : 'historical',
        byteLength: length as 32 | 64,
        threshold,
        identifier,
        index,
        commonMetadata: Uint8Array.from(values.slice(0, 9)),
        group: `fr/${values.slice(0, 9).join('/')}`,
        payload: Uint8Array.from(values.slice(10, -15)),
        seed: null,
      },
    }
  } finally {
    values.fill(0)
  }
}

/** Validate reconstructed symbols, yielding the existing canonical account representation. */
export function validateFrankRecoverySymbols(
  symbols: Uint8Array,
  share: Pick<FrankRecoveryShare, 'format' | 'byteLength' | 'commonMetadata'>,
): Uint8Array | null {
  const decoded = gf32SymbolsToBytes(symbols, share.byteLength + 32)
  if (!decoded.ok) return null
  const payload = decoded.value,
    secret = payload.slice(0, share.byteLength)
  const expected = validation(secret, share.commonMetadata, share.format)
  try {
    let difference = 0
    for (let i = 0; i < 32; i++)
      difference |= expected[i]! ^ payload[share.byteLength + i]!
    if (difference !== 0) return null
    if (share.format === 'historical') return new Uint8Array(secret)
    const master = createMasterPayload(secret)
    return master.ok ? master.value : null
  } finally {
    payload.fill(0)
    secret.fill(0)
    expected.fill(0)
  }
}
