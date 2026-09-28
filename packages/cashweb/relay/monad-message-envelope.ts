/**
 * Recipient-addressing + E2E encryption convention for Monad-stamped messages (ticket #9),
 * working around the gap `../../../backend/cashweb/cashweb-registry/src/http/monad_message.rs`'s
 * module docs flag for ticket #37: neither `MonadStampedMessage` nor `StoredMonadMessage` carries
 * an intended-recipient field, so `GET /message/monad?since=<t>` returns *every* stored message,
 * and there is nothing in the wire format for a client to filter on. Fixing that for real means a
 * new field on the proto (`monad_message.proto`'s own doc comment sketches
 * `recipient_address_hint`) -- an explicit, deliberate wire-format decision left for review
 * (#16/#19/#27/#30/#37 all build on that proto), not made unilaterally by this ticket.
 *
 * ## The convention this file implements instead
 *
 * `MonadStampedMessage.encrypted_payload` is opaque bytes to the relay (its own doc comment says
 * so) -- so this module puts a small plaintext JSON *envelope* there instead of a bare ciphertext
 * blob: `{ v: 1, from: <sender's Frank identity address>, to: <recipient's Frank identity
 * address>, salt: <hex>, ciphertext: <hex> }`. A poller (`qwen-bot.livecheck.ts`) fetches the
 * `since` page, JSON-parses each message's `encrypted_payload`, and keeps only the ones whose `to`
 * matches its own Frank identity address -- an exact-match filter, not "attempt decryption and see
 * if it parses" (this ticket's other suggested option), because that heuristic is genuinely
 * ambiguous with bare AES-CBC (no AEAD tag here -- see below): a wrong key can still produce
 * PKCS7-padding bytes that happen to validate, and there's no independent "is this really for me"
 * signal without also attempting a full ECDH + decrypt against every candidate identity. Recipient
 * *routing* (the `to` field) is left unencrypted on purpose -- it's metadata already implied by
 * "which relay you're both polling", not the message content -- while `ciphertext` is real
 * end-to-end encryption of the actual text, decryptable only by whoever holds the matching
 * private key. `from`/`to` are real, independently-verifiable Frank identity addresses (not
 * self-asserted pubkeys folded into this envelope): a reader resolves `from`'s pubkey via a live
 * `GET /metadata/:from` (`./lotus-identity.ts`'s `fetchIdentityPubKey`), so the ECDH shared secret
 * is always derived from a registry-attested key, not a value the envelope itself could lie about.
 *
 * ## Reused crypto: `../relay/crypto.ts`'s `PayloadConstructor`
 *
 * `constructSharedKey`/`encrypt`/`decrypt` are this codebase's existing ECDH (`P = privA *
 * pubB = privB * pubA`, salted via HMAC-SHA256) + AES-256-CBC implementation, already used for
 * Lotus relay stealth addressing. This module reuses it as-is (no new crypto primitives), just
 * fed the two parties' Frank identity keys (`bitcore-lib-xpi` `PrivateKey`/`PublicKey`, the same
 * type `PayloadConstructor` already expects) instead of Lotus stealth-address ephemeral keys.
 * ECDH's `constructMergedKey` is symmetric in the two parties' roles (`pubB.point.mul(privA.bn) ==
 * pubA.point.mul(privB.bn)`, standard Diffie-Hellman), so encrypting with `(myPriv, theirPub)` and
 * decrypting with `(theirPriv, myPub)` -- given the same `salt` -- always agree, and `salt` (a
 * fresh 16 random bytes per message, carried in the envelope) is what keeps every message's
 * derived key distinct even though the two identities' long-term keys never change.
 */
import { randomBytes } from 'crypto'

import { PrivateKey, PublicKey } from 'bitcore-lib-xpi'

import { PayloadConstructor } from '../relay/crypto'
import { IDENTITY_KEY_NETWORK_NAME } from '../legacy-wallet/lotus-identity'

const payloadConstructor = new PayloadConstructor({
  networkName: IDENTITY_KEY_NETWORK_NAME,
})

export interface MonadMessageEnvelope {
  v: 1
  from: string
  to: string
  /** Hex-encoded, 16 random bytes -- the ECDH salt for this message only (see this file's
   * header). */
  salt: string
  /** Hex-encoded AES-256-CBC ciphertext of the UTF-8 plaintext. */
  ciphertext: string
}

function isMonadMessageEnvelope(value: unknown): value is MonadMessageEnvelope {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as Record<string, unknown>
  return (
    candidate.v === 1 &&
    typeof candidate.from === 'string' &&
    typeof candidate.to === 'string' &&
    typeof candidate.salt === 'string' &&
    typeof candidate.ciphertext === 'string'
  )
}

/** Builds the encrypted, JSON-encoded envelope bytes to pass as `MonadStampedMessage.
 * encrypted_payload` (see `MonadStampClient.submitStampedMessage`, `../wallet/
 * monad-stamp-client.ts`). */
export function buildEnvelope(params: {
  fromAddress: string
  fromPrivateKey: PrivateKey
  toAddress: string
  toPubKey: Buffer
  plaintext: string
}): Uint8Array {
  const salt = randomBytes(16)
  const sharedKey = payloadConstructor.constructSharedKey(
    params.fromPrivateKey,
    PublicKey.fromBuffer(params.toPubKey),
    salt,
  )
  const ciphertext = payloadConstructor.encrypt(
    sharedKey,
    new TextEncoder().encode(params.plaintext),
  )
  const envelope: MonadMessageEnvelope = {
    v: 1,
    from: params.fromAddress,
    to: params.toAddress,
    salt: salt.toString('hex'),
    ciphertext: Buffer.from(ciphertext).toString('hex'),
  }
  return new TextEncoder().encode(JSON.stringify(envelope))
}

/** Parses `encrypted_payload` bytes as a `MonadMessageEnvelope`, or returns `undefined` if it
 * isn't one (not JSON, or missing this envelope's required fields) -- e.g. any pre-#9 demo
 * message using the plain-JSON-blob-with-no-envelope shape `monad-e2e-demo.livecheck.ts` sends. */
export function parseEnvelope(
  bytes: Uint8Array,
): MonadMessageEnvelope | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(new TextDecoder().decode(bytes))
  } catch {
    return undefined
  }
  return isMonadMessageEnvelope(parsed) ? parsed : undefined
}

/** Decrypts an envelope known to be addressed to the caller (i.e. `envelope.to` already checked
 * against the caller's own address) using the caller's private key and the sender's pubkey
 * (resolved out-of-band, e.g. via `./lotus-identity.ts`'s `fetchIdentityPubKey(envelope.from)`). */
export function decryptEnvelope(params: {
  envelope: MonadMessageEnvelope
  myPrivateKey: PrivateKey
  senderPubKey: Buffer
}): string {
  const salt = Buffer.from(params.envelope.salt, 'hex')
  const sharedKey = payloadConstructor.constructSharedKey(
    params.myPrivateKey,
    PublicKey.fromBuffer(params.senderPubKey),
    salt,
  )
  const ciphertext = Buffer.from(params.envelope.ciphertext, 'hex')
  const plaintext = payloadConstructor.decrypt(sharedKey, ciphertext)
  return new TextDecoder().decode(plaintext)
}
