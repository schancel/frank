import { addressVersionBytes, getChain } from '../src/chain/index.js'
import {
  displayTxidFromBytes,
  internalHashFromBytes,
  privateKeyFromBytes,
  type CompressedPublicKey,
  type DisplayTxid,
  type EcdsaSignature,
  type ExplicitSign,
  type InternalHash,
  type PrivateKey,
  type PubkeyHash,
  type SchnorrSignature,
  type XAddressPayload,
  type XOnlyPublicKey,
} from '../src/constructors.js'
import * as api from '../src/index.js'

// types.d.ts mismatches this API does not recreate (audit section 2):
// - XAddress and crypto.Schnorr were missing. Both are distinct brands below.
// - Message was declared and is not a runtime export. It is not exported here.
// - Networks.get was declared to return Network. getChain can return UnknownChainError.
// - PrivateKey.fromBuffer hid compressed: false and the default network.
//   privateKeyFromBytes requires the compressed flag and does not take a network.
// - Transaction.sign hid sighash and the signing method.
//   ExplicitSign requires both. There is no one-argument sign.

declare const internal: InternalHash
declare const display: DisplayTxid
declare function wantsInternal(hash: InternalHash): void
declare function wantsDisplay(txid: DisplayTxid): void

// @ts-expect-error display-order txid is not an internal hash
wantsInternal(display)
// @ts-expect-error internal hash is not a display-order txid
wantsDisplay(internal)

declare const keyBytes: Uint8Array
// @ts-expect-error fromBytes wants bytes, not a hex string
internalHashFromBytes('00'.repeat(32))
// @ts-expect-error fromBytes wants bytes, not a hex string
displayTxidFromBytes('00'.repeat(32))

declare const compressed: CompressedPublicKey
declare const xOnly: XOnlyPublicKey
declare function wantsXOnly(key: XOnlyPublicKey): void
declare function wantsCompressed(key: CompressedPublicKey): void
// @ts-expect-error a compressed public key is not an x-only key
wantsXOnly(compressed)
// @ts-expect-error an x-only key is not a compressed public key
wantsCompressed(xOnly)

// @ts-expect-error chain is required
addressVersionBytes()

// @ts-expect-error the invented Message class is not part of this API
api.Message

const found = getChain('btc', 'mainnet')
// @ts-expect-error a missing chain is UnknownChainError, not a Network
found.pubkeyHashVersion

// @ts-expect-error compressed is required; there is no uncompressed default
privateKeyFromBytes(keyBytes)
// @ts-expect-error no string | Buffer | object overload
privateKeyFromBytes({ compressed: false }, false)

type OldSign = (key: PrivateKey | string) => unknown
declare const oldSign: OldSign
declare function takeExplicit(sign: ExplicitSign): void
// @ts-expect-error sighash and the signing method are required
takeExplicit(oldSign)

declare const schnorr: SchnorrSignature
declare const ecdsa: EcdsaSignature
declare function wantsEcdsa(signature: EcdsaSignature): void
declare function wantsSchnorr(signature: SchnorrSignature): void
// @ts-expect-error Schnorr is not ECDSA
wantsEcdsa(schnorr)
// @ts-expect-error ECDSA is not Schnorr
wantsSchnorr(ecdsa)

declare const xAddress: XAddressPayload
declare const pubkeyHash: PubkeyHash
declare function wantsPubkeyHash(hash: PubkeyHash): void
wantsPubkeyHash(pubkeyHash)
// @ts-expect-error an XAddress payload is not a pubkey hash
wantsPubkeyHash(xAddress)
