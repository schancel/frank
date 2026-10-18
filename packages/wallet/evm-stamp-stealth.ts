/**
 * Recipient-controlled one-time EVM destinations for mandatory direct-message stamp payments.
 *
 * This preserves Stamp's public/private derivation without inventing an EVM wallet path. The
 * payload hash tweaks the recipient identity key, then both sides derive the same non-hardened
 * `m/44/145/paymentIndex/0` BIP32 child. Only the final address encoding changes for EVM.
 *
 * This implementation uses ethers' secp256k1 point operations directly. It does not use bitcore,
 * Bitcoin network/version bytes, or xpub/xpriv serialization.
 */
import {
  computeAddress,
  computeHmac,
  concat,
  dataSlice,
  getBigInt,
  getBytes,
  hexlify,
  SigningKey,
  toBeHex,
} from 'ethers'

const MAX_NON_HARDENED_CHILD_INDEX = 0x7fffffff
const SECP256K1_ORDER =
  0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n
const STAMP_PATH_PREFIX = [44, 145] as const

export interface MonadStampChildDestination {
  paymentIndex: number
  derivationPath: string
  publicKey: Uint8Array
  address: string
}

function scalar(bytes: Uint8Array, name: string): bigint {
  if (bytes.length !== 32) {
    throw new Error(`${name} must be exactly 32 bytes, got ${bytes.length}`)
  }
  const value = getBigInt(hexlify(bytes))
  if (value === 0n || value >= SECP256K1_ORDER) {
    throw new Error(`${name} must be a valid secp256k1 scalar`)
  }
  return value
}

function scalarBytes(value: bigint): Uint8Array {
  return getBytes(toBeHex(value, 32))
}

function validatePaymentIndex(paymentIndex: number): void {
  if (
    !Number.isInteger(paymentIndex) ||
    paymentIndex < 0 ||
    paymentIndex > MAX_NON_HARDENED_CHILD_INDEX
  ) {
    throw new Error(
      `Stamp payment index must be a non-hardened uint31, got ${paymentIndex}`,
    )
  }
}

function childPath(paymentIndex: number): string {
  return `m/44/145/${paymentIndex}/0`
}

function ser32(index: number): Uint8Array {
  return Uint8Array.from([
    (index >>> 24) & 0xff,
    (index >>> 16) & 0xff,
    (index >>> 8) & 0xff,
    index & 0xff,
  ])
}

function childTweak(
  publicKey: Uint8Array,
  chainCode: Uint8Array,
  index: number,
): { tweak: bigint; chainCode: Uint8Array } {
  const digest = getBytes(
    computeHmac('sha512', chainCode, concat([publicKey, ser32(index)])),
  )
  const tweak = scalar(getBytes(dataSlice(digest, 0, 32)), 'BIP32 child tweak')
  return { tweak, chainCode: getBytes(dataSlice(digest, 32)) }
}

function compressedPublicKey(key: Uint8Array): Uint8Array {
  return getBytes(SigningKey.computePublicKey(key, true))
}

function addPublicTweak(publicKey: Uint8Array, tweak: bigint): Uint8Array {
  const tweakPublicKey = compressedPublicKey(scalarBytes(tweak))
  return getBytes(SigningKey.addPoints(publicKey, tweakPublicKey, true))
}

function derivePublicChild(
  rootPublicKey: Uint8Array,
  rootChainCode: Uint8Array,
  paymentIndex: number,
): Uint8Array {
  let publicKey = rootPublicKey
  let chainCode = rootChainCode
  for (const index of [...STAMP_PATH_PREFIX, paymentIndex, 0]) {
    const child = childTweak(publicKey, chainCode, index)
    publicKey = addPublicTweak(publicKey, child.tweak)
    chainCode = child.chainCode
  }
  return publicKey
}

function derivePrivateChild(
  rootPrivateKey: bigint,
  rootChainCode: Uint8Array,
  paymentIndex: number,
): bigint {
  let privateKey = rootPrivateKey
  let chainCode = rootChainCode
  for (const index of [...STAMP_PATH_PREFIX, paymentIndex, 0]) {
    const child = childTweak(
      compressedPublicKey(scalarBytes(privateKey)),
      chainCode,
      index,
    )
    privateKey = (privateKey + child.tweak) % SECP256K1_ORDER
    if (privateKey === 0n) {
      throw new Error('BIP32 child derivation produced an invalid private key')
    }
    chainCode = child.chainCode
  }
  return privateKey
}

function destination(
  paymentIndex: number,
  publicKey: Uint8Array,
): MonadStampChildDestination {
  return {
    paymentIndex,
    derivationPath: childPath(paymentIndex),
    publicKey,
    address: computeAddress(hexlify(publicKey)),
  }
}

