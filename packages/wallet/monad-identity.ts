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
 * ## Envelope ECDH without Lotus addressing
 *
 * `../cashweb/relay/monad-message-envelope.ts` implements the current deniable v2 envelope:
 * secp256k1 ECDH, HKDF-SHA256, and AES-256-GCM with the network and routing tuple authenticated as
 * associated data. It retains AES-CBC v1 only as a read path for already-stored records. ECDH is
 * `@frank/nakamoto` `ecdh` of this identity's secret and the peer point. Lotus addressing is not
 * involved (that module never calls `computeLotusAddress`, and its envelope's `from`/`to` fields
 * are plain, format-agnostic strings). Routing and durable consumer keys treat valid 20-byte EVM
 * addresses case-independently even though this identity presents its preferred EIP-55 spelling.
 * secp256k1 is the same curve Monad/Ethereum accounts use, so the same raw 32-byte private key
 * this module derives via `ethers` is exposed as a compressed `@frank/nakamoto` private key
 * (`toNakamotoPrivateKey` below). `signHash` calls `@frank/nakamoto` `signingKey` (ECDSA, DER,
 * RFC6979 nonce) for `AddressMetadata` registration signatures. The payload digest is one
 * `cryptoBackend.sha256`, matching `Sha256::digest` in `verify_monad_profile`.
 * The *address* itself is always computed the
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
  computeAddress,
  getBytes,
  hexlify,
  randomBytes,
} from 'ethers'
import {
  cryptoBackend,
  privateKeyFromHex,
  signingKey,
  type PrivateKey,
} from '@frank/nakamoto'
import axios from 'axios'

import type { MailboxAuthParams } from '@frank/cashweb/relay/monad-mailbox-client'
import { relayOriginHeader } from '@frank/cashweb/relay/origin-header'

import {
  AccountType,
  BotRole,
  ACCOUNT_TYPE_PERSON,
  ACCOUNT_TYPE_BOT,
  ACCOUNT_TYPE_SERVICE,
  ACCOUNT_TYPE_ORGANIZATION,
  BOT_ROLE_GENERIC,
  Encodable,
  cborMap,
  compareAccounts,
  compareBytes,
  defaultContext,
  directorySignatureDigest,
  encodeFrame,
  expiryTimestamp,
  splitMs,
  validateFrame,
} from '@frank/codec'

import __pb_registry_metadata_pb from '@frank/cashweb/registry/metadata_pb'
const { AddressMetadata, Entry, Header, ListMonadProfilesResponse } =
  __pb_registry_metadata_pb
import __pb_signed_payload_payload_pb from '@frank/cashweb/signed_payload/payload_pb'
const { SignedPayload } = __pb_signed_payload_payload_pb
import { ChainAddress, HDSeed, ProfileInfo } from './chain/active-chain'
import type { FrankIdentityHandle } from './chain/active-chain'
import {
  requireValidProfileDisplayName,
  validateProfileDisplayName,
} from './profile-display-name'
import { MonadDomainRoot, monadMasterFromDomainRoot } from './monad-domain-root'

/** Reserved BIP-44 path (account index `1'`) for the stable Frank identity key -- see this file's
 * header for why it's kept structurally separate from both `monad-hd-keyring.ts`'s burner
 * sub-account branch (`m/44'/60'/0'/0/i`) and `monad-change-keyring.ts`'s change-account branch
 * (`m/44'/60'/0'/1/i`, ticket #36). */
export const MONAD_IDENTITY_DERIVATION_PATH = "m/44'/60'/1'/0/0"

/** A Monad-native Frank identity: a secp256k1 keypair plus its EIP-55 checksummed address (see
 * this file's header). Implements `FrankIdentityHandle` (`../chain/active-chain.ts`) so it can be
 * used directly as `WalletHandle.identity`, while exposing the extra private-key-backed methods
 * (`signHash`/`toNakamotoPrivateKey`) `../chain/monad-chain.ts` needs internally. */
export class MonadIdentity implements FrankIdentityHandle {
  readonly address: ChainAddress
  readonly displayAddress: string
  private readonly wallet: Wallet

  private constructor(wallet: Wallet) {
    this.wallet = wallet
    this.address = { raw: wallet.address }
    this.displayAddress = wallet.address
  }

  /** Builds the authentication identity from its already-separated registry output. */
  static fromDomainRoot(
    domainRoot: MonadDomainRoot<'identity-authentication'>,
  ): MonadIdentity {
    const node = monadMasterFromDomainRoot(
      domainRoot,
      'identity-authentication',
    ).derivePath(MONAD_IDENTITY_DERIVATION_PATH)
    return new MonadIdentity(new Wallet(node.privateKey))
  }

  /** @deprecated Legacy mnemonic derivation. */
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

  /** DER-encoded ECDSA signature over a 32-byte `hash`. A bad digest throws. */
  signHash(hash: Buffer): Buffer {
    if (hash.length !== 32) throw new Error('sign-digest')
    const key = this.toNakamotoPrivateKey()
    try {
      const signing = signingKey('ecdsa', key)
      if (!signing.ok) throw new Error(signing.error.code)
      return Buffer.from(signing.value.sign(Uint8Array.from(hash)))
    } finally {
      key.bytes.fill(0)
    }
  }

  /** Compressed `@frank/nakamoto` private key for Monad envelope ECDH. Not a Lotus address key.
   * Copies this wallet's 32-byte secret. The wallet key is not wiped. */
  toNakamotoPrivateKey(): PrivateKey {
    const key = privateKeyFromHex(this.wallet.privateKey.slice(2), true)
    if (!key.ok) throw new Error(key.error.code)
    return key.value
  }
}

