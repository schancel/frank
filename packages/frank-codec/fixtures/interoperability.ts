// Test-only helpers for the cross-language complete-frame fixture. This module deliberately uses
// only the public browser-safe codec surface; it is not a production reader or writer.
import {
  contentHash,
  decodeCanonical,
  defaultContext,
  encodeCanonical,
  fromHex,
  messageContentDigest,
  paymentCommitment,
  recipientPayloadDigest,
  toHex,
  validateFrame,
} from '../src'
import { contextFromManifest, runCase } from './checker'
import type { ManifestCase } from './manifest'

export interface InteroperabilityCryptoFixture {
  network: string
  frame_hex: string
  mutated_frame_hex: string
  mutation_offset: number
  t1_hex: string
  mutated_t1_hex: string
  t1a_frame_hex: string
  t1a_hex: string
  t3_hex: string
  mutated_t3_hex: string
  payment_child_index: number
  t4_hex: string
  mutated_t4_hex: string
  signature_input: string
  signature_public_key_hex: string
  signature_der_hex: string
}

export interface InteroperabilityFixture {
  format: string
  typescript_origin_ids: string[]
  typescript_retention_ids: string[]
  rust_origin_ids: string[]
  hostile_manifest: {
    case_count: number
    reject_count: number
    reject_category_counts: Record<string, number>
  }
  crypto: InteroperabilityCryptoFixture
}

export function exactFrameObservation(c: ManifestCase): {
  outcome: ReturnType<typeof runCase>
  frameHex: string
  bodyCanonical: boolean
  payloadCanonical: boolean
  payloadFieldKeys: bigint[]
} {
  const frame = fromHex(c.frame_hex)
  const result = validateFrame(frame, contextFromManifest(c))
  if (result.kind !== 'parsed') throw new Error(`${c.id} was not parsed`)
  const body = frame.subarray(9)
  const payload = result.payloadBytes
  const map = result.payload
  return {
    outcome: runCase(c),
    frameHex: toHex(result.frame),
    bodyCanonical:
      toHex(encodeCanonical(decodeCanonical(body))) === toHex(body),
    payloadCanonical:
      toHex(encodeCanonical(decodeCanonical(payload))) === toHex(payload),
    payloadFieldKeys:
      map instanceof Map
        ? ([...map.keys()].filter(key => typeof key === 'bigint') as bigint[])
        : [],
  }
}

export function cryptoObservation(f: InteroperabilityCryptoFixture): {
  differenceOffsets: number[]
  t1Hex: string
  mutatedT1Hex: string
  t1aHex: string
  t3Hex: string
  mutatedT3Hex: string
  t4Hex: string
  mutatedT4Hex: string
} {
  const frame = fromHex(f.frame_hex)
  const mutated = fromHex(f.mutated_frame_hex)
  const parsed = validateFrame(frame, defaultContext())
  const mutatedParsed = validateFrame(mutated, defaultContext())
  if (parsed.kind !== 'parsed' || mutatedParsed.kind !== 'parsed')
    throw new Error('cryptographic fixture was not parsed')
  const t3 = recipientPayloadDigest(f.network, frame)
  const mutatedT3 = recipientPayloadDigest(f.network, mutated)
  return {
    differenceOffsets: [...frame.keys()].filter(i => frame[i] !== mutated[i]),
    t1Hex: toHex(contentHash(parsed)),
    mutatedT1Hex: toHex(contentHash(mutatedParsed)),
    t1aHex: toHex(messageContentDigest(fromHex(f.t1a_frame_hex))),
    t3Hex: toHex(t3),
    mutatedT3Hex: toHex(mutatedT3),
    t4Hex: toHex(paymentCommitment(t3, f.payment_child_index)),
    mutatedT4Hex: toHex(paymentCommitment(mutatedT3, f.payment_child_index)),
  }
}
