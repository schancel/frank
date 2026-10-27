/**
 * The payment a group write carries to its hosting relay. Pure: no wallet, chain or transport.
 *
 * Every new write to a group carries one signed EVM transaction on the host's network paying the
 * host relay's own address at least the group's price. The group's creator sets that price, and
 * may change it, in a record signed with the group's root key (`signGroupWritePrice`); the host
 * refuses a price below its minimum, and prices a group without one at that minimum. The
 * payment's calldata commits to the host, the group, the epoch and the envelope's signing
 * digest, so one payment funds exactly one write on exactly one relay:
 *
 *   commitment = SHA256( lp("frank/group-write-payment/v1") || lp(network) || lp(hostOrigin)
 *                        || groupId[32] || epoch_be[8] || signingDigest[32] )
 *   calldata   = "GRPW" || 0x01 || commitment
 *   lp(x)      = u16_be(len(x)) || x
 *
 *   price digest = SHA256( lp("frank/group-write-price/v1") || lp(network) || groupId[32]
 *                          || version_be[8] || price_wei_be[16] )
 *
 * The relay's verifier is `backend/cashweb/cashweb-registry/src/group_write_payment.rs`; both
 * sides are checked against the same independently produced vectors.
 */
import { secp256k1 } from '@noble/curves/secp256k1.js'
import { sha256 } from '@noble/hashes/sha256.js'
import { concatBytes } from '@noble/hashes/utils.js'
import { Transaction, getAddress } from 'ethers'
import { isCanonicalChainIdentifier } from '../message-items/chain-identifiers'
import {
  bytesToHex,
  computeGroupIdFromPubKey,
  computeOuterWriteSigningHash,
  hexToBytes,
  type SealedGroupMessageEnvelope,
} from './group-crypto'

export const GROUP_WRITE_COMMITMENT_DOMAIN = 'frank/group-write-payment/v1'
export const GROUP_WRITE_PRICE_DOMAIN = 'frank/group-write-price/v1'
export const GROUP_WRITE_LOKAD_ID = 'GRPW'
export const GROUP_WRITE_CALLDATA_VERSION = 0x01

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

const U128_MAX = (1n << 128n) - 1n

function u128Be(value: bigint): Uint8Array {
  if (value < 0n || value > U128_MAX) throw new Error('Invalid wei amount')
  const out = new Uint8Array(16)
  const view = new DataView(out.buffer)
  view.setBigUint64(0, value >> 64n)
  view.setBigUint64(8, value & 0xffffffffffffffffn)
  return out
}

/** What a write to one group pays its hosting relay, as `GET /groups/:id/write-policy` reports
 * it (proxied to the host by a home relay). */
export interface GroupWritePolicy {
  /** Canonical chain identifier (docs/protocol/chains/v1.json) payments are made on. */
  readonly network: string
  /** What one write to this group pays now: its creator's price, or `minPriceWei` while the
   * creator has set none. */
  readonly priceWei: bigint
  /** The version of the creator's price record `priceWei` comes from; 0 while there is none. */
  readonly priceVersion: number
  /** The least price a creator may set on this relay. */
  readonly minPriceWei: bigint
  /** The origin every payment commits to: the host relay's `URL.origin`. */
  readonly hostOrigin: string
  /** The host relay's own checksummed address: every write pays it. */
  readonly payee: string
  /** The creator's signed record `priceWei` comes from; absent while there is none. Checked
   * against the group's root key when the caller names it (`GroupWritePolicyGroup`). */
  readonly priceRecord?: GroupWritePriceRecord
}

/** The group a policy is read for, so its creator's price record is checked against the key
 * that names the group. */
export interface GroupWritePolicyGroup {
  readonly groupIdHex: string
  /** Compressed secp256k1 public key, hex: the group id is derived from it. */
  readonly groupPubKeyHex: string
}

function parsePriceRecord(raw: unknown): GroupWritePriceRecord | undefined {
  if (raw === null || raw === undefined) return undefined
  const r = raw as Record<string, unknown>
  if (
    typeof r.group_id !== 'string' ||
    !/^[0-9a-f]{64}$/.test(r.group_id) ||
    typeof r.network !== 'string' ||
    typeof r.version !== 'number' ||
    !Number.isSafeInteger(r.version) ||
    r.version < 1 ||
    typeof r.price_wei !== 'string' ||
    !DECIMAL_WEI.test(r.price_wei) ||
    typeof r.admin_sig !== 'string' ||
    !/^[0-9a-fA-F]{128}$/.test(r.admin_sig)
  )
    throw new Error('Invalid group write price record')
  return {
    group_id: r.group_id,
    network: r.network,
    version: r.version,
    price_wei: r.price_wei,
    admin_sig: r.admin_sig.toLowerCase(),
  }
}

/** Whether `record` is a price for `group` on `network`, signed low-S by the group's root key. */
export function verifyGroupWritePriceRecord(
  record: GroupWritePriceRecord,
  network: string,
  group: GroupWritePolicyGroup,
): boolean {
  const groupIdHex = group.groupIdHex.toLowerCase()
  let pub: Uint8Array
  try {
    pub = hexToBytes(group.groupPubKeyHex)
    if (computeGroupIdFromPubKey(pub) !== groupIdHex) return false
  } catch {
    return false
  }
  if (record.group_id !== groupIdHex || record.network !== network) return false
  try {
    const signature = secp256k1.Signature.fromCompact(record.admin_sig)
    if (signature.hasHighS()) return false
    return secp256k1.verify(
      signature,
      groupWritePriceDigest({
        network,
        groupIdHex,
        version: record.version,
        priceWei: BigInt(record.price_wei),
      }),
      pub,
      { lowS: true },
    )
  } catch {
    return false
  }
}

