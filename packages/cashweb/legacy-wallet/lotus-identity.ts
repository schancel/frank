/**
 * A "Frank identity" for a headless client (ticket #9): a secp256k1 keypair, a Lotus-style
 * address derived from it (matching `bitcoinsuite_core::LotusAddress` byte-for-byte -- see
 * `lotusAddressFromPubKeyHash`'s doc comment for the verified test vectors), and the two HTTP calls
 * needed to register/look up that identity against a live `cashweb-registry` server: `PUT`/`GET
 * /metadata/:addr` (the same route ticket #8's `e2e_demo_register_identity.rs` example exercises,
 * here reimplemented client-side in TS since no TS client for this route existed yet -- checked:
 * `../registry/index.ts`'s `RegistryHandler` targets the old, pre-Monad `/keys/:address` route,
 * a different wire shape entirely).
 *
 * ## Why a from-scratch Lotus address encoder, rather than `bitcore-lib-xpi`'s own `Address`
 *
 * `bitcore-lib-xpi`'s `Address`/`toCashAddress()`/`toXAddress()` implement BCH-style CashAddr
 * (bech32-like, with its own checksum), which is a *different* encoding from
 * `bitcoinsuite_core::LotusAddress` (base58, with a SHA256-prefix checksum) -- the format the live
 * registry's `/metadata/:addr` route actually parses (`LotusAddress::from_str`, `backend/
 * bitcoinsuite/bitcoinsuite-core/src/address/lotusaddress.rs`). `computeLotusAddress` below
 * reimplements that exact algorithm (verified against that file's own `#[test] fn
 * decode_lotus_address` vectors -- see the doc comment there) rather than trying to coerce
 * `bitcore-lib-xpi`'s CashAddr encoder into producing it.
 *
 * ## Why ECDSA (not Schnorr), and why a DER signature (not bitcore's 65-byte "compact" form)
 *
 * `cashweb_payload::verify::SignedPayload::verify` calls `ecc.verify(&pubkey, msg, &self.sig)` for
 * `SignatureScheme::Ecdsa`, and `EccSecp256k1::verify` (`backend/bitcoinsuite/
 * bitcoinsuite-ecc-secp256k1/src/lib.rs`) does `Signature::from_der(sig)` -- a *DER*-encoded
 * signature, not the 65-byte recoverable "compact" form `../registry/index.ts`'s (legacy, `/keys/
 * :address`-targeting) `constructRelayUrlMetadata` builds via `signature.toCompact(1,
 * true).slice(1)`. `signHash` calls `@frank/nakamoto` `signEcdsa`, which returns
 * that DER encoding. Address layout in this file is unchanged (decision #499).
 * Pubkey HASH160, the checksum, and the metadata payload digest use
 * `@frank/nakamoto` `cryptoBackend`.
 */
import { randomBytes } from 'crypto'

import {
  cryptoBackend,
  encodeAddress,
  privateKeyFromHex,
  privateKeyFromSecretBytes,
  pubkeyHashFromBytes,
  signEcdsa,
  XPI_MAINNET,
  XPI_REGTEST,
  XPI_TESTNET,
  type ChainDescriptor,
} from '@frank/nakamoto'
import { lotusIdentityPublicKey } from './lotus-identity-pubkey'
import axios from 'axios'
import { relayOriginHeader } from '../relay/origin-header'

import __pb_registry_metadata_pb from '../registry/metadata_pb'
const { AddressMetadata } = __pb_registry_metadata_pb
import __pb_signed_payload_payload_pb from '../signed_payload/payload_pb'
const { SignedPayload } = __pb_signed_payload_payload_pb

/** Name the relay still passes to bitcore. This module does not construct a key from it. */
export const IDENTITY_KEY_NETWORK_NAME = 'lotus-identity'

/** `bitcoinsuite_core::Net` mirrored here -- selects the Lotus address's net character (`'_'` for
 * mainnet, `'R'` for regtest) per `LotusAddress::new`. */
export type LotusNet = 'mainnet' | 'regtest'

/** `bitcoinsuite_core::LOTUS_PREFIX`. */
export const LOTUS_PREFIX = 'lotus'

const BASE58_ALPHABET =
  '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'

/** Bitcoin-style base58 (no built-in checksum -- the Lotus address checksum is computed and
 * appended by the caller, see `computeLotusAddress`) of arbitrary bytes. Deliberately
 * self-contained (a `BigInt`-based encode loop) rather than reaching for `bitcore-lib-xpi`'s own
 * `encoding.Base58` (not declared in this app's hand-written `bitcore-lib-xpi.d.ts` shim -- see
 * this file's header) or a new npm dependency. */
