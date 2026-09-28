/**
 * A Monad-native "Frank identity" (ticket #41 -- see `PLAN.md`'s M9 section): a secp256k1 keypair,
 * its Monad (EVM, EIP-55 checksummed) address, and the two HTTP calls needed to register/look up
 * that identity against a live `cashweb-registry` server: `PUT`/`GET /metadata/:addr` -- the exact
 * same route `./lotus-identity.ts`'s `registerIdentity`/`fetchIdentityPubKey` (ticket #9) already
 * use, mirrored here address-format-agnostically.
 *
 * ## Why this file exists alongside `lotus-identity.ts`, and why it has no Lotus encoding
 *
 * `lotus-identity.ts` is *not* chain-agnostic despite its name: `FrankIdentity.address` is a
 * `computeLotusAddress`-encoded base58 string (`LOTUS_PREFIX = 'lotus'`), and that whole module's
 * point is byte-for-byte parity with `bitcoinsuite_core::LotusAddress`. There was no Monad-native
 * equivalent before this ticket. `MonadIdentity.address` here is a plain EIP-55 checksummed
 * `0x...` string (`ethers.Wallet.address`) -- no base58, no `LOTUS_PREFIX`, no
 * `bitcoinsuite_core` byte-for-byte parity requirement anywhere in this file.
 *
 * ## Formerly a known gap, fixed by ticket #45
 *
 * `handle_put_registry`/`handle_get_registry` (`backend/cashweb/cashweb-registry/src/http/
 * server.rs`) originally only accepted `LotusAddress`-parseable `:addr` values, so
 * `registerMonadIdentity`/`fetchMonadIdentityPubKey` below 400'd with `InvalidAddress` against a
 * real `0x...` address on a live relay -- this file's client code was written ahead of that backend
 * gap being closed (ticket #41's own explicit, documented tradeoff at the time). Ticket #45 (Monad
 * profile registration) fixed this for real: both handlers now try `MonadAddress::from_str` first
 * and dispatch to `Registry::put_monad_profile`/`get_monad_profile` when it parses, falling back to
 * `LotusAddress` only otherwise -- verified end-to-end against a live relay as part of that ticket.
 * `registerMonadIdentity`/`fetchMonadIdentityPubKey` need no changes here; they were always correct
 * client-side, just blocked on the server catching up.
 *
 * ## Reusing `bitcore-lib-xpi`'s ECDH/AES/ECDSA code without any Lotus addressing
 *
 * `./monad-message-envelope.ts` (ticket #9) already implements this codebase's ECDH+AES-256-CBC
 * scheme on top of `bitcore-lib-xpi`'s `PrivateKey`/`PublicKey` -- but purely as a secp256k1
 * elliptic-curve-math + symmetric-crypto vehicle already in this codebase's dependency tree, not
 * because Lotus addressing is fundamentally involved (that module never calls
 * `computeLotusAddress`, and its envelope's `from`/`to` fields are plain, format-agnostic
 * strings). secp256k1 is the same curve Monad/Ethereum accounts use, so the *same raw 32-byte
 * private key* this module derives via `ethers` HD derivation can be wrapped in a
 * `bitcore-lib-xpi` `PrivateKey` purely to reuse that existing ECDH code (`toBitcorePrivateKey`
 * below) and `bitcore-lib-xpi`'s DER ECDSA signer (`signHash`, for `AddressMetadata` registration
 * signatures -- same `SignedPayload.SignatureScheme.ECDSA`/DER-not-compact reasoning
 * `lotus-identity.ts`'s own header documents) -- with the *address* itself always computed the
 * plain EVM way, never through any Lotus/base58/cashaddr path.
 *
 * ## Identity key derivation path, and why it's reserved separately from the burner pool
 *
 * `./monad-hd-keyring.ts`'s `MonadHdKeyring` derives disposable, spend-once burn sub-accounts at
 * `m/44'/60'/0'/0/{index}` (`change = 0`), managed by `MonadSubAccountPool`
 * (`ensureSize`/`selectForStamp`), which retires each one after a single burn and never reuses it
 * (ticket #34). A stable identity address -- the one others register a Stamp message against or
 * resolve a profile lookup for -- must never be at risk of being spent/retired that way. Rather
 * than reusing pool index 0 for double duty (which `MonadSubAccountPool.ensureSize()` would then
 * also register as an ordinary, poolable burner account, risking `selectForStamp()` eventually
 * handing it out for an unrelated burn), this module derives the identity key at its own reserved
 * path, `m/44'/60'/1'/0/0` -- deterministic from the same `HDSeed` `../chain/active-chain.ts`
 * defines, but under a distinct hardened account index (`1'`) so it's structurally outside BOTH
 * `monad-hd-keyring.ts`'s burner-pool range (`m/44'/60'/0'/0/i`) and `monad-change-keyring.ts`'s
 * change-account range (`m/44'/60'/0'/1/i`, ticket #36).
 *
 * **Correction (caught in review, before this collided with anything live):** an earlier revision
 * of this file used `m/44'/60'/0'/1/0` (`change = 1`, index 0), reasoning it was safely outside
 * the burner pool's `change = 0` range -- true, but it missed that ticket #36's change-account
 * branch already claims the entire `change = 1` range, and `changeAccountPath(0)` derives that
 * exact same path. Two structurally unrelated keys (the stable identity, and the first swept
 * burn-account's change destination) would have been the literal same private key. Bumping the
 * account-index level instead of reusing the change field avoids this without touching
 * `monad-hd-keyring.ts` or `monad-change-keyring.ts` at all.
 *
 * This is a judgment call: issue #41's own interface sketch didn't specify a derivation path for
 * `createWallet`'s identity field, and the pre-existing Lotus precedent
 * (`qwen-bot-common.ts`'s `loadOrCreateIdentity`) sidesteps the question entirely by using a wholly
 * separate, independently-random `FrankIdentity` with no HD relationship to the burn pool at all.
 * This module instead keeps the identity HD-deterministic from the same seed `createWallet`
 * receives, for a "one seed backs up everything" property the independently-random Lotus precedent
 * doesn't have.
 */
