/** Test-only v2 negotiation fields that satisfy the testnet deadline rules (R1–R3). */
import { sha256 } from '@noble/hashes/sha256.js'
import { hexToBytes } from '@noble/hashes/utils.js'
import type { AcceptFields, OfferFields } from './negotiation'

/** E of every fixture offer (2033-05-18); T_B = E + 12 h, T_A = T_B + 12 h. */
export const FIXTURE_EXPIRY = 2000000000n
/** secp256k1 3·G and 4·G: valid compressed points distinct from the 1·G / 2·G party keys. */
export const FIXTURE_XEC_REFUND_KEY = hexToBytes(
  '02f9308a019258c31049344f85f89d5229b531c845836f99b08601f113bce036f9',
)
export const FIXTURE_XEC_CLAIM_KEY = hexToBytes(
  '02e493dbf1c10d80f3581e4904930b1404cc6c13900ee0758474fa94abe8c4cd13',
)
export const FIXTURE_PREIMAGE = new Uint8Array(32).fill(0x44)

export function fixtureOfferFields(
  overrides: Partial<OfferFields> = {},
): OfferFields {
  const expiry = overrides.expiry ?? FIXTURE_EXPIRY
  return {
    xecPrincipal: 12345n,
    evmPrincipal: 1000000000000000001n,
    expiry,
    hashLock: sha256(FIXTURE_PREIMAGE),
    xecRefundPublicKey: new Uint8Array(FIXTURE_XEC_REFUND_KEY),
    evmRecipient: new Uint8Array(20).fill(0xaa),
    xecRefundTime: expiry + 86400n,
    evmExpiry: expiry + 43200n,
    evmHtlcContract: new Uint8Array(20).fill(0xcc),
    ...overrides,
  }
}
export function fixtureAcceptFields(
  overrides: Partial<AcceptFields> = {},
): AcceptFields {
  return {
    xecClaimPublicKey: new Uint8Array(FIXTURE_XEC_CLAIM_KEY),
    evmSender: new Uint8Array(20).fill(0xbb),
    ...overrides,
  }
}
export const fixtureAccept = (overrides: Partial<AcceptFields> = {}) =>
  ({ kind: 'accept', fields: fixtureAcceptFields(overrides) } as const)