export function base58Encode(bytes: Uint8Array): string {
  let leadingZeros = 0
  while (leadingZeros < bytes.length && bytes[leadingZeros] === 0) {
    leadingZeros++
  }
  let num = BigInt(0)
  for (const byte of bytes) {
    num = (num << BigInt(8)) + BigInt(byte)
  }
  let encoded = ''
  const base = BigInt(58)
  while (num > BigInt(0)) {
    const remainder = Number(num % base)
    encoded = BASE58_ALPHABET[remainder] + encoded
    num = num / base
  }
  return '1'.repeat(leadingZeros) + encoded
}

function sha256(bytes: Uint8Array): Buffer {
  // cryptoBackend rejects Buffer, which is a Uint8Array subclass.
  return Buffer.from(cryptoBackend.sha256(Uint8Array.from(bytes)))
}

/** HASH160 of the key bytes passed in. Matches bitcore `sha256ripemd160` and
 * `Sha256Ripemd160::hash_pubkey`. */
export function pubKeyHash160(pubKeyCompressed: Buffer): Buffer {
  return Buffer.from(cryptoBackend.hash160(Uint8Array.from(pubKeyCompressed)))
}

export function chainForNetworkName(networkName: string): ChainDescriptor {
  if (networkName === 'testnet' || networkName === 'cash-testnet') {
    return XPI_TESTNET
  }
  if (networkName === 'regtest') return XPI_REGTEST
  if (
    networkName === 'livenet' ||
    networkName === 'mainnet' ||
    networkName === 'cash-livenet' ||
    networkName === 'cash-mainnet'
  ) {
    return XPI_MAINNET
  }
  throw new Error(`lotus-network:${networkName}`)
}

export function lotusP2pkhFromHash(
  hash: Uint8Array,
  networkName: string,
): string {
  const branded = pubkeyHashFromBytes(Uint8Array.from(hash))
  if (!branded.ok) throw new Error('address-hash')
  const encoded = encodeAddress(
    { kind: 'p2pkh', hash: branded.value },
    chainForNetworkName(networkName),
    'lotus',
  )
  if (!encoded.ok) throw new Error(encoded.error.code)
  return encoded.value
}

/**
 * P2PKH Lotus address. pkh `b50b86a893d80c9e2ee72b199612374b7b4c1cd8` is
 * `lotus_16PSJNf1EDEfGvaYzaXJCJZrXH4pgiTo7kyW61iGi` on mainnet and
 * `lotusR16PSJNf1EDEfGvaYzaXJCJZrXH4pgiTo7kyVqAied` on regtest.
 * A hash that is not 20 bytes throws.
 */
export function lotusAddressFromPubKeyHash(
  pubKeyHash20: Buffer,
  net: LotusNet,
): string {
  return lotusP2pkhFromHash(
    pubKeyHash20,
    net === 'mainnet' ? 'mainnet' : 'regtest',
  )
}

/** HASH160 of `pubKeyCompressed`, then `lotusAddressFromPubKeyHash`. */
export function computeLotusAddress(
  pubKeyCompressed: Buffer,
  net: LotusNet,
): string {
  return lotusAddressFromPubKeyHash(pubKeyHash160(pubKeyCompressed), net)
}

/** Stop if every draw is 0 or >= n. A working RNG hits that with negligible probability. */
const SECRET_DRAWS = 64

/** A Frank identity: an owned 32-byte secp256k1 secret (decision #584), compressed, plus its
 * derived Lotus address (see `computeLotusAddress`). Not a bitcore PrivateKey. */
export class FrankIdentity {
  readonly #secret: Uint8Array
  readonly net: LotusNet
  readonly pubKey: Buffer
  readonly address: string

