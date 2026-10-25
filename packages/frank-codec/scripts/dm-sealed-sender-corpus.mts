/**
 * Prints the sealed-sender direct-message corpus, `docs/protocol/cbor/vectors/dm-sealed-sender.json`.
 * `vectors.mts` writes it (`yarn vectors:generate`) and compares it (`yarn vectors:check`)
 * after re-encoding the frozen corpora; never edit the JSON by hand.
 *
 * Built from the named suite-1 corpus (`dm-suite-1.json`): the same accounts, statement hashes,
 * stamp proof, salt and test scalars. A sealed message differs from a named one in three
 * places, and the corpus pins each:
 *
 * - the crypto context omits the sender, its statement hash and its message key (13 entries);
 * - the type-12 content carries them instead, as fields 7, 8 and 9;
 * - the type-11 payload omits its sender (field 1), and its crypto-box envelope is the 7-entry
 *   form whose key 6 is the sender's message key masked for the recipient.
 *
 * Read by `packages/frank-codec/test/dm-context.jest.test.ts`,
 * `packages/crypto-box/test/suite.jest.test.ts` and `backend/cashweb/frank-cbor/tests/dm.rs`.
 */
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { secp256k1 } from '@noble/curves/secp256k1.js'
import { seal } from '../../crypto-box/src/index'
import * as codecModule from '../src/index'
import type { Encodable } from '../src/cbor'

// The codec is CommonJS TypeScript: loaded from ESM, its exports sit on `default`.
const codec =
  (codecModule as unknown as { default?: typeof codecModule }).default ??
  codecModule
const {
  ACCOUNT_REF,
  ENCRYPTED_MESSAGE_CONTENT,
  ENCRYPTION_SUITE,
  MESSAGE_CONTENT_REVISION,
  RECIPIENT_ENCRYPTED_PAYLOAD_V2,
  TEXT_MESSAGE_ITEM,
  TYPE_ENCRYPTED_MESSAGE_CONTENT,
  TYPE_MESSAGE_CONTENT_REVISION,
  TYPE_RECIPIENT_ENCRYPTED_PAYLOAD,
  TYPE_TEXT_MESSAGE_ITEM,
  cborMap,
  encodeDirectMessageCryptoContext,
  encodeFrame,
  messageContentDigest,
  toHex,
} = codec

interface CorpusAccount {
  keyType: number
  keyHex: string
}

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const fromHex = (hex: string) => Uint8Array.from(Buffer.from(hex, 'hex'))
const scalar = (value: number) => fromHex(value.toString(16).padStart(64, '0'))
const frame = (typeId: number, payload: Encodable, version = 1) =>
  encodeFrame(
    { typeId, schemaVersion: version, minReaderVersion: version },
    payload,
  )

