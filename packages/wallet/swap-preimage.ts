/**
 * The HTLC preimage of a swap this account offers: derived, never stored.
 *
 * EXPLICIT NEW DERIVATION (AGENTS.md §6), `frank/swap-htlc-preimage/v1`:
 *
 *   prk      = HKDF-Extract(SHA-256, salt = utf8("frank/swap-htlc-preimage/v1"), ikm = root)
 *   preimage = HKDF-Expand(SHA-256, prk, info, 32)
 *   info     = u8(len(utf8(policyName))) ‖ utf8(policyName) ‖ swapId (exactly 32 bytes)
 *
 * `root` is the account's 32-byte messaging root (`messaging-encryption` domain root), or, for a
 * historical BIP39 account, its complete 64-byte PBKDF2 seed, as for the conversation-ID salt
 * and the self-open key. `policyName` is the swap's pair policy name (for example
 * `xec-monad-testnet-v2`): 1..255 UTF-8 bytes, length-prefixed so that no two (policy, swap)
 * pairs encode to the same info. `swapId` is the fixed-size last field. The hash lock a swap
 * publishes is `sha256(preimage)`.
 *
 * The preimage depends only on the account's key material, the policy and the swap, so every
 * device and process of the account derives the same one without storing or syncing it, and
 * nobody else can compute it. It is a fresh 32-byte copy on every call; the caller wipes it.
 * Pinned vectors live in swap-preimage.jest.test.ts; changing any of the above is a new
 * derivation version.
 */
import { extract, expand } from '@noble/hashes/hkdf'
import { sha256 } from '@noble/hashes/sha256'

export const SWAP_PREIMAGE_LABEL = 'frank/swap-htlc-preimage/v1'

/** What a swap needs from custody to hold a hash lock: its preimage, and nothing else. */
export interface SwapSecretCapability {
  /** The 32-byte preimage of swap `swapId` (32 bytes) under pair policy `policyName`. A fresh
   * copy on every call; never stored by the wallet. */
  swapPreimage(input: { policyName: string; swapId: Uint8Array }): Uint8Array
}

export function swapPreimageInfo(
  policyName: string,
  swapId: Uint8Array,
): Uint8Array {
  if (typeof policyName !== 'string')
    throw new Error('Swap policy name must be a string')
  const policy = new TextEncoder().encode(policyName)
  if (policy.length === 0 || policy.length > 255)
    throw new Error('Swap policy name must be 1..255 UTF-8 bytes')
  if (!(swapId instanceof Uint8Array) || swapId.length !== 32)
    throw new Error('Swap id must be exactly 32 bytes')
  const info = new Uint8Array(1 + policy.length + 32)
  info[0] = policy.length
  info.set(policy, 1)
  info.set(swapId, 1 + policy.length)
  return info
}

/** The preimage, from the account root the caller owns (32-byte messaging root or 64-byte
 * historical BIP39 seed). Custody-internal: hosts reach it only through a
 * {@link SwapSecretCapability}. */
export function deriveSwapPreimage(
  root: Uint8Array,
  policyName: string,
  swapId: Uint8Array,
): Uint8Array {
  if (
    !(root instanceof Uint8Array) ||
    (root.length !== 32 && root.length !== 64)
  )
    throw new RangeError(
      'swap preimage root must be the 32-byte messaging root or the 64-byte BIP39 seed',
    )
  const info = swapPreimageInfo(policyName, swapId)
  const prk = extract(
    sha256,
    root,
    new TextEncoder().encode(SWAP_PREIMAGE_LABEL),
  )
  try {
    return expand(sha256, prk, info, 32)
  } finally {
    prk.fill(0)
  }
}