  private constructor(secret: Uint8Array, net: LotusNet) {
    const owned = Uint8Array.from(secret)
    const key = privateKeyFromSecretBytes(owned, true)
    if (!key.ok) {
      owned.fill(0)
      throw new Error(`lotus-identity:${key.error.code}`)
    }
    key.value.bytes.fill(0)
    this.#secret = owned
    this.net = net
    this.pubKey = Buffer.from(lotusIdentityPublicKey(this.#secret, true))
    this.address = computeLotusAddress(this.pubKey, net)
  }

  static generate(net: LotusNet): FrankIdentity {
    for (let draw = 0; draw < SECRET_DRAWS; draw += 1) {
      const drawn = randomBytes(32)
      const secret = Uint8Array.from(drawn)
      drawn.fill(0)
      try {
        const key = privateKeyFromSecretBytes(secret, true)
        if (!key.ok) continue
        try {
          return new FrankIdentity(key.value.bytes, net)
        } finally {
          key.value.bytes.fill(0)
        }
      } finally {
        secret.fill(0)
      }
    }
    throw new Error('lotus-identity:exhausted')
  }

  /** 64 hex characters, no `0x` prefix, compressed. Not 32 bytes, 0, or >= n throws. */
  static fromPrivateKeyHex(hex: string, net: LotusNet): FrankIdentity {
    const key = privateKeyFromHex(hex, true)
    if (!key.ok) throw new Error(`lotus-identity:${key.error.code}`)
    try {
      return new FrankIdentity(key.value.bytes, net)
    } finally {
      key.value.bytes.fill(0)
    }
  }

  /** Hex of the owned 32-byte secret. Copies only. Does not wipe a caller's buffer. */
  toPrivateKeyHex(): string {
    const copy = Buffer.from(this.#secret)
    const hex = copy.toString('hex')
    copy.fill(0)
    return hex
  }

  /** DER-encoded ECDSA signature over a 32-byte `hash`. A bad digest throws. */
  signHash(hash: Buffer): Buffer {
    if (hash.length !== 32) throw new Error('sign-digest')
    const secretBytes = Uint8Array.from(this.#secret)
    const key = privateKeyFromSecretBytes(secretBytes, true)
    secretBytes.fill(0)
    if (!key.ok) throw new Error(key.error.code)
    try {
      const signed = signEcdsa(key.value, Uint8Array.from(hash))
      if (!signed.ok) throw new Error(signed.error.code)
      return Buffer.from(signed.value)
    } finally {
      key.value.bytes.fill(0)
    }
  }
}

/** Builds and signs the `cashweb_payload::proto::SignedPayload` wrapper (field-number-compatible
 * with this app's `SignedPayload` -- see `payload_pb`'s own `.proto`) around a fresh, empty
 * `AddressMetadata` -- the same "no vCard content, just proving registration itself" shape
 * `e2e_demo_register_identity.rs` uses. `burn_txs`/`transactions` is left empty: `SignedPayload::
 * verify`'s burn-commitment check loops over `burn_txs` and is vacuously satisfied by an empty
 * list (confirmed by reading `cashweb-payload/src/verify.rs`), and `Registry::put_metadata`'s
 * `validate_burn_txs` likewise no-ops on an empty slice -- so, with POP disabled (ticket #35's
 * default, as this ticket's whole demo relies on), no burn transaction needs to be fabricated at
 * all (unlike the Rust example, which builds one anyway for parity with `pop_live_smoke.rs`'s
 * needs -- not required here). */
function buildSignedAddressMetadata(identity: FrankIdentity): Buffer {
  const metadata = new AddressMetadata()
  metadata.setTimestamp(Date.now())
  metadata.setTtl(1000 * 60 * 60 * 24 * 365) // 1 year, in milliseconds
  metadata.setEntriesList([])
  const serializedPayload = Buffer.from(metadata.serializeBinary())
  const payloadHash = sha256(serializedPayload)

  const signedPayload = new SignedPayload()
  signedPayload.setPublicKey(identity.pubKey)
  signedPayload.setPayload(serializedPayload)
  signedPayload.setPayloadDigest(payloadHash)
  signedPayload.setScheme(SignedPayload.SignatureScheme.ECDSA)
  signedPayload.setBurnAmount(0)
  signedPayload.setTransactionsList([])
  signedPayload.setSignature(identity.signHash(payloadHash))
  return Buffer.from(signedPayload.serializeBinary())
}

/**
 * `PUT /metadata/:addr` (no POP payment proof -- see this ticket's runbook,
 * `backend/cashweb/cashweb-registry/examples/README.md`, step 2 for the Rust-side precedent this
 * mirrors). Requires an `Origin` header: `RelayInfo::parse_from_headers`
 * (`backend/cashweb/cashweb-registry/src/p2p/relay_info.rs`) fails the whole request with
 * `MissingOrigin` otherwise -- confirmed by reading that function, and matching
 * `e2e_demo_register_identity.rs`'s own `.header(ORIGIN, "http://e2e-demo.local")`.
 */
export async function registerIdentity(params: {
  relayBaseUrl: string
  identity: FrankIdentity
}): Promise<void> {
  const body = buildSignedAddressMetadata(params.identity)
  await axios({
    method: 'put',
    url: `${params.relayBaseUrl.replace(/\/+$/, '')}/metadata/${
      params.identity.address
    }`,
    data: body,
    headers: {
      'Content-Type': 'application/x-protobuf',
      ...relayOriginHeader('http://qwen-bot.frank.local'),
    },
  })
}

/** `GET /metadata/:addr`: fetches a previously-registered identity's `SignedPayload` (mainly for
 * its `pubkey`, needed to derive an ECDH shared key with that identity -- see
 * `./monad-message-envelope.ts`). Returns `undefined` on a `404`. */
export async function fetchIdentityPubKey(params: {
  relayBaseUrl: string
  address: string
}): Promise<Buffer | undefined> {
  try {
    const response = await axios({
      method: 'get',
      url: `${params.relayBaseUrl.replace(/\/+$/, '')}/metadata/${
        params.address
      }`,
      responseType: 'arraybuffer',
    })
    const signedPayload = SignedPayload.deserializeBinary(
      new Uint8Array(response.data),
    )
    return Buffer.from(signedPayload.getPublicKey_asU8())
  } catch (err) {
    if (axios.isAxiosError(err) && err.response?.status === 404) {
      return undefined
    }
    throw err
  }
}
