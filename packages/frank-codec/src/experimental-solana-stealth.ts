/** Pure helpers for an UNALLOCATED experiment. These do not authorize execution. */
import chains from '../../../docs/protocol/chains/v1.json'
import { decodeCanonical, encodeCanonical, type Encodable } from './cbor'
import { KEY_TYPE, STEALTH_DERIVATION_SCHEME } from './constants'
import { fromHex } from './hash'
import type { StealthAssetTransfer } from './types'

const DOMAIN = 'frank:solana-stealth:edwards-add:v1'
const CLASSIC_TOKEN_PROGRAM = fromHex(
  '06ddf6e1d765a193d9cbe146ceeb79ac1cb485ed5f5b37913a8cf5857eff00a9',
)

export interface ExperimentalSolanaStealthContext {
  /** Random crypto operation identifier; distinct from an application journal UUID. */
  cryptoOperationId: Uint8Array
  memberIndex: number
  /** Random, noncircular context, persisted before derivation; never a ciphertext hash. */
  derivationContext: Uint8Array
}

export interface ExperimentalSolanaStealthDescriptor
  extends ExperimentalSolanaStealthContext {
  chainIdentifier: string
  asset:
    | { kind: 'native' }
    | { kind: 'spl'; mint: Uint8Array; tokenProgram: Uint8Array }
  recipient: Uint8Array
  ephemeral: Uint8Array
  recipientAmount: bigint
  recipientDestination: Uint8Array
  transactionId: Uint8Array
  rawSignedTransaction: Uint8Array
}

function exact(value: unknown, length: number, name: string): Uint8Array {
  if (!(value instanceof Uint8Array) || value.length !== length)
    throw new RangeError(`${name} must contain exactly ${length} bytes`)
  return Uint8Array.from(value)
}

function index(value: unknown): number {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < 0 ||
    value > 0xffffffff
  )
    throw new RangeError('memberIndex must be a uint32')
  return value
}

/** Canonical array3 in the existing opaque scheme-context field (maximum 74 bytes). */
export function encodeExperimentalSolanaStealthContext(
  context: ExperimentalSolanaStealthContext,
): Uint8Array {
  return encodeCanonical([
    exact(context.cryptoOperationId, 32, 'cryptoOperationId'),
    index(context.memberIndex),
    exact(context.derivationContext, 32, 'derivationContext'),
  ])
}

export function decodeExperimentalSolanaStealthContext(
  bytes: Uint8Array,
): ExperimentalSolanaStealthContext {
  if (!(bytes instanceof Uint8Array) || bytes.length > 74)
    throw new RangeError('experimental context must contain at most 74 bytes')
  const value = decodeCanonical(bytes)
  if (!Array.isArray(value) || value.length !== 3)
    throw new RangeError('experimental context must be a canonical array3')
  if (typeof value[1] !== 'bigint' || value[1] < 0n || value[1] > 0xffffffffn)
    throw new RangeError('memberIndex must be a uint32')
  return {
    cryptoOperationId: exact(value[0], 32, 'cryptoOperationId'),
    memberIndex: Number(value[1]),
    derivationContext: exact(value[2], 32, 'derivationContext'),
  }
}

/**
 * Experimental public binding only. Point/subgroup, signature, transaction and
 * configured mint-decimal verification belong to custody/financial validation.
 * The generic reader still preserves scheme 2 as unknown, without executing it.
 */
export function projectExperimentalSolanaStealthTransfer(
  entry: StealthAssetTransfer,
): ExperimentalSolanaStealthDescriptor {
  const transfer = entry.transfer
  if (
    entry.derivationScheme !==
      STEALTH_DERIVATION_SCHEME.experimentalSolanaEd25519 ||
    entry.recipientSpendKey.keyType !== KEY_TYPE.ed25519 ||
    transfer.stealthMetadata?.ephemeralPubKey.keyType !== KEY_TYPE.ed25519
  )
    throw new RangeError(
      'expected experimental scheme 2 with Ed25519 references',
    )
  if (
    !chains.chains.some(
      chain => chain.id === transfer.networkTag && chain.family === 'solana',
    )
  )
    throw new RangeError('expected an exact canonical Solana chain identifier')
  if (
    typeof transfer.value !== 'bigint' ||
    transfer.value <= 0n ||
    transfer.value > 0xffffffffffffffffn
  )
    throw new RangeError('recipientAmount must be a positive uint64')
  if (transfer.vout !== undefined)
    throw new RangeError('Solana transfers cannot contain vout')
  if (
    !(transfer.rawTx instanceof Uint8Array) ||
    transfer.rawTx.length === 0 ||
    transfer.rawTx.length > 16384
  )
    throw new RangeError('raw signed transaction must contain 1..16384 bytes')
  let asset: ExperimentalSolanaStealthDescriptor['asset']
  if (transfer.token === undefined) {
    if (entry.tokenProgram !== undefined)
      throw new RangeError('native transfers cannot contain a token program')
    asset = { kind: 'native' }
  } else {
    const tokenProgram = exact(entry.tokenProgram, 32, 'tokenProgram')
    if (!tokenProgram.every((byte, i) => byte === CLASSIC_TOKEN_PROGRAM[i]))
      throw new RangeError(
        'experimental SPL requires the classic token program',
      )
    asset = {
      kind: 'spl',
      mint: exact(transfer.token, 32, 'mint'),
      tokenProgram,
    }
  }
  if (entry.derivationContext === undefined)
    throw new RangeError('experimental context is required')
  return {
    ...decodeExperimentalSolanaStealthContext(entry.derivationContext),
    chainIdentifier: transfer.networkTag,
    asset,
    recipient: exact(entry.recipientSpendKey.keyBytes, 32, 'recipient'),
    ephemeral: exact(
      transfer.stealthMetadata.ephemeralPubKey.keyBytes,
      32,
      'ephemeral',
    ),
    recipientAmount: transfer.value,
    recipientDestination: exact(
      transfer.destination,
      32,
      'recipientDestination',
    ),
    transactionId: exact(transfer.txId, 64, 'transactionId'),
    rawSignedTransaction: Uint8Array.from(transfer.rawTx),
  }
}

/** Exact frozen proposal Q; destination and signed transaction are checked separately. */
export function experimentalSolanaStealthTranscript(
  entry: StealthAssetTransfer,
): Uint8Array {
  const d = projectExperimentalSolanaStealthTransfer(entry)
  const asset: Encodable =
    d.asset.kind === 'native' ? [0] : [1, d.asset.mint, d.asset.tokenProgram]
  return encodeCanonical([
    DOMAIN,
    d.chainIdentifier,
    asset,
    d.recipient,
    d.ephemeral,
    d.cryptoOperationId,
    d.memberIndex,
    d.derivationContext,
    d.recipientAmount,
  ])
}