import {
  HDNodeWallet,
  Mnemonic,
  Wallet,
  getBytes,
  hexlify,
  randomBytes,
} from 'ethers'
import { PrivateKey, crypto as bitcoreCrypto } from 'bitcore-lib-xpi'
import axios from 'axios'

import __pb_registry_metadata_pb from '@frank/cashweb/registry/metadata_pb'
const { AddressMetadata, ListMonadProfilesResponse } = __pb_registry_metadata_pb
import __pb_signed_payload_payload_pb from '@frank/cashweb/signed_payload/payload_pb'
const { SignedPayload } = __pb_signed_payload_payload_pb
import { ChainAddress, HDSeed, ProfileInfo } from './chain/active-chain'
import type { FrankIdentityHandle } from './chain/active-chain'

/** Reserved BIP-44 path (account index `1'`) for the stable Frank identity key -- see this file's
 * header for why it's kept structurally separate from both `monad-hd-keyring.ts`'s burner
 * sub-account branch (`m/44'/60'/0'/0/i`) and `monad-change-keyring.ts`'s change-account branch
 * (`m/44'/60'/0'/1/i`, ticket #36). */
export const MONAD_IDENTITY_DERIVATION_PATH = "m/44'/60'/1'/0/0"

/** A Monad-native Frank identity: a secp256k1 keypair plus its EIP-55 checksummed address (see
 * this file's header). Implements `FrankIdentityHandle` (`../chain/active-chain.ts`) so it can be
 * used directly as `WalletHandle.identity`, while exposing the extra private-key-backed methods
 * (`signHash`/`toBitcorePrivateKey`) `../chain/monad-chain.ts` needs internally. */
export class MonadIdentity implements FrankIdentityHandle {
  readonly address: ChainAddress
  readonly displayAddress: string
  private readonly wallet: Wallet

  private constructor(wallet: Wallet) {
    this.wallet = wallet
    this.address = { raw: wallet.address }
    this.displayAddress = wallet.address
  }