function dmSealedSenderCorpus(): unknown {
  const named = JSON.parse(
    readFileSync(
      resolve(ROOT, 'docs/protocol/cbor/vectors/dm-suite-1.json'),
      'utf8',
    ),
  ) as {
    context: Record<string, string | CorpusAccount>
    cryptoBox: {
      saltByte: number
      ephemeralSecret: number
      senderSecret: number
      recipientSecret: number
    }
  }
  const C = named.context as {
    network: string
    sender: CorpusAccount
    recipient: CorpusAccount
    senderDirectoryHashHex: string
    recipientDirectoryHashHex: string
    senderMessageKey: CorpusAccount
    recipientMessageKey: CorpusAccount
    stampKey: CorpusAccount
    ephemeralPointHex: string
    sharedPointHex: string
    dleqProofHex: string
  }
  const B = named.cryptoBox
  const account = ({ keyType, keyHex }: CorpusAccount) => ({
    keyType,
    keyBytes: fromHex(keyHex),
  })
  const accountMap = (value: CorpusAccount) =>
    cborMap([
      [ACCOUNT_REF.keyType, value.keyType],
      [ACCOUNT_REF.keyBytes, fromHex(value.keyHex)],
    ])
  const senderSecret = scalar(B.senderSecret)
  const recipientSecret = scalar(B.recipientSecret)
  // The named corpus's message keys are these test scalars' points; refuse to drift from it.
  if (
    toHex(secp256k1.getPublicKey(senderSecret, true)) !==
      C.senderMessageKey.keyHex ||
    toHex(secp256k1.getPublicKey(recipientSecret, true)) !==
      C.recipientMessageKey.keyHex
  )
    throw new Error('dm-suite-1 message keys are not its test scalars')

  const context = encodeDirectMessageCryptoContext({
    network: C.network,
    recipient: account(C.recipient),
    recipientDirectoryHash: fromHex(C.recipientDirectoryHashHex),
    recipientMessageKey: account(C.recipientMessageKey),
    stampKey: account(C.stampKey),
    ephemeralPoint: fromHex(C.ephemeralPointHex),
    sharedPoint: fromHex(C.sharedPointHex),
    dleqProof: fromHex(C.dleqProofHex),
  })

  const revision = frame(
    TYPE_MESSAGE_CONTENT_REVISION,
    cborMap([
      [MESSAGE_CONTENT_REVISION.network, 'frank'],
      [
        MESSAGE_CONTENT_REVISION.items,
        [
          frame(
            TYPE_TEXT_MESSAGE_ITEM,
            cborMap([[TEXT_MESSAGE_ITEM.text, 'frank']]),
          ),
        ],
      ],
    ]),
  )
  const messageId = new Uint8Array(16).fill(0x11)
  const M = ENCRYPTED_MESSAGE_CONTENT
  const content = frame(
    TYPE_ENCRYPTED_MESSAGE_CONTENT,
    cborMap([
      [M.network, C.network],
      [M.messageId, messageId],
      [M.revisionFrame, revision],
      [M.contentDigest, messageContentDigest(revision)],
      [M.sender, accountMap(C.sender)],
      [M.senderDirectoryHash, fromHex(C.senderDirectoryHashHex)],
      [M.senderMessageKey, accountMap(C.senderMessageKey)],
    ]),
  )

  const sealed = seal({
    suiteId: ENCRYPTION_SUITE.dmAuthXchacha,
    recipientPublicKey: fromHex(C.recipientMessageKey.keyHex),
    senderPublicKey: fromHex(C.senderMessageKey.keyHex),
    senderPrivateKey: senderSecret,
    plaintext: content,
    context,
    ephemeralSecret: scalar(B.ephemeralSecret),
    salt: new Uint8Array(32).fill(B.saltByte),
    padding: 0,
    sealedSender: true,
  })
  if (!sealed.ok) throw new Error(`sealed-sender seal: ${sealed.error.code}`)

  const P = RECIPIENT_ENCRYPTED_PAYLOAD_V2
  const payload = frame(
    TYPE_RECIPIENT_ENCRYPTED_PAYLOAD,
    cborMap([
      [P.network, C.network],
      [P.recipient, accountMap(C.recipient)],
      [P.suite, ENCRYPTION_SUITE.dmAuthXchacha],
      [P.cryptoBoxEnvelope, sealed.value],
      [P.ephemeralPoint, fromHex(C.ephemeralPointHex)],
      [P.sharedPoint, fromHex(C.sharedPointHex)],
      [P.dleqProof, fromHex(C.dleqProofHex)],
    ]),
    2,
  )

  return {
    format: 'frank-dm-sealed-sender-vectors',
    version: 1,
    source: 'docs/protocol/cbor/vectors/dm-suite-1.json',
    generator: 'packages/frank-codec/scripts/dm-sealed-sender-corpus.mts',
    context: { entries: 13, encodedHex: toHex(context) },
    content: {
      messageIdHex: toHex(messageId),
      text: 'frank',
      frameHex: toHex(content),
    },
    cryptoBox: {
      entries: 7,
      saltByte: B.saltByte,
      ephemeralSecret: B.ephemeralSecret,
      senderSecret: B.senderSecret,
      recipientSecret: B.recipientSecret,
      padding: 0,
      envelopeHex: toHex(sealed.value),
    },
    payload: { entries: 7, frameHex: toHex(payload) },
  }
}

process.stdout.write(JSON.stringify(dmSealedSenderCorpus(), null, 2) + '\n')