/** Mailbox authentication bundle for `identity`'s own inbox on `relayBaseUrl`
 * (`@frank/cashweb/relay/monad-mailbox-client`): the relay verifies each private read against the
 * public key registered for this address, so this signs with the same DER-ECDSA identity key as
 * `registerMonadIdentity`. */
export function mailboxAuthFor(
  identity: MonadIdentity,
  relayBaseUrl: string,
): MailboxAuthParams {
  return {
    relayBaseUrl,
    recipient: identity.address.raw,
    signDigest: digest => identity.signHash(Buffer.from(digest)),
  }
}

export interface MonadProfileLink {
  type: string
  url: string
  label?: string
}

export function validateProfileUsername(raw?: string): {
  valid: boolean
  normalized?: string
  error?: string
} {
  if (raw === undefined || raw === null || raw.trim() === '') {
    return { valid: true, normalized: undefined }
  }
  const trimmed = raw.trim()
  const stripped = trimmed.startsWith('@') ? trimmed.slice(1) : trimmed
  const normalized = stripped.toLowerCase()
  if (normalized.length < 3 || normalized.length > 32) {
    return {
      valid: false,
      error: 'Username must be between 3 and 32 characters',
    }
  }
  if (!/^[a-z0-9]/.test(normalized)) {
    return {
      valid: false,
      error: 'Username must start with an alphanumeric character',
    }
  }
  if (!/^[a-z0-9_-]+$/.test(normalized)) {
    return {
      valid: false,
      error:
        'Username may only contain lowercase letters, numbers, hyphens, and underscores',
    }
  }
  return { valid: true, normalized }
}

/** Builds and signs the `cashweb_payload::proto::SignedPayload` wrapper around a fresh, empty
 * `AddressMetadata` -- the same "no vCard content, just proving registration itself" shape
 * `lotus-identity.ts`'s `buildSignedAddressMetadata` uses (see that function's doc comment for why
 * an empty `burn_txs`/`transactions` list is sufficient with POP disabled). */
export interface MonadProfileFields {
  name?: string
  username?: string
  bio?: string
  location?: string
  links?: MonadProfileLink[]
  avatar?: string
  /** Marks the profile as an automated account (#311). */
  bot?: boolean
  /** Account type (ticket #1120). 0=person, 1=bot, 2=service, 3=org. Defaults to person (0). */
  accountType?: AccountType
  /** Specialized bot or service role (ticket #1120). 0..7. */
  botRole?: BotRole
}

/** `Entry.kind` of the self-declared "this account is a bot" profile marker (#311). */
export const MONAD_PROFILE_BOT_KIND = 'bot'

/** Whether a profile represents an automated account (bot or service) (ticket #1120). */
export function isBotAccount(profile?: {
  accountType?: AccountType
  bot?: boolean
}): boolean {
  if (!profile) return false
  return (
    profile.accountType === ACCOUNT_TYPE_BOT ||
    profile.accountType === ACCOUNT_TYPE_SERVICE ||
    profile.bot === true
  )
}

/** Whether a decoded profile `SignedPayload` carries the {@link MONAD_PROFILE_BOT_KIND} marker.
 * Unparseable payloads are not bots (callers that must fail closed handle lookup errors
 * themselves). */
export function isBotProfileSignedPayload(
  signedPayload: InstanceType<typeof SignedPayload>,
): boolean {
  try {
    return AddressMetadata.deserializeBinary(signedPayload.getPayload_asU8())
      .getEntriesList()
      .some(
        entry =>
          entry.getKind() === MONAD_PROFILE_BOT_KIND &&
          new TextDecoder().decode(entry.getBody_asU8()) === '1',
      )
  } catch {
    return false
  }
}

function profileEntries(profile: MonadProfileFields = {}) {
  const entries: InstanceType<typeof Entry>[] = []
  const addTextEntry = (kind: string, value?: string) => {
    if (!value) return
    const entry = new Entry()
    entry.setKind(kind)
    entry.setBody(new TextEncoder().encode(value))
    entries.push(entry)
  }

  // An empty or whitespace-only stored name means "never set" and is simply not signed; any
  // other invalid name (controls, over-long, lone surrogates) is refused per Decision #189.
  const displayName =
    profile.name === undefined ||
    !validateProfileDisplayName(profile.name).normalized
      ? undefined
      : requireValidProfileDisplayName(profile.name)
  addTextEntry('display_name', displayName)
  const username = validateProfileUsername(profile.username).normalized
  addTextEntry('username', username)
  addTextEntry('bio', profile.bio)
  if (profile.location && profile.location.trim().length > 0) {
    addTextEntry('location', profile.location.trim())
  }
  if (profile.links) {
    for (const link of profile.links) {
      if (!link.url || link.url.trim().length === 0) continue
      const entry = new Entry()
      entry.setKind('link')
      entry.setBody(new TextEncoder().encode(link.url.trim()))
      const typeHeader = new Header()
      typeHeader.setName('type')
      typeHeader.setValue(link.type || 'website')
      entry.addHeaders(typeHeader)
      if (link.label && link.label.trim().length > 0) {
        const labelHeader = new Header()
        labelHeader.setName('label')
        labelHeader.setValue(link.label.trim())
        entry.addHeaders(labelHeader)
      }
      entries.push(entry)
    }
  }
  if (profile.bot) addTextEntry(MONAD_PROFILE_BOT_KIND, '1')

  if (profile.avatar) {
    const match = /^data:([^;,]+);base64,(.+)$/.exec(profile.avatar)
    if (match) {
      const avatar = new Entry()
      avatar.setKind('avatar')
      avatar.setBody(Buffer.from(match[2], 'base64'))
      const contentType = new Header()
      contentType.setName('content-type')
      contentType.setValue(match[1])
      avatar.addHeaders(contentType)
      entries.push(avatar)
    }
  }
  return entries
}