  /** Derives the identity key deterministically from `seed`, at
   * `MONAD_IDENTITY_DERIVATION_PATH` -- see this file's header. */
  static fromSeed(seed: HDSeed): MonadIdentity {
    const computedSeed = Mnemonic.fromPhrase(
      seed.mnemonic,
      seed.passphrase ?? '',
    ).computeSeed()
    const node = HDNodeWallet.fromSeed(computedSeed).derivePath(
      MONAD_IDENTITY_DERIVATION_PATH,
    )
    return new MonadIdentity(new Wallet(node.privateKey))
  }

  /** Rebuilds a previously-generated identity from its raw `0x`-prefixed private key hex. */
  static fromPrivateKeyHex(privateKeyHex: string): MonadIdentity {
    return new MonadIdentity(new Wallet(privateKeyHex))
  }

  /** A fresh, independently-random identity with no HD relationship to any seed/burn pool --
   * mirrors `lotus-identity.ts`'s `FrankIdentity.generate`, for callers (e.g. the Qwen bot,
   * `qwen-bot-common.ts`) that need a standalone identity, not one derived from a wallet's own
   * seed via `fromSeed`. Goes through `fromPrivateKeyHex` rather than wrapping
   * `Wallet.createRandom()`'s result directly: that returns an `HDNodeWallet`, a sibling type of
   * `Wallet` in ethers v6 (not a subtype), which this class's private field isn't typed for. */
  static generate(): MonadIdentity {
    return MonadIdentity.fromPrivateKeyHex(hexlify(randomBytes(32)))
  }

  /** Raw `0x`-prefixed private key -- for persisting between runs. Never logged/serialized by this
   * class itself. */
  toPrivateKeyHex(): string {
    return this.wallet.privateKey
  }

  /** Compressed (33-byte) secp256k1 public key -- the form the registry's `PubKeyHash`/`Registry`
   * store expects (mirrors `lotus-identity.ts`'s own `FrankIdentity.pubKey`). */
  get compressedPubKey(): Buffer {
    return Buffer.from(getBytes(this.wallet.signingKey.compressedPublicKey))
  }

  /** DER-encoded ECDSA signature over `hash`, via this identity's key -- the signature scheme
   * `cashweb_payload::verify::SignedPayload::verify` expects for `SignatureScheme::Ecdsa` (see
   * `lotus-identity.ts`'s header for why DER, not a 65-byte recoverable form). Delegates to
   * `bitcore-lib-xpi`'s ECDSA signer purely for its DER encoder -- no Lotus addressing involved
   * (see this file's header). */
  signHash(hash: Buffer): Buffer {
    const signature = bitcoreCrypto.ECDSA.sign(hash, this.toBitcorePrivateKey())
    return (signature as unknown as { toDER(): Buffer }).toDER()
  }

  /** Wraps this identity's raw private key in a `bitcore-lib-xpi` `PrivateKey`, purely to reuse
   * `./monad-message-envelope.ts`'s existing ECDH implementation (see this file's header) -- never
   * used for Lotus address derivation. */
  toBitcorePrivateKey(): PrivateKey {
    return new PrivateKey(this.wallet.privateKey.slice(2))
  }
}

/** Builds and signs the `cashweb_payload::proto::SignedPayload` wrapper around a fresh, empty
 * `AddressMetadata` -- the same "no vCard content, just proving registration itself" shape
 * `lotus-identity.ts`'s `buildSignedAddressMetadata` uses (see that function's doc comment for why
 * an empty `burn_txs`/`transactions` list is sufficient with POP disabled). */
function buildSignedAddressMetadata(identity: MonadIdentity): Buffer {
  const metadata = new AddressMetadata()
  metadata.setTimestamp(Date.now())
  metadata.setTtl(1000 * 60 * 60 * 24 * 365) // 1 year, in milliseconds
  metadata.setEntriesList([])
  const serializedPayload = Buffer.from(metadata.serializeBinary())
  const payloadHash = bitcoreCrypto.Hash.sha256(serializedPayload)

  const signedPayload = new SignedPayload()
  signedPayload.setPublicKey(identity.compressedPubKey)
  signedPayload.setPayload(serializedPayload)
  signedPayload.setPayloadDigest(payloadHash)
  signedPayload.setScheme(SignedPayload.SignatureScheme.ECDSA)
  signedPayload.setBurnAmount(0)
  signedPayload.setTransactionsList([])
  signedPayload.setSignature(identity.signHash(payloadHash))
  return Buffer.from(signedPayload.serializeBinary())
}