/** Sender/relay derivation from the recipient's registered compressed secp256k1 public key. */
export function deriveMonadStampChildPublic(params: {
  payloadHash: Uint8Array
  recipientPublicKey: Uint8Array
  paymentIndex: number
}): MonadStampChildDestination {
  const payloadScalar = scalar(params.payloadHash, 'Stamp payload hash')
  validatePaymentIndex(params.paymentIndex)
  const recipientPublicKey = compressedPublicKey(params.recipientPublicKey)
  const rootPublicKey = addPublicTweak(recipientPublicKey, payloadScalar)
  return destination(
    params.paymentIndex,
    derivePublicChild(rootPublicKey, params.payloadHash, params.paymentIndex),
  )
}

/** Recipient derivation of the matching child private key and EVM destination. */
export function deriveMonadStampChildPrivate(params: {
  payloadHash: Uint8Array
  recipientPrivateKey: Uint8Array
  paymentIndex: number
}): MonadStampChildDestination & { privateKey: Uint8Array } {
  const payloadScalar = scalar(params.payloadHash, 'Stamp payload hash')
  const recipientPrivateKey = scalar(
    params.recipientPrivateKey,
    'Recipient private key',
  )
  validatePaymentIndex(params.paymentIndex)
  const rootPrivateKey = (recipientPrivateKey + payloadScalar) % SECP256K1_ORDER
  if (rootPrivateKey === 0n) {
    throw new Error('Stamp root derivation produced an invalid private key')
  }
  const privateKey = derivePrivateChild(
    rootPrivateKey,
    params.payloadHash,
    params.paymentIndex,
  )
  const privateKeyBytes = scalarBytes(privateKey)
  return {
    ...destination(params.paymentIndex, compressedPublicKey(privateKeyBytes)),
    privateKey: privateKeyBytes,
  }
}

import {
  validateFrame,
  defaultContext,
  decodeCanonical,
  encodeDirectMessageCryptoContext,
  compareBytes,
  recipientPayloadDigest,
  type AccountRef,
} from '@frank/codec'
import { verifyCanonicalStampProof } from '@frank/cashweb/relay/canonical-dm-stamp'

/** Exact B envelope/context validation before any quote, lease, signer or network operation. */
export function inspectCanonicalPreparedEnvelope(
  payload: Uint8Array,
  context: Uint8Array,
) {
  if (
    !(payload instanceof Uint8Array) ||
    payload.length < 1 ||
    payload.length > 8 * 1024 * 1024 ||
    !(context instanceof Uint8Array) ||
    context.length < 1 ||
    context.length > 4096
  )
    throw new Error('canonical-stamp:bounds')
  const parsed = validateFrame(payload, defaultContext())
  if (
    parsed.kind !== 'parsed' ||
    parsed.typed?.type !== 5 ||
    parsed.typed.schemaVersion !== 2 ||
    parsed.typed.suite !== 1
  )
    throw new Error('canonical-stamp:payload')
  const fields = decodeCanonical(context)
  if (!(fields instanceof Map) || fields.size !== 16)
    throw new Error('canonical-stamp:context')
  const account = (key: bigint): AccountRef => {
    const value = fields.get(key)
    if (
      !(value instanceof Map) ||
      value.size !== 2 ||
      value.get(0n) !== 1n ||
      !(value.get(1n) instanceof Uint8Array)
    )
      throw new Error('canonical-stamp:role')
    return { keyType: 1, keyBytes: new Uint8Array(value.get(1n) as Uint8Array) }
  }
  const bytes = (key: bigint): Uint8Array => {
    const value = fields.get(key)
    if (!(value instanceof Uint8Array) || value.length !== 32)
      throw new Error('canonical-stamp:T1')
    return new Uint8Array(value)
  }
  const frame = parsed.typed,
    senderT1 = bytes(4n),
    recipientT1 = bytes(5n),
    senderMessageKey = account(6n),
    recipientMessageKey = account(7n),
    stampKey = account(8n)
  const expected = encodeDirectMessageCryptoContext({
    network: frame.network,
    sender: frame.sender,
    recipient: frame.recipient,
    senderDirectoryHash: senderT1,
    recipientDirectoryHash: recipientT1,
    senderMessageKey,
    recipientMessageKey,
    stampKey,
    ephemeralPoint: frame.ephemeralPoint,
    sharedPoint: frame.sharedPoint,
    dleqProof: frame.dleqProof,
  })
  if (compareBytes(expected, context) !== 0)
    throw new Error('canonical-stamp:exact-context')
  verifyCanonicalStampProof({
    network: frame.network,
    stampKey,
    ephemeralPoint: frame.ephemeralPoint,
    sharedPoint: frame.sharedPoint,
    dleqProof: frame.dleqProof,
  })
  return {
    payload: frame,
    senderT1,
    recipientT1,
    senderMessageKey,
    recipientMessageKey,
    stampKey,
    t3: recipientPayloadDigest(frame.network, payload),
  }
}