const DECIMAL_WEI = /^[1-9][0-9]{0,38}$/

/** Validate the relay's answer. The host must be the relay this client writes to. */
export function parseGroupWritePolicy(
  raw: unknown,
  expectedHostOrigin: string,
  group?: GroupWritePolicyGroup,
): GroupWritePolicy {
  const body = raw as Record<string, unknown> | null
  if (
    !body ||
    // Exactly one of the protocol registry's ids (docs/protocol/chains/v1.json); no alias.
    !isCanonicalChainIdentifier(body.network) ||
    typeof body.price_wei !== 'string' ||
    !DECIMAL_WEI.test(body.price_wei) ||
    typeof body.min_price_wei !== 'string' ||
    !DECIMAL_WEI.test(body.min_price_wei) ||
    typeof body.price_version !== 'number' ||
    !Number.isSafeInteger(body.price_version) ||
    body.price_version < 0 ||
    typeof body.host_origin !== 'string' ||
    typeof body.payee !== 'string' ||
    !/^0x[0-9a-fA-F]{40}$/.test(body.payee)
  )
    throw new Error('Invalid group write policy')
  const hostOrigin = new URL(expectedHostOrigin).origin
  if (body.host_origin !== hostOrigin)
    throw new Error(
      `Group write policy names host ${body.host_origin}, not ${hostOrigin}`,
    )
  const priceWei = BigInt(body.price_wei)
  const minPriceWei = BigInt(body.min_price_wei)
  if (priceWei < minPriceWei)
    throw new Error('Group write policy prices the group below its minimum')
  // The price is the creator's signed price, or the host's minimum when that is higher or there
  // is none: a host cannot name any other price for the group.
  const priceRecord = parsePriceRecord(body.price_record)
  const recordVersion = priceRecord?.version ?? 0
  const recordPrice = priceRecord ? BigInt(priceRecord.price_wei) : 0n
  if (
    body.price_version !== recordVersion ||
    priceWei !== (recordPrice > minPriceWei ? recordPrice : minPriceWei)
  )
    throw new Error("Group write policy's price is not its creator's record")
  if (
    priceRecord &&
    group &&
    !verifyGroupWritePriceRecord(priceRecord, body.network, group)
  )
    throw new Error("Group write price is not signed by the group's root key")
  return {
    network: body.network,
    priceWei,
    priceVersion: body.price_version,
    minPriceWei,
    hostOrigin,
    payee: getAddress(body.payee.toLowerCase()),
    ...(priceRecord ? { priceRecord } : {}),
  }
}

/** A group's write price as its creator sends it to the host (`PUT /groups/:id/write-price`). */
export interface GroupWritePriceRecord {
  readonly group_id: string
  readonly network: string
  readonly version: number
  /** Decimal wei. */
  readonly price_wei: string
  /** Hex compact low-S signature by the group's root key over `groupWritePriceDigest`. */
  readonly admin_sig: string
}

/** The digest a group's root key signs to set the group's write price. */
export function groupWritePriceDigest(params: {
  network: string
  groupIdHex: string
  version: number
  priceWei: bigint
}): Uint8Array {
  const groupId = hexToBytes(params.groupIdHex)
  if (groupId.length !== 32) throw new Error('Invalid group id')
  if (!Number.isSafeInteger(params.version) || params.version < 1)
    throw new Error('Invalid write price version')
  return sha256(
    concatBytes(
      lengthPrefixed(GROUP_WRITE_PRICE_DOMAIN),
      lengthPrefixed(params.network),
      groupId,
      u64Be(params.version),
      u128Be(params.priceWei),
    ),
  )
}

/** The creator's (or another holder of the group's root key's) write price record `version`.
 * The host accepts it only above its minimum and above the version it holds. */
export function signGroupWritePrice(params: {
  network: string
  groupIdHex: string
  version: number
  priceWei: bigint
  rootSecretKey: Uint8Array
}): GroupWritePriceRecord {
  if (params.priceWei <= 0n) throw new Error('A write price is above zero')
  const groupIdHex = params.groupIdHex.toLowerCase()
  if (
    computeGroupIdFromPubKey(
      secp256k1.getPublicKey(params.rootSecretKey, true),
    ) !== groupIdHex
  )
    throw new Error("The key is not this group's root key")
  const digest = groupWritePriceDigest({ ...params, groupIdHex })
  const signature = secp256k1.sign(digest, params.rootSecretKey, {
    lowS: true,
  })
  return {
    group_id: groupIdHex,
    network: params.network,
    version: params.version,
    price_wei: params.priceWei.toString(),
    admin_sig: bytesToHex(signature.toCompactRawBytes()),
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
    destination: getAddress(policy.payee),
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
  /** A relay refused the write but the chain shows its payment pending or mined: the wallet
   * has authorized the set and tracks it as spent. The coin is never released, and the write
   * is retried with the same bytes until a relay holds it. */
  readonly spent?: true
  /** The user asked to discard the write and the wallet is reading the chain before it gives
   * the coin back; a restart finishes the discard instead of sending the write. */
  readonly discarding?: true
  /** The user discarded the write: the wallet found its payment neither pending nor mined and
   * gave the coin back (`released`). The write is never sent. */
  readonly discarded?: true
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