/** `PUT /metadata/:addr` (no POP payment proof) -- mirrors `lotus-identity.ts`'s
 * `registerIdentity` exactly, just Monad-addressed. See this file's header for the live backend
 * gap (`LotusAddress`-only address parsing) this inherits until the server grows a Monad-native
 * path. Requires an `Origin` header -- `RelayInfo::parse_from_headers` fails the whole request
 * with `MissingOrigin` otherwise. */
export async function registerMonadIdentity(params: {
  relayBaseUrl: string
  identity: MonadIdentity
}): Promise<void> {
  const body = buildSignedAddressMetadata(params.identity)
  await axios({
    method: 'put',
    url: `${params.relayBaseUrl.replace(/\/+$/, '')}/metadata/${
      params.identity.address.raw
    }`,
    data: body,
    headers: {
      'Content-Type': 'application/x-protobuf',
      'Origin': 'http://frank.local',
    },
  })
}

/** `GET /metadata/:addr`: fetches a previously-registered identity's `SignedPayload` (mainly for
 * its `pubkey`, needed to derive an ECDH shared key with that identity -- see
 * `./monad-message-envelope.ts`). Returns `undefined` on a `404`. Mirrors `lotus-identity.ts`'s
 * `fetchIdentityPubKey` exactly, just taking/returning a Monad `ChainAddress`. */
