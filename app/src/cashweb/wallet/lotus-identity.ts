/**
 * A "Frank identity" for a headless client (ticket #9): a secp256k1 keypair, a Lotus-style
 * address derived from it (matching `bitcoinsuite_core::LotusAddress` byte-for-byte -- see
 * `computeLotusAddress`'s doc comment for the verified test vectors), and the two HTTP calls
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
 * true).slice(1)`. `bitcore-lib-xpi`'s `crypto.Signature` supports both (`.toDER()`/`.toBuffer()`
 * are aliases; its own `.d.ts` shim only declares `.toCompact()`/`.toString()`, hence the narrow
 * `as unknown as { toDER(): Buffer }` cast below rather than editing that shared, merged .d.ts for
 * one extra method signature).
 */
import { PrivateKey, crypto as bitcoreCrypto } from 'bitcore-lib-xpi'
import axios from 'axios'

import __pb_registry_metadata_pb from '../registry/metadata_pb'
const { AddressMetadata } = __pb_registry_metadata_pb
import __pb_signed_payload_payload_pb from '../signed_payload/payload_pb'
const { SignedPayload } = __pb_signed_payload_payload_pb

/** Arbitrary, non-empty network name passed to `bitcore-lib-xpi`'s `PrivateKey`/`PayloadConstructor`
 * constructors. Never used for address encoding (see this file's header) -- only for `PrivateKey`'s
 * own internal bookkeeping (e.g. WIF prefix), which this module never calls either. */
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

/** `bitcoinsuite_core::Script::p2pkh` -- standard `OP_DUP OP_HASH160 <push 20> <pkh>
 * OP_EQUALVERIFY OP_CHECKSIG` (25 bytes). */
function p2pkhScript(pubKeyHash20: Buffer): Buffer {
  if (pubKeyHash20.length !== 20) {
    throw new Error(`pubKeyHash must be 20 bytes, got ${pubKeyHash20.length}`)
  }
  return Buffer.concat([
    Buffer.from([0x76, 0xa9, 0x14]),
    pubKeyHash20,
    Buffer.from([0x88, 0xac]),
  ])
}

/** Hash160 (`RIPEMD160(SHA256(x))`) of a compressed (33-byte) pubkey -- `PkhAlgorithm::
 * Sha256Ripemd160::hash_pubkey` (`backend/cashweb/cashweb-registry/src/store/pubkeyhash.rs`). */
export function pubKeyHash160(pubKeyCompressed: Buffer): Buffer {
  return bitcoreCrypto.Hash.sha256ripemd160(pubKeyCompressed)
}

/**
 * Reimplements `bitcoinsuite_core::LotusAddress::new` byte-for-byte: `<prefix><net_char>
 * <base58(payload_type=0 || p2pkh_script || checksum)>`, where `checksum =
 * SHA256(prefix || net_char || payload_type || p2pkh_script)[..4]`.
 *
 * Verified against that file's own test vectors (`#[test] fn decode_lotus_address`,
 * `backend/bitcoinsuite/bitcoinsuite-core/src/address/lotusaddress.rs`): for pkh
 * `b50b86a893d80c9e2ee72b199612374b7b4c1cd8`, this produces exactly
 * `lotus_16PSJNf1EDEfGvaYzaXJCJZrXH4pgiTo7kyW61iGi` (mainnet) and
 * `lotusR16PSJNf1EDEfGvaYzaXJCJZrXH4pgiTo7kyVqAied` (regtest) -- checked by hand (a Python
 * reimplementation of this exact algorithm) while writing this function, not merely assumed.
 */
export function computeLotusAddress(
  pubKeyCompressed: Buffer,
  net: LotusNet,
): string {
  const netChar = net === 'mainnet' ? '_' : 'R'
  const payloadType = 0
  const script = p2pkhScript(pubKeyHash160(pubKeyCompressed))
  const checksumPreimage = Buffer.concat([
    Buffer.from(LOTUS_PREFIX, 'ascii'),
    Buffer.from([netChar.charCodeAt(0), payloadType]),
    script,
  ])
  const checksum = bitcoreCrypto.Hash.sha256(checksumPreimage).slice(0, 4)
  const data = Buffer.concat([Buffer.from([payloadType]), script, checksum])
  return `${LOTUS_PREFIX}${netChar}${base58Encode(data)}`
}

