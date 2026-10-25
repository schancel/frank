/**
 * The payment a group write carries to its hosting relay. Pure: no wallet, chain or transport.
 *
 * Every new write to a group carries one signed EVM transaction on the host's network paying the
 * host's payee at least its price. Its calldata commits to the host, the group, the epoch and the
 * envelope's signing digest, so one payment funds exactly one write on exactly one relay:
 *
 *   commitment = SHA256( lp("frank/group-write-payment/v1") || lp(network) || lp(hostOrigin)
 *                        || groupId[32] || epoch_be[8] || signingDigest[32] )
 *   calldata   = "GRPW" || 0x01 || commitment
 *   lp(x)      = u16_be(len(x)) || x
 *
 * The relay's verifier is `backend/cashweb/cashweb-registry/src/group_write_payment.rs`; both
 * sides are checked against the same independently produced vectors.
 */
import { sha256 } from '@noble/hashes/sha256.js'
import { concatBytes } from '@noble/hashes/utils.js'
import { HDNodeWallet, Transaction, getAddress } from 'ethers'
import {
  bytesToHex,
  computeOuterWriteSigningHash,
  hexToBytes,
  type SealedGroupMessageEnvelope,
} from './group-crypto'

export const GROUP_WRITE_COMMITMENT_DOMAIN = 'frank/group-write-payment/v1'
export const GROUP_WRITE_LOKAD_ID = 'GRPW'
export const GROUP_WRITE_CALLDATA_VERSION = 0x01
/** The burn payee, `0x…dEaD`, as the relay reports it. */
export const GROUP_WRITE_BURN_ADDRESS =
  '0x000000000000000000000000000000000000dEaD'

const utf8 = new TextEncoder()

function lengthPrefixed(text: string): Uint8Array {
  const bytes = utf8.encode(text)
  if (bytes.length > 0xffff)
    throw new Error('Group write commitment field too long')
  return concatBytes(
    new Uint8Array([bytes.length >> 8, bytes.length & 0xff]),
    bytes,
  )
}

function u64Be(value: number): Uint8Array {
  if (!Number.isSafeInteger(value) || value < 0)
    throw new Error('Invalid epoch')
  const out = new Uint8Array(8)
  new DataView(out.buffer).setBigUint64(0, BigInt(value))
  return out
}

/** Who the host is paid through, as `GET /groups/:id/write-policy` reports it. */
export type GroupWritePayee =
  | { readonly kind: 'burn'; readonly address: string }
  | { readonly kind: 'address'; readonly address: string }
  | { readonly kind: 'xpub'; readonly xpub: string }

/** The hosting relay's price for one write. */
export interface GroupWritePolicy {
  /** Canonical chain identifier (docs/protocol/chains/v1.json) payments are made on. */
  readonly network: string
  readonly priceWei: bigint
  /** The origin every payment commits to: the host relay's `URL.origin`. */
  readonly hostOrigin: string
  readonly payee: GroupWritePayee
}

/** Validate the relay's answer. The host must be the relay this client writes to. */
export function parseGroupWritePolicy(
  raw: unknown,
  expectedHostOrigin: string,
): GroupWritePolicy {
  const body = raw as Record<string, unknown> | null
  const payee = body?.payee as Record<string, unknown> | undefined
  if (
    !body ||
    typeof body.network !== 'string' ||
    !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(body.network) ||
    typeof body.price_wei !== 'string' ||
    !/^[1-9][0-9]*$/.test(body.price_wei) ||
    typeof body.host_origin !== 'string' ||
    !payee ||
    typeof payee.kind !== 'string'
  )
    throw new Error('Invalid group write policy')
  const hostOrigin = new URL(expectedHostOrigin).origin
  if (body.host_origin !== hostOrigin)
    throw new Error(
      `Group write policy names host ${body.host_origin}, not ${hostOrigin}`,
    )
  let parsed: GroupWritePayee
  if (payee.kind === 'burn' && typeof payee.address === 'string') {
    if (getAddress(payee.address) !== getAddress(GROUP_WRITE_BURN_ADDRESS))
      throw new Error('Invalid group write burn address')
    parsed = { kind: 'burn', address: getAddress(payee.address) }
  } else if (payee.kind === 'address' && typeof payee.address === 'string')
    parsed = { kind: 'address', address: getAddress(payee.address) }
  else if (payee.kind === 'xpub' && typeof payee.xpub === 'string') {
    if (!/^[xt]pub/.test(payee.xpub))
      throw new Error('Group write xpub must be public')
    HDNodeWallet.fromExtendedKey(payee.xpub) // throws when it is not an extended key
    parsed = { kind: 'xpub', xpub: payee.xpub }
  } else throw new Error('Unsupported group write payee')
  return {
    network: body.network,
    priceWei: BigInt(body.price_wei),
    hostOrigin,
    payee: parsed,
  }
}

export function groupWriteCommitment(params: {
  network: string
  hostOrigin: string
  groupIdHex: string
  epoch: number
  signingDigest: Uint8Array
}): Uint8Array {
  const groupId = hexToBytes(params.groupIdHex)
  if (groupId.length !== 32 || params.signingDigest.length !== 32)
    throw new Error('Invalid group write target')
  return sha256(
    concatBytes(
      lengthPrefixed(GROUP_WRITE_COMMITMENT_DOMAIN),
      lengthPrefixed(params.network),
      lengthPrefixed(params.hostOrigin),
      groupId,
      u64Be(params.epoch),
      params.signingDigest,
    ),
  )
}