export async function fetchMonadIdentityPubKey(params: {
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

/** `MonadChain.fetchProfile`'s real implementation: resolves `address`'s registered pubkey via
 * `fetchMonadIdentityPubKey` and wraps it as a `ProfileInfo` (`../chain/active-chain.ts`). Returns
 * `undefined` if nothing is registered under `address` yet. */
export async function fetchMonadProfile(params: {
  relayBaseUrl: string
  address: ChainAddress
}): Promise<ProfileInfo | undefined> {
  const pubKey = await fetchMonadIdentityPubKey({
    relayBaseUrl: params.relayBaseUrl,
    address: params.address.raw,
  })
  if (pubKey === undefined) return undefined
  return { address: params.address, pubKey: new Uint8Array(pubKey) }
}

/** One entry of `fetchMonadProfilesSince`'s result: a registered Monad profile's address, paired
 * with its full `SignedPayload` envelope exactly as `fetchMonadIdentityPubKey`/`GET
 * /metadata/monad/:addr` would return for that address alone (ticket #77). */
export interface MonadProfileListingEntry {
  address: string
  // `InstanceType<typeof SignedPayload>`, not a bare `SignedPayload` type reference: the
  // commonjs-default-import + destructure pattern this file uses for generated `_pb` bindings
  // (see the `__pb_signed_payload_payload_pb` import above) only preserves `SignedPayload` as a
  // value binding, not a type -- using it bare here would hit the same pre-existing `TS2749`
  // ("refers to a value, but is being used as a type") already present elsewhere in this package
  // for other generated proto classes (e.g. `monad-topic-post-client.ts`'s
  // `StoredMonadTopicPost`/`BroadcastEntry`, `monad-topic-tally-client.ts`'s
  // `MonadTopicPostView`) -- not introduced fresh here.
  signedPayload: InstanceType<typeof SignedPayload>
}

/** `GET /metadata/monad?since=<sinceMs>` (ticket #75's endpoint, ticket #77's client): every
 * Monad profile registered at or after `sinceMs` (milliseconds since the Unix epoch), ordered by
 * registration timestamp ascending -- mirrors `fetchMonadMessagesSince`'s
 * (`../cashweb/relay/monad-message-feed.ts`, ticket #37) identical "since cursor" shape for
 * messages, letting a caller (e.g. the Qwen bot, ticket #77) discover newly-registered identities
 * by polling with an advancing cursor.
 *
 * `ListMonadProfilesEntry.signed_payload` (`@frank/cashweb/registry/metadata_pb`) is a raw
 * `bytes` field client-side, not a nested message type -- see `metadata.proto`'s doc comment on
 * that message for why (wire-identical to the backend's embedded-message field either way) -- so
 * it's decoded here via `SignedPayload.deserializeBinary` rather than a nested-message getter. */
export async function fetchMonadProfilesSince(params: {
  relayBaseUrl: string
  sinceMs: number
}): Promise<MonadProfileListingEntry[]> {
  const response = await axios({
    method: 'get',
    url: `${params.relayBaseUrl.replace(/\/+$/, '')}/metadata/monad`,
    params: { since: params.sinceMs },
    responseType: 'arraybuffer',
  })
  const decoded = ListMonadProfilesResponse.deserializeBinary(
    new Uint8Array(response.data),
  )
  return decoded.getEntriesList().map(entry => ({
    address: entry.getAddress(),
    signedPayload: SignedPayload.deserializeBinary(
      entry.getSignedPayload_asU8(),
    ),
  }))
}

/** Server-side clamp on `searchMonadProfiles`'s `limit` -- mirrors
 * `cashweb-registry`'s `store::monad_profiles::MAX_SEARCH_RESULTS` (ticket #48). Not enforced
 * client-side (the relay clamps regardless of what's requested); kept here purely as a documented
 * reference for callers deciding what to ask for. */
export const MONAD_PROFILE_SEARCH_MAX_RESULTS = 100

/** `GET /metadata/monad/search?prefix=<text>&limit=<n>` (ticket #48): prefix-search registered
 * Monad profiles by their normalized (lowercased) `display_name`, matching case-insensitively.
 * `limit` defaults to the relay's own default (currently 20) when omitted, and is clamped to
 * `MONAD_PROFILE_SEARCH_MAX_RESULTS` server-side regardless of what's requested.
 *
 * Reuses `ListMonadProfilesResponse`/`MonadProfileListingEntry` -- the exact same wire shape
 * `fetchMonadProfilesSince` already decodes -- since a search result is just a differently
 * filtered list of the same `{address, signedPayload}` pairs; only the query differs, so this
 * mirrors that function's decode step closely rather than inventing a new shape.
 *
 * Unlike `fetchCuratedDefaultContacts`, this does *not* fail soft: mirrors
 * `fetchMonadProfilesSince`'s own convention of letting a network/decode error propagate to the
 * caller, since (like that function) there's no natural "empty" fallback that wouldn't silently
 * mask a broken relay from a caller that actually needs search results (e.g. a UI search box
 * should be able to distinguish "no matches" from "the request failed"). */
export async function searchMonadProfiles(params: {
  relayBaseUrl: string
  prefix: string
  limit?: number
}): Promise<MonadProfileListingEntry[]> {
  const response = await axios({
    method: 'get',
    url: `${params.relayBaseUrl.replace(/\/+$/, '')}/metadata/monad/search`,
    params: {
      prefix: params.prefix,
      ...(params.limit === undefined ? {} : { limit: params.limit }),
    },
    responseType: 'arraybuffer',
  })
  const decoded = ListMonadProfilesResponse.deserializeBinary(
    new Uint8Array(response.data),
  )
  return decoded.getEntriesList().map(entry => ({
    address: entry.getAddress(),
    signedPayload: SignedPayload.deserializeBinary(
      entry.getSignedPayload_asU8(),
    ),
  }))
}

/** One entry in the relay's operator-curated default-contacts list -- see
 * `fetchCuratedDefaultContacts`. Shape matches `stores/contacts.ts`'s `addDefaultContact` param
 * exactly (`{address, name}`), so callers can pass an entry straight through. */
export interface CuratedDefaultContact {
  address: string
  name: string
}

/** `GET /metadata/monad/curated-defaults` (ticket #49): fetches the relay's operator-curated
 * list of default contacts, shown to a fresh user before they've added anyone themselves.
 * Fails soft (empty array) on any error -- this is a nice-to-have UX seed, not something that
 * should ever block app startup if a relay is slow/down/misconfigured. */
export async function fetchCuratedDefaultContacts(params: {
  relayBaseUrl: string
}): Promise<CuratedDefaultContact[]> {
  try {
    const response = await axios({
      method: 'get',
      url: `${params.relayBaseUrl.replace(
        /\/+$/,
        '',
      )}/metadata/monad/curated-defaults`,
    })
    return response.data?.entries ?? []
  } catch (err) {
    console.error('failed to fetch curated default contacts', err)
    return []
  }
}