/** A Frank identity: a secp256k1 keypair plus its derived Lotus address (see
 * `computeLotusAddress`). The same keypair is reused both to sign `AddressMetadata` registrations
 * (this file) and for ECDH message encryption (`./monad-message-envelope.ts`) -- mirroring how
 * `wallet.identityPrivKey` is already a single, dual-purpose key elsewhere in this codebase
 * (`../registry/index.ts`'s `updateKeyMetadata`/`createBroadcast`). */
export class FrankIdentity {
  readonly privateKey: PrivateKey
  readonly net: LotusNet
  readonly pubKey: Buffer
  readonly address: string

  constructor(privateKey: PrivateKey, net: LotusNet) {
    this.privateKey = privateKey
    this.net = net
    this.pubKey = privateKey.toPublicKey().toBuffer()
    this.address = computeLotusAddress(this.pubKey, net)
  }

  static generate(net: LotusNet): FrankIdentity {
    // No args: `bitcore-lib-xpi`'s `PrivateKey` constructor random-generates a fresh secp256k1
    // key and falls back to its own default network (`_classifyArguments`, `privatekey.js`) --
    // fine here since this identity's network never goes through `bitcore-lib-xpi`'s own address
    // encoding (see this file's header).
    return new FrankIdentity(new PrivateKey(), net)
  }

  /** Rebuilds a previously-generated identity from its raw 32-byte private key, hex-encoded
   * (no `0x` prefix).
   *
   * **Deliberately does *not* use `PrivateKey.fromBuffer`**: `bitcore-lib-xpi`'s
   * `PrivateKey._transformBNBuffer` (the path `fromBuffer` takes for a 32-byte buffer,
   * `local_modules/bitcore-lib-xpi/lib/privatekey.js`) hardcodes `compressed: false`, unlike
   * `_classifyArguments`'s hex-*string* path (used when the constructor's first argument is a
   * string, not a `Buffer`), which leaves `compressed` at its default of `true` (set at the top of
   * that same function). A 65-byte uncompressed pubkey from a reloaded identity would fail
   * `PUT /metadata/:addr`'s live `invalid-pub-key-len` check (`Registry`/`PubKeyHash` require the
   * 33-byte compressed form -- see `pubkeyhash.rs`'s `hash_pubkey(pubkey: [u8; 33])`) even though
   * the very same private key, freshly generated (`FrankIdentity.generate`, which goes through
   * `new PrivateKey()`'s no-args random-generation path -- compressed by default there too),
   * produces a valid 33-byte one -- confirmed live while testing this ticket's second bot run
   * (an identity reloaded from disk on restart hit exactly this `400 invalid-pub-key-len`, while
   * the freshly-generated one from the first run hadn't). Passing the hex *string* straight to the
   * constructor sidesteps `_transformBNBuffer` entirely. */
  static fromPrivateKeyHex(hex: string, net: LotusNet): FrankIdentity {
    const privateKey = new PrivateKey(hex)
    return new FrankIdentity(privateKey, net)
  }

  /** Raw 32-byte private key, hex-encoded -- for persisting to disk between runs (see
   * `qwen-bot.livecheck.ts`). */
  toPrivateKeyHex(): string {
    return this.privateKey.toBuffer().toString('hex')
  }

  /** DER-encoded ECDSA signature over `hash` (see this file's header for why DER, not bitcore's
   * compact form). */
  signHash(hash: Buffer): Buffer {
    const signature = bitcoreCrypto.ECDSA.sign(hash, this.privateKey)
    return (signature as unknown as { toDER(): Buffer }).toDER()
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
  const payloadHash = bitcoreCrypto.Hash.sha256(serializedPayload)

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
      'Origin': 'http://qwen-bot.frank.local',
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