/** One SHA-256 of AddressMetadata bytes. Matches `Sha256::digest` in
 * `verify_monad_profile`. Not double-SHA256. cryptoBackend rejects Buffer. */
export function monadProfilePayloadDigest(payload: Uint8Array): Uint8Array {
  return cryptoBackend.sha256(Uint8Array.from(payload))
}

function buildSignedAddressMetadata(
  identity: MonadIdentity,
  profile: MonadProfileFields = {},
): Buffer {
  const metadata = new AddressMetadata()
  metadata.setTimestamp(Date.now())
  metadata.setTtl(1000 * 60 * 60 * 24 * 365) // 1 year, in milliseconds
  metadata.setEntriesList(profileEntries(profile))
  const serializedPayload = Buffer.from(metadata.serializeBinary())
  const payloadHash = Buffer.from(monadProfilePayloadDigest(serializedPayload))

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

/**
 * Detects whether a byte buffer is a Frank CBOR frame starting with `FRNK\x01`.
 */
export function isCborFrame(bytes: Uint8Array): boolean {
  return (
    bytes.length >= 5 &&
    bytes[0] === 0x46 &&
    bytes[1] === 0x52 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x4b &&
    bytes[4] === 0x01
  )
}

/**
 * Builds a canonical Deterministic-CBOR signed account registration frame
 * (Type 2 DirectoryAttestation wrapping a Type 4 DirectoryStatement with schema 3).
 * Stage 10.6 signature is created using Algorithm 1 (secp256k1 ECDSA over SHA-256).
 */
export function buildSignedDirectoryStatement(
  identity: MonadIdentity,
  options: {
    network?: string
    profile?: MonadProfileFields
    timestampMs?: number
    ttlMs?: number
    stampKey?: Uint8Array
    spendKeys?: Array<{ keyType: number; keyBytes: Uint8Array }>
    curveKeys?: {
      secp256k1?: Uint8Array
      ed25519?: Uint8Array
    }
  } = {},
): Uint8Array {
  const network = options.network ?? 'monad-testnet'
  const ms = BigInt(options.timestampMs ?? Date.now())
  const ttlMs = BigInt(options.ttlMs ?? 1000 * 60 * 60 * 24 * 365) // 1 year
  const ts = splitMs(ms)
  const exp = expiryTimestamp(ms, ttlMs)
  const stampKeyBytes = options.stampKey ?? identity.compressedPubKey

  const rawSpendKeys: Array<{ keyType: number; keyBytes: Uint8Array }> = [
    ...(options.spendKeys ?? []),
  ]
  if (options.curveKeys?.secp256k1) {
    if (
      !rawSpendKeys.some(
        k =>
          k.keyType === 1 &&
          compareBytes(k.keyBytes, options.curveKeys!.secp256k1!) === 0,
      )
    ) {
      rawSpendKeys.push({ keyType: 1, keyBytes: options.curveKeys.secp256k1 })
    }
  }
  if (options.curveKeys?.ed25519) {
    if (
      !rawSpendKeys.some(
        k =>
          k.keyType === 2 &&
          compareBytes(k.keyBytes, options.curveKeys!.ed25519!) === 0,
      )
    ) {
      rawSpendKeys.push({ keyType: 2, keyBytes: options.curveKeys.ed25519 })
    }
  }
  if (
    (options.curveKeys || options.spendKeys) &&
    !rawSpendKeys.some(k => k.keyType === 1)
  ) {
    rawSpendKeys.push({ keyType: 1, keyBytes: new Uint8Array(identity.compressedPubKey) })
  }
  rawSpendKeys.sort(compareAccounts)

  // Default relay binding: required by Type 4 schema (min 1 relay).
  // Kept internal to maintain clean separation between relay-local profiles
  // and federation topology (#107, #108, #110).
  const relayBindings: Encodable[] = [
    cborMap([
      [0, new Uint8Array(16)],
      [1, 'https://relay1.frank.example/monad-testnet'],
      [
        2,
        cborMap([
          [0, 1],
          [1, Uint8Array.from(identity.compressedPubKey)],
        ]),
      ],
      [
        3,
        cborMap([
          [0, 2_000_000_000n],
          [1, 0],
        ]),
      ],
    ]),
  ]

  // Profile entries (field 9 in schema 3)
  const entries: Encodable[] = []
  const displayName =
    options.profile?.name === undefined ||
    !validateProfileDisplayName(options.profile.name).normalized
      ? undefined
      : requireValidProfileDisplayName(options.profile.name)
  if (displayName !== undefined) {
    entries.push(
      cborMap([
        [0, 'display_name'],
        [1, []],
        [2, new TextEncoder().encode(displayName)],
      ]),
    )
  }
  const username = validateProfileUsername(
    options.profile?.username,
  ).normalized
  if (username !== undefined) {
    entries.push(
      cborMap([
        [0, 'username'],
        [1, []],
        [2, new TextEncoder().encode(username)],
      ]),
    )
  }
  if (options.profile?.bio !== undefined && options.profile.bio.length > 0) {
    entries.push(
      cborMap([
        [0, 'bio'],
        [1, []],
        [2, new TextEncoder().encode(options.profile.bio)],
      ]),
    )
  }
  if (
    options.profile?.location !== undefined &&
    options.profile.location.trim().length > 0
  ) {
    entries.push(
      cborMap([
        [0, 'location'],
        [1, []],
        [2, new TextEncoder().encode(options.profile.location.trim())],
      ]),
    )
  }
  if (options.profile?.links) {
    for (const link of options.profile.links) {
      if (!link.url || link.url.trim().length === 0) continue
      const headersList: Encodable[] = [
        cborMap([
          [0, 'type'],
          [1, link.type || 'website'],
        ]),
      ]
      if (link.label && link.label.trim().length > 0) {
        headersList.push(
          cborMap([
            [0, 'label'],
            [1, link.label.trim()],
          ]),
        )
      }
      headersList.sort((a, b) => {
        const keyA = ((a as any).entries?.[0]?.[1] ?? '') as string
        const keyB = ((b as any).entries?.[0]?.[1] ?? '') as string
        return keyA < keyB ? -1 : keyA > keyB ? 1 : 0
      })
      entries.push(
        cborMap([
          [0, 'link'],
          [1, headersList],
          [2, new TextEncoder().encode(link.url.trim())],
        ]),
      )
    }
  }
  if (options.profile?.bot) {
    entries.push(
      cborMap([
        [0, MONAD_PROFILE_BOT_KIND],
        [1, []],
        [2, new TextEncoder().encode('1')],
      ]),
    )
  }
  if (options.profile?.avatar) {
    const match = /^data:([^;,]+);base64,(.+)$/.exec(options.profile.avatar)
    if (match) {
      entries.push(
        cborMap([
          [0, 'avatar'],
          [
            1,
            [
              cborMap([
                [0, 'content-type'],
                [1, match[1]],
              ]),
            ],
          ],
          [2, Uint8Array.from(Buffer.from(match[2], 'base64'))],
        ]),
      )
    }
  }

  for (const sk of rawSpendKeys) {
    const curveName =
      sk.keyType === 1 ? 'secp256k1' : sk.keyType === 2 ? 'ed25519' : 'unknown'
    entries.push(
      cborMap([
        [0, 'spend_key'],
        [
          1,
          [
            cborMap([
              [0, 'curve'],
              [1, curveName],
            ]),
            cborMap([
              [0, 'key_type'],
              [1, String(sk.keyType)],
            ]),
          ],
        ],
        [2, Uint8Array.from(sk.keyBytes)],
      ]),
    )
  }

  const type4MapEntries: Array<[number, Encodable]> = [
    [0, network],
    [
      1,
      cborMap([
        [0, 1],
        [1, Uint8Array.from(identity.compressedPubKey)],
      ]),
    ],
    [2, ts.revision],
    [
      3,
      cborMap([
        [0, ts.seconds],
        [1, ts.nanoseconds],
      ]),
    ],
    [4, relayBindings],
    [
      6,
      cborMap([
        [0, exp.seconds],
        [1, exp.nanoseconds],
      ]),
    ],
    [
      8,
      cborMap([
        [0, 1],
        [1, Uint8Array.from(stampKeyBytes)],
      ]),
    ],
  ]
  if (entries.length > 0) {
    type4MapEntries.push([9, entries])
  }
  if (rawSpendKeys.length > 0) {
    type4MapEntries.push([
      14,
      rawSpendKeys.map(k =>
        cborMap([
          [0, k.keyType],
          [1, Uint8Array.from(k.keyBytes)],
        ]),
      ),
    ])
  }

  const accountType =
    options.profile?.accountType !== undefined
      ? options.profile.accountType
      : options.profile?.bot
      ? ACCOUNT_TYPE_BOT
      : undefined
  if (accountType !== undefined) {
    type4MapEntries.push([15, BigInt(accountType)])
  }
  if (options.profile?.botRole !== undefined) {
    type4MapEntries.push([16, BigInt(options.profile.botRole)])
  }

  const type4Frame = encodeFrame(
    { typeId: 4, schemaVersion: 3, minReaderVersion: 2 },
    cborMap(type4MapEntries),
  )

  const digest = directorySignatureDigest(network, type4Frame)
  const sig = identity.signHash(Buffer.from(digest))

  const sigEntry = cborMap([
    [0, 1], // Algorithm 1: ECDSA secp256k1 over SHA-256
    [
      1,
      cborMap([
        [0, 1],
        [1, Uint8Array.from(identity.compressedPubKey)],
      ]),
    ],
    [2, Uint8Array.from(sig)],
  ])

  const type2Frame = encodeFrame(
    { typeId: 2, schemaVersion: 1, minReaderVersion: 1 },
    cborMap([
      [0, type4Frame],
      [1, [sigEntry]],
    ]),
  )

  return type2Frame
}

/** `PUT /metadata/:addr` with `Content-Type: application/cbor` (ticket #605).
 * Sends a canonical Type-2 directory attestation signed by the identity key. */
export async function registerMonadIdentityCbor(params: {
  relayBaseUrl: string
  identity: MonadIdentity
  profile?: MonadProfileFields
  network?: string
  timestampMs?: number
  ttlMs?: number
  stampKey?: Uint8Array
  spendKeys?: Array<{ keyType: number; keyBytes: Uint8Array }>
  curveKeys?: {
    secp256k1?: Uint8Array
    ed25519?: Uint8Array
  }
}): Promise<void> {
  const body = buildSignedDirectoryStatement(params.identity, {
    network: params.network,
    profile: params.profile,
    timestampMs: params.timestampMs,
    ttlMs: params.ttlMs,
    stampKey: params.stampKey,
    spendKeys: params.spendKeys,
    curveKeys: params.curveKeys,
  })
  await axios({
    method: 'put',
    url: `${params.relayBaseUrl.replace(/\/+$/, '')}/metadata/${
      params.identity.address.raw
    }`,
    data: Buffer.from(body),
    headers: {
      'Content-Type': 'application/cbor',
      ...relayOriginHeader('http://frank.local'),
    },
  })
}

/**
 * @deprecated Legacy protobuf registration. Default onboarding and wallet identity
 * registration must use {@link registerMonadIdentityCbor} (schema 3 deterministic CBOR).
 * `PUT /metadata/:addr` (no POP payment proof) -- mirrors `lotus-identity.ts`'s
 * `registerIdentity` exactly, just Monad-addressed. Uses legacy protobuf encoding.
 */
export async function registerMonadIdentity(params: {
  relayBaseUrl: string
  identity: MonadIdentity
  profile?: MonadProfileFields
}): Promise<void> {
  const body = buildSignedAddressMetadata(params.identity, params.profile)
  await axios({
    method: 'put',
    url: `${params.relayBaseUrl.replace(/\/+$/, '')}/metadata/${
      params.identity.address.raw
    }`,
    data: body,
    headers: {
      'Content-Type': 'application/x-protobuf',
      ...relayOriginHeader('http://frank.local'),
    },
  })
}

export interface DecodedProfile {
  pubKey: Uint8Array
  timestampMs: number
  derivedAddress: string
  network?: string
  name?: string
  username?: string
  bio?: string
  location?: string
  links?: MonadProfileLink[]
  bot?: boolean
  accountType?: AccountType
  botRole?: BotRole
  avatar?: string
  signedPayload: InstanceType<typeof SignedPayload>
  spendKeys?: Array<{ keyType: number; keyBytes: Uint8Array }>
  curveKeys?: {
    secp256k1?: Uint8Array
    ed25519?: Uint8Array
  }
}

/** Decodes either a CBOR directory statement or a legacy protobuf SignedPayload.
 * Validates stage 10.6 signature, subject signature, and verifies address derivation and network binding. */
export function decodeProfileBytes(
  raw: Uint8Array,
  options?: {
    expectedAddress?: string
    expectedNetwork?: string
  },
): DecodedProfile {
  if (isCborFrame(raw)) {
    const validated = validateFrame(raw, defaultContext({ operation: 'full' }))
    if (validated.kind !== 'parsed' || validated.typed?.type !== 2) {
      throw new Error('invalid CBOR directory attestation frame')
    }
    const stmtFrame = validated.typed.statementFrame
    if (stmtFrame.kind !== 'parsed' || stmtFrame.typed?.type !== 4) {
      throw new Error('invalid CBOR directory statement frame')
    }
    const stmt = stmtFrame.typed
    const pubKey = stmt.subject.keyBytes

    if (options?.expectedNetwork && stmt.network !== options.expectedNetwork) {
      throw new Error(
        `network mismatch: expected ${options.expectedNetwork}, got ${stmt.network}`,
      )
    }

    const hasSubjectSig = validated.typed.signatures.some(
      sig =>
        sig.signer.keyType === stmt.subject.keyType &&
        sig.signer.keyBytes.length === pubKey.length &&
        sig.signer.keyBytes.every((b, i) => b === pubKey[i]),
    )
    if (!hasSubjectSig) {
      throw new Error('missing subject signature in directory attestation')
    }

    const derivedAddress = computeAddress(hexlify(pubKey))
    if (
      options?.expectedAddress &&
      derivedAddress.toLowerCase() !== options.expectedAddress.toLowerCase()
    ) {
      throw new Error(
        `address mismatch: expected ${options.expectedAddress}, derived ${derivedAddress}`,
      )
    }

    let name: string | undefined
    let username: string | undefined
    let bio: string | undefined
    let location: string | undefined
    const links: MonadProfileLink[] = []
    let bot: boolean | undefined
    let avatar: string | undefined

    const metadata = new AddressMetadata()
    const sec = BigInt(stmt.timestamp.seconds)
    const nanos = BigInt(stmt.timestamp.nanoseconds)
    const timestampMs = Number(sec * 1000n + nanos / 1_000_000n)
    metadata.setTimestamp(timestampMs)
    metadata.setTtl(1000 * 60 * 60 * 24 * 365)
    const protoEntries: InstanceType<typeof Entry>[] = []

    const curveKeys: { secp256k1?: Uint8Array; ed25519?: Uint8Array } = {}
    const spendKeys: Array<{ keyType: number; keyBytes: Uint8Array }> = []

    if (stmt.spendKeys) {
      for (const sk of stmt.spendKeys) {
        spendKeys.push({ keyType: sk.keyType, keyBytes: sk.keyBytes })
        if (sk.keyType === 1 && !curveKeys.secp256k1) {
          curveKeys.secp256k1 = sk.keyBytes
        } else if (sk.keyType === 2 && !curveKeys.ed25519) {
          curveKeys.ed25519 = sk.keyBytes
        }
      }
    }

    if (stmt.profileEntries) {
      for (const entry of stmt.profileEntries) {
        const protoEntry = new Entry()
        protoEntry.setKind(entry.kind)
        protoEntry.setBody(Buffer.from(entry.body))
        for (const h of entry.headers) {
          const header = new Header()
          header.setName(h.name)
          header.setValue(h.value)
          protoEntry.addHeaders(header)
        }
        protoEntries.push(protoEntry)

        if (entry.kind === 'display_name') {
          name = new TextDecoder().decode(entry.body)
        } else if (entry.kind === 'username') {
          username = new TextDecoder().decode(entry.body)
        } else if (entry.kind === 'bio') {
          bio = new TextDecoder().decode(entry.body)
        } else if (entry.kind === 'location') {
          location = new TextDecoder().decode(entry.body)
        } else if (entry.kind === 'link') {
          const url = new TextDecoder().decode(entry.body)
          const type =
            entry.headers.find(h => h.name === 'type')?.value ?? 'website'
          const label = entry.headers.find(h => h.name === 'label')?.value
          links.push({ type, url, ...(label ? { label } : {}) })
        } else if (entry.kind === MONAD_PROFILE_BOT_KIND) {
          bot = new TextDecoder().decode(entry.body) === '1'
        } else if (entry.kind === 'avatar') {
          const contentType =
            entry.headers.find(h => h.name === 'content-type')?.value ??
            'image/png'
          avatar = `data:${contentType};base64,${Buffer.from(
            entry.body,
          ).toString('base64')}`
        } else if (entry.kind === 'spend_key') {
          const curveHeader = entry.headers.find(h => h.name === 'curve')?.value
          const keyTypeHeader = entry.headers.find(h => h.name === 'key_type')?.value
          if (curveHeader === 'secp256k1' || keyTypeHeader === '1') {
            if (!curveKeys.secp256k1) {
              curveKeys.secp256k1 = entry.body
              if (!spendKeys.some(k => k.keyType === 1)) {
                spendKeys.push({ keyType: 1, keyBytes: entry.body })
              }
            }
          } else if (curveHeader === 'ed25519' || keyTypeHeader === '2') {
            if (!curveKeys.ed25519) {
              curveKeys.ed25519 = entry.body
              if (!spendKeys.some(k => k.keyType === 2)) {
                spendKeys.push({ keyType: 2, keyBytes: entry.body })
              }
            }
          }
        }
      }
    }
    if (!username && stmt.unknownFields) {
      const f14 = stmt.unknownFields.get(14n)
      if (typeof f14 === 'string') {
        username = f14
      }
    }
    metadata.setEntriesList(protoEntries)

    if (!curveKeys.secp256k1) {
      curveKeys.secp256k1 = pubKey
      if (!spendKeys.some(k => k.keyType === 1)) {
        spendKeys.push({ keyType: 1, keyBytes: pubKey })
      }
    }
    spendKeys.sort(compareAccounts)

    const signedPayload = new SignedPayload()
    signedPayload.setPublicKey(pubKey)
    signedPayload.setPayload(metadata.serializeBinary())
    signedPayload.setScheme(SignedPayload.SignatureScheme.ECDSA)
    if (validated.typed.signatures.length > 0) {
      signedPayload.setSignature(validated.typed.signatures[0].signature)
    }

    const accountType =
      stmt.accountType !== undefined
        ? stmt.accountType
        : bot
        ? ACCOUNT_TYPE_BOT
        : ACCOUNT_TYPE_PERSON
    const botRole = stmt.botRole
    const isBot =
      accountType === ACCOUNT_TYPE_BOT ||
      accountType === ACCOUNT_TYPE_SERVICE ||
      bot === true

    return {
      pubKey,
      timestampMs,
      derivedAddress,
      network: stmt.network,
      name,
      username,
      bio,
      location,
      links: links.length > 0 ? links : undefined,
      bot: isBot ? true : undefined,
      accountType,
      botRole,
      avatar,
      signedPayload,
      spendKeys,
      curveKeys,
    }
  }

  const signedPayload = SignedPayload.deserializeBinary(raw)
  const metadata = AddressMetadata.deserializeBinary(
    signedPayload.getPayload_asU8(),
  )
  const pubKey = signedPayload.getPublicKey_asU8()
  const derivedAddress = computeAddress(hexlify(pubKey))
  if (
    options?.expectedAddress &&
    derivedAddress.toLowerCase() !== options.expectedAddress.toLowerCase()
  ) {
    throw new Error(
      `address mismatch: expected ${options.expectedAddress}, derived ${derivedAddress}`,
    )
  }

  let name: string | undefined
  let username: string | undefined
  let bio: string | undefined
  let location: string | undefined
  const links: MonadProfileLink[] = []
  let bot: boolean | undefined
  let avatar: string | undefined

  const curveKeys: { secp256k1?: Uint8Array; ed25519?: Uint8Array } = {}
  const spendKeys: Array<{ keyType: number; keyBytes: Uint8Array }> = []

  for (const entry of metadata.getEntriesList()) {
    const kind = entry.getKind()
    if (kind === 'display_name') {
      name = new TextDecoder().decode(entry.getBody_asU8())
    } else if (kind === 'username') {
      username = new TextDecoder().decode(entry.getBody_asU8())
    } else if (kind === 'bio') {
      bio = new TextDecoder().decode(entry.getBody_asU8())
    } else if (kind === 'location') {
      location = new TextDecoder().decode(entry.getBody_asU8())
    } else if (kind === 'link') {
      const url = new TextDecoder().decode(entry.getBody_asU8())
      const headers = entry.getHeadersList()
      const type =
        headers.find(h => h.getName() === 'type')?.getValue() ?? 'website'
      const label = headers.find(h => h.getName() === 'label')?.getValue()
      links.push({ type, url, ...(label ? { label } : {}) })
    } else if (kind === MONAD_PROFILE_BOT_KIND) {
      bot = new TextDecoder().decode(entry.getBody_asU8()) === '1'
    } else if (kind === 'avatar') {
      const contentType =
        entry
          .getHeadersList()
          .find(header => header.getName() === 'content-type')
          ?.getValue() ?? 'image/png'
      avatar = `data:${contentType};base64,${Buffer.from(
        entry.getBody_asU8(),
      ).toString('base64')}`
    } else if (kind === 'spend_key') {
      const curveHeader = entry
        .getHeadersList()
        .find(header => header.getName() === 'curve')
        ?.getValue()
      const keyTypeHeader = entry
        .getHeadersList()
        .find(header => header.getName() === 'key_type')
        ?.getValue()
      const body = entry.getBody_asU8()
      if (curveHeader === 'secp256k1' || keyTypeHeader === '1') {
        if (!curveKeys.secp256k1) {
          curveKeys.secp256k1 = body
          if (!spendKeys.some(k => k.keyType === 1)) {
            spendKeys.push({ keyType: 1, keyBytes: body })
          }
        }
      } else if (curveHeader === 'ed25519' || keyTypeHeader === '2') {
        if (!curveKeys.ed25519) {
          curveKeys.ed25519 = body
          if (!spendKeys.some(k => k.keyType === 2)) {
            spendKeys.push({ keyType: 2, keyBytes: body })
          }
        }
      }
    }
  }

  if (!curveKeys.secp256k1) {
    curveKeys.secp256k1 = pubKey
    if (!spendKeys.some(k => k.keyType === 1)) {
      spendKeys.push({ keyType: 1, keyBytes: pubKey })
    }
  }
  spendKeys.sort(compareAccounts)

  const isBot = bot === true
  const accountType = isBot ? ACCOUNT_TYPE_BOT : ACCOUNT_TYPE_PERSON
  return {
    pubKey,
    timestampMs: metadata.getTimestamp(),
    derivedAddress,
    name,
    username,
    bio,
    location,
    links: links.length > 0 ? links : undefined,
    bot: isBot ? true : undefined,
    accountType,
    avatar,
    signedPayload,
    spendKeys,
    curveKeys,
  }
}

/** `GET /metadata/:addr`: fetches a previously-registered identity's pubkey, supporting both
 * deterministic CBOR and legacy protobuf representations. Returns `undefined` on a `404`. */
export async function fetchMonadIdentityPubKey(params: {
  relayBaseUrl: string
  address: string
  expectedNetwork?: string
}): Promise<Buffer | undefined> {
  try {
    const response = await axios({
      method: 'get',
      url: `${params.relayBaseUrl.replace(/\/+$/, '')}/metadata/${
        params.address
      }`,
      responseType: 'arraybuffer',
    })
    const raw = new Uint8Array(response.data)
    const decoded = decodeProfileBytes(raw, {
      expectedAddress: params.address,
      expectedNetwork: params.expectedNetwork,
    })
    return Buffer.from(decoded.pubKey)
  } catch (err) {
    if (axios.isAxiosError(err) && err.response?.status === 404) {
      return undefined
    }
    throw err
  }
}

/** `MonadChain.fetchProfile`'s real implementation: resolves `address`'s registered pubkey and
 * profile fields supporting both deterministic CBOR and legacy protobuf. Returns `undefined` if
 * nothing is registered under `address` yet. */
export async function fetchMonadProfile(params: {
  relayBaseUrl: string
  address: ChainAddress
  expectedNetwork?: string
}): Promise<ProfileInfo | undefined> {
  try {
    const response = await axios({
      method: 'get',
      url: `${params.relayBaseUrl.replace(/\/+$/, '')}/metadata/${
        params.address.raw
      }`,
      responseType: 'arraybuffer',
    })
    const raw = new Uint8Array(response.data)
    const decoded = decodeProfileBytes(raw, {
      expectedAddress: params.address.raw,
      expectedNetwork: params.expectedNetwork,
    })
    const result: ProfileInfo = {
      address: params.address,
      pubKey: decoded.pubKey,
    }
    if (decoded.name !== undefined) result.name = decoded.name
    if (decoded.username !== undefined) result.username = decoded.username
    if (decoded.bio !== undefined) result.bio = decoded.bio
    if (decoded.location !== undefined) result.location = decoded.location
    if (decoded.links !== undefined) result.links = decoded.links
    if (decoded.bot !== undefined) result.bot = decoded.bot
    if (decoded.avatar !== undefined) result.avatar = decoded.avatar
    if (decoded.accountType !== undefined) result.accountType = decoded.accountType
    if (decoded.botRole !== undefined) result.botRole = decoded.botRole
    if (decoded.spendKeys !== undefined) result.spendKeys = decoded.spendKeys
    if (decoded.curveKeys !== undefined) result.curveKeys = decoded.curveKeys
    return result
  } catch (err) {
    if (axios.isAxiosError(err) && err.response?.status === 404) {
      return undefined
    }
    throw err
  }
}

/** One entry of `fetchMonadProfilesSince`'s result: a registered Monad profile's address, paired
 * with its `SignedPayload` representation and `rawBytes`. */
export interface MonadProfileListingEntry {
  address: string
  signedPayload: InstanceType<typeof SignedPayload>
  rawBytes: Uint8Array
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
 * it's decoded here via `SignedPayload.deserializeBinary` rather than a nested-message getter.
 * Transparently supports both CBOR and legacy protobuf representations. */
function isNotFoundError(err: unknown): boolean {
  if (!err) return false
  const anyErr = err as any
  return anyErr.response?.status === 404 || anyErr.status === 404
}

export async function fetchMonadProfilesSince(params: {
  relayBaseUrl: string
  sinceMs: number
}): Promise<MonadProfileListingEntry[]> {
  const baseUrl = params.relayBaseUrl.replace(/\/+$/, '')
  let response: any
  try {
    response = await axios({
      method: 'get',
      url: `${baseUrl}/profiles`,
      params: { since: params.sinceMs },
      responseType: 'arraybuffer',
    })
  } catch (err) {
    if (isNotFoundError(err)) {
      response = await axios({
        method: 'get',
        url: `${baseUrl}/metadata/monad`,
        params: { since: params.sinceMs },
        responseType: 'arraybuffer',
      })
    } else {
      throw err
    }
  }
  const decoded = ListMonadProfilesResponse.deserializeBinary(
    new Uint8Array(response.data),
  )
  return decoded.getEntriesList().map(entry => {
    const rawBytes = entry.getSignedPayload_asU8()
    const profile = decodeProfileBytes(rawBytes, {
      expectedAddress: entry.getAddress(),
    })
    return {
      address: entry.getAddress(),
      signedPayload: profile.signedPayload,
      rawBytes,
    }
  })
}

/** Server-side clamp on `searchMonadProfiles`'s `limit` -- mirrors
 * `cashweb-registry`'s `store::monad_profiles::MAX_SEARCH_RESULTS` (ticket #48). Not enforced
 * client-side (the relay clamps regardless of what's requested); kept here purely as a documented
 * reference for callers deciding what to ask for. */
export const MONAD_PROFILE_SEARCH_MAX_RESULTS = 100

/** `GET /profiles/search?prefix=<text>&limit=<n>` (canonical) / `/metadata/monad/search`:
 * prefix-search registered profiles by their normalized (lowercased) `display_name`, matching case-insensitively.
 * `limit` defaults to the relay's own default (currently 20) when omitted, and is clamped to
 * `MONAD_PROFILE_SEARCH_MAX_RESULTS` server-side regardless of what's requested.
 * Transparently supports both CBOR and legacy protobuf representations. */
export async function searchMonadProfiles(params: {
  relayBaseUrl: string
  prefix: string
  limit?: number
}): Promise<MonadProfileListingEntry[]> {
  const baseUrl = params.relayBaseUrl.replace(/\/+$/, '')
  const queryParams = {
    prefix: params.prefix,
    ...(params.limit === undefined ? {} : { limit: params.limit }),
  }
  let response: any
  try {
    response = await axios({
      method: 'get',
      url: `${baseUrl}/profiles/search`,
      params: queryParams,
      responseType: 'arraybuffer',
    })
  } catch (err) {
    if (isNotFoundError(err)) {
      response = await axios({
        method: 'get',
        url: `${baseUrl}/metadata/monad/search`,
        params: queryParams,
        responseType: 'arraybuffer',
      })
    } else {
      throw err
    }
  }
  const decoded = ListMonadProfilesResponse.deserializeBinary(
    new Uint8Array(response.data),
  )
  return decoded.getEntriesList().map(entry => {
    const rawBytes = entry.getSignedPayload_asU8()
    const profile = decodeProfileBytes(rawBytes, {
      expectedAddress: entry.getAddress(),
    })
    return {
      address: entry.getAddress(),
      signedPayload: profile.signedPayload,
      rawBytes,
    }
  })
}

/** Canonical chain-agnostic alias for `searchMonadProfiles`. */
export const searchProfiles = searchMonadProfiles

/** Canonical chain-agnostic alias for `fetchMonadProfilesSince`. */
export const fetchProfilesSince = fetchMonadProfilesSince

/** One entry in the relay's operator-curated default-contacts list -- see
 * `fetchCuratedDefaultContacts`. Shape matches `stores/contacts.ts`'s `addDefaultContact` param
 * exactly (`{address, name}`), so callers can pass an entry straight through. */
export interface CuratedDefaultContact {
  address: string
  name: string
}

/** `GET /profiles/curated-defaults` (canonical) / `/metadata/monad/curated-defaults`:
 * fetches the relay's operator-curated list of default contacts, shown to a fresh user
 * before they've added anyone themselves.
 * Fails soft (empty array) on any error -- this is a nice-to-have UX seed, not something that
 * should ever block app startup if a relay is slow/down/misconfigured. */
export async function fetchCuratedDefaultContacts(params: {
  relayBaseUrl: string
}): Promise<CuratedDefaultContact[]> {
  const baseUrl = params.relayBaseUrl.replace(/\/+$/, '')
  try {
    let data: any
    try {
      const response = await axios({
        method: 'get',
        url: `${baseUrl}/profiles/curated-defaults`,
      })
      data = response.data
    } catch (err) {
      if (isNotFoundError(err)) {
        const response = await axios({
          method: 'get',
          url: `${baseUrl}/metadata/monad/curated-defaults`,
        })
        data = response.data
      } else {
        throw err
      }
    }
    if (Array.isArray(data?.entries)) {
      return data.entries
    }
    if (Array.isArray(data)) {
      return data
    }
    return []
  } catch (err) {
    console.error('failed to fetch curated default contacts', err)
    return []
  }
}