export function groupWriteCalldata(commitment: Uint8Array): Uint8Array {
  if (commitment.length !== 32)
    throw new Error('Invalid group write commitment')
  return concatBytes(
    utf8.encode(GROUP_WRITE_LOKAD_ID),
    new Uint8Array([GROUP_WRITE_CALLDATA_VERSION]),
    commitment,
  )
}

/** The xpub child index a write pays: `u32_be(commitment[0..4]) & 0x7fffffff` (PROPOSED). */
export function groupWriteXpubIndex(commitment: Uint8Array): number {
  return (
    ((commitment[0]! << 24) |
      (commitment[1]! << 16) |
      (commitment[2]! << 8) |
      commitment[3]!) &
    0x7fffffff
  )
}

/** The checksummed address a payment carrying `commitment` must pay. */
export function groupWritePayeeAddress(
  payee: GroupWritePayee,
  commitment: Uint8Array,
): string {
  if (payee.kind !== 'xpub') return getAddress(payee.address)
  return HDNodeWallet.fromExtendedKey(payee.xpub).derivePath(
    `0/${groupWriteXpubIndex(commitment)}`,
  ).address
}

/** Exactly what the wallet must sign for one write: one transaction, no more. */
export interface GroupWritePaymentPlan {
  readonly network: string
  readonly destination: string
  readonly amountWei: bigint
  readonly calldata: Uint8Array
}

/** The digest the group's write key signs for `envelope`, which its payment commits to. */
export function groupWriteSigningDigest(
  groupIdHex: string,
  envelope: SealedGroupMessageEnvelope,
): Uint8Array {
  return computeOuterWriteSigningHash({
    groupIdHex,
    epoch: envelope.epoch,
    nonce: hexToBytes(envelope.nonce),
    ciphertext: hexToBytes(envelope.ciphertext),
  })
}

export function groupWritePaymentPlan(
  policy: GroupWritePolicy,
  groupIdHex: string,
  envelope: SealedGroupMessageEnvelope,
): GroupWritePaymentPlan {
  const signingDigest = groupWriteSigningDigest(groupIdHex, envelope)
  const commitment = groupWriteCommitment({
    network: policy.network,
    hostOrigin: policy.hostOrigin,
    groupIdHex,
    epoch: envelope.epoch,
    signingDigest,
  })
  return {
    network: policy.network,
    destination: groupWritePayeeAddress(policy.payee, commitment),
    amountWei: policy.priceWei,
    calldata: groupWriteCalldata(commitment),
  }
}

/** The payment field of a group write, as JSON carries it. */
export interface GroupWritePaymentWire {
  readonly network: string
  /** Hex, no `0x`. */
  readonly raw_transaction: string
}

/** Refuse signed bytes that do not carry out `plan` before they are persisted or sent. The
 * native chain id is checked by the wallet that signed for the canonical network. */
export function assertGroupWritePayment(
  plan: GroupWritePaymentPlan,
  rawTransaction: Uint8Array,
): GroupWritePaymentWire {
  const tx = Transaction.from(`0x${bytesToHex(rawTransaction)}`)
  if (
    !tx.isSigned() ||
    !tx.to ||
    getAddress(tx.to) !== getAddress(plan.destination) ||
    tx.value < plan.amountWei ||
    tx.data.toLowerCase() !== `0x${bytesToHex(plan.calldata)}`
  )
    throw new Error('Signed group write payment differs from its plan')
  return { network: plan.network, raw_transaction: bytesToHex(rawTransaction) }
}

/** What the writer keeps of one write's payment. The plan and the wallet operation that pays it
 * are stored before anything is signed; the signed bytes are stored before they go to the relay.
 * Every attempt of the write replays this, so a retry never pays again. */
export interface StoredGroupWritePayment {
  readonly network: string
  readonly destination: string
  /** Decimal wei. */
  readonly amountWei: string
  /** Hex, no `0x`. */
  readonly calldata: string
  /** The wallet's transaction-set operation, derived from the write's signing digest and
   * `generation`. */
  readonly operationId: string
  /** How many earlier plans were dropped, unsubmitted, after the host's terms changed. */
  readonly generation?: number
  /** Hex, no `0x`; present once the wallet has signed. */
  readonly rawTransaction?: string
  /** The bytes were handed to the relay at least once: from here they may be out, and the
   * plan is never replaced. */
  readonly submitted?: true
  /** An attempt ended without an answer from the relay. A later refusal is then no proof the
   * payment stayed in: the coin is never released, only reconciled against the chain. */
  readonly uncertain?: true
  /** The relay refused the write for good and the wallet is giving the coin back; a restart
   * finishes the release. */
  readonly releasing?: true
  /** The relay refused the write for good and the wallet released the payment's coin after
   * finding the transaction neither pending nor mined. */
  readonly released?: true
  /** The relay refused the write for good but the chain shows its payment pending or mined:
   * the wallet tracks it as spent. Nothing more is submitted. */
  readonly spent?: true
}

export function storedGroupWritePlan(
  stored: StoredGroupWritePayment,
): GroupWritePaymentPlan {
  return {
    network: stored.network,
    destination: stored.destination,
    amountWei: BigInt(stored.amountWei),
    calldata: hexToBytes(stored.calldata),
  }
}

/** The wallet operation that pays for the write whose envelope has `signingDigest`. Every
 * device of the account computes the same one. `generation` counts plans dropped before any
 * submission because the host's terms changed. */
export function groupWriteOperationId(
  signingDigest: Uint8Array,
  generation = 0,
): string {
  const base = `group-write-${bytesToHex(signingDigest)}`
  return generation === 0 ? base : `${base}-${generation}`
}
