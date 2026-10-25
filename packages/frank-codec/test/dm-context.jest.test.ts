import { readFileSync } from 'fs'
import { join } from 'path'

import {
  DM_CRYPTO_CONTEXT_DOMAIN,
  beginDirectMessageValidation,
  cborMap,
  decodeCanonical,
  defaultContext,
  decodeDirectMessageCryptoContext,
  encodeDirectMessageCryptoContext,
  encodeFrame,
  toHex,
  type DirectMessageCryptoContext,
} from '../src'
import {
  ACCOUNT_REF,
  ENCRYPTED_MESSAGE_CONTENT,
  ENCRYPTION_SUITE,
  FRANK_ENVELOPE,
  RECIPIENT_ENCRYPTED_PAYLOAD_V2,
  TYPE_RECIPIENT_ENCRYPTED_PAYLOAD,
} from '../src/constants'

const bytes = (length: number, value: number) =>
  new Uint8Array(length).fill(value)
const fromHex = (value: string) => Uint8Array.from(Buffer.from(value, 'hex'))

interface CorpusAccount {
  keyType: number
  keyHex: string
}

interface CorpusContext {
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
  encodedHex: string
}

const CORPUS = JSON.parse(
  readFileSync(
    join(__dirname, '../../../docs/protocol/cbor/vectors/dm-suite-1.json'),
    'utf8',
  ),
) as {
  context: CorpusContext
  cryptoBox: { envelopeHex: string }
  type5FrameHex: string
}
const C = CORPUS.context
const account = ({ keyType, keyHex }: CorpusAccount) => ({
  keyType,
  keyBytes: fromHex(keyHex),
})
const accountMap = (value: CorpusAccount) =>
  cborMap([
    [ACCOUNT_REF.keyType, value.keyType],
    [ACCOUNT_REF.keyBytes, fromHex(value.keyHex)],
  ])

const VECTOR: DirectMessageCryptoContext = {
  network: C.network,
  sender: account(C.sender),
  recipient: account(C.recipient),
  senderDirectoryHash: fromHex(C.senderDirectoryHashHex),
  recipientDirectoryHash: fromHex(C.recipientDirectoryHashHex),
  senderMessageKey: account(C.senderMessageKey),
  recipientMessageKey: account(C.recipientMessageKey),
  stampKey: account(C.stampKey),
  ephemeralPoint: fromHex(C.ephemeralPointHex),
  sharedPoint: fromHex(C.sharedPointHex),
  dleqProof: fromHex(C.dleqProofHex),
}

describe('DM crypto context v1', () => {
  it('matches the shared TypeScript/Rust vector', () => {
    expect(DM_CRYPTO_CONTEXT_DOMAIN).toBe('frank/dm-crypto-context/v1')
    expect(toHex(encodeDirectMessageCryptoContext(VECTOR))).toBe(C.encodedHex)
  })

  it('matches the shared type-11 schema-2 frame', () => {
    const payload = cborMap([
      [RECIPIENT_ENCRYPTED_PAYLOAD_V2.network, C.network],
      [RECIPIENT_ENCRYPTED_PAYLOAD_V2.sender, accountMap(C.sender)],
      [RECIPIENT_ENCRYPTED_PAYLOAD_V2.recipient, accountMap(C.recipient)],
      [RECIPIENT_ENCRYPTED_PAYLOAD_V2.suite, ENCRYPTION_SUITE.dmAuthXchacha],
      [
        RECIPIENT_ENCRYPTED_PAYLOAD_V2.cryptoBoxEnvelope,
        fromHex(CORPUS.cryptoBox.envelopeHex),
      ],
      [
        RECIPIENT_ENCRYPTED_PAYLOAD_V2.ephemeralPoint,
        fromHex(C.ephemeralPointHex),
      ],
      [RECIPIENT_ENCRYPTED_PAYLOAD_V2.sharedPoint, fromHex(C.sharedPointHex)],
      [RECIPIENT_ENCRYPTED_PAYLOAD_V2.dleqProof, fromHex(C.dleqProofHex)],
    ])
    expect(
      toHex(
        encodeFrame(
          {
            typeId: TYPE_RECIPIENT_ENCRYPTED_PAYLOAD,
            schemaVersion: 2,
            minReaderVersion: 2,
          },
          payload,
        ),
      ),
    ).toBe(CORPUS.type5FrameHex)
  })

  it.each([
    'network',
    'sender',
    'recipient',
    'senderDirectoryHash',
    'recipientDirectoryHash',
    'senderMessageKey',
    'recipientMessageKey',
    'stampKey',
    'ephemeralPoint',
    'sharedPoint',
    'dleqProof',
  ] as const)('binds %s', field => {
    const baseline = toHex(encodeDirectMessageCryptoContext(VECTOR))
    const changed = { ...VECTOR } as DirectMessageCryptoContext &
      Record<string, unknown>
    if (field === 'network') changed.network = 'monad-mainnet'
    else if (field === 'recipient') {
      const prior = VECTOR[field]
      changed[field] = {
        ...prior,
        keyBytes: Uint8Array.from(prior.keyBytes, b => b ^ 1),
      }
    } else if (field === 'sender' || field.endsWith('Key')) {
      const prior = VECTOR[field]
      changed[field] = { ...prior, keyBytes: fromHex(C.ephemeralPointHex) }
    } else if (field === 'ephemeralPoint') {
      changed[field] = fromHex(C.sharedPointHex)
    } else if (field === 'sharedPoint') {
      changed[field] = fromHex(C.ephemeralPointHex)
    } else {
      changed[field] = bytes(VECTOR[field].length, 0x99)
    }
    expect(toHex(encodeDirectMessageCryptoContext(changed))).not.toBe(baseline)
  })

  it('rejects wrong key roles and field lengths', () => {
    expect(() =>
      encodeDirectMessageCryptoContext({
        ...VECTOR,
        senderMessageKey: { keyType: 2, keyBytes: bytes(32, 1) },
      }),
    ).toThrow('compressed secp256k1')
    expect(() =>
      encodeDirectMessageCryptoContext({
        ...VECTOR,
        dleqProof: bytes(63, 1),
      }),
    ).toThrow('two scalars in 1..n-1')
  })

  it('round-trips through decodeDirectMessageCryptoContext', () => {
    const encoded = encodeDirectMessageCryptoContext(VECTOR)
    const decoded = decodeDirectMessageCryptoContext(encoded)
    expect(decoded).toEqual(VECTOR)
  })

  it('round-trips sealed-sender DirectMessageCryptoContext omitting sender fields (2, 4, 6)', () => {
    const sealedCtx: DirectMessageCryptoContext = {
      network: VECTOR.network,
      recipient: VECTOR.recipient,
      recipientDirectoryHash: VECTOR.recipientDirectoryHash,
      recipientMessageKey: VECTOR.recipientMessageKey,
      stampKey: VECTOR.stampKey,
      ephemeralPoint: VECTOR.ephemeralPoint,
      sharedPoint: VECTOR.sharedPoint,
      dleqProof: VECTOR.dleqProof,
    }
    const encoded = encodeDirectMessageCryptoContext(sealedCtx)
    // 13-entry CBOR map starts with 0xad
    expect(encoded[0]).toBe(0xad)
    const decoded = decodeDirectMessageCryptoContext(encoded)
    expect(decoded).toEqual(sealedCtx)
    expect(decoded.sender).toBeUndefined()
    expect(decoded.senderDirectoryHash).toBeUndefined()
    expect(decoded.senderMessageKey).toBeUndefined()

    expect(() =>
      encodeDirectMessageCryptoContext({
        ...sealedCtx,
        sender: VECTOR.sender,
      }),
    ).toThrow('must either all be present or all be absent')
  })
})

/** The sealed-sender corpus, printed by scripts/dm-sealed-sender-corpus.mts from the corpus above. */
const SEALED = JSON.parse(
  readFileSync(
    join(
      __dirname,
      '../../../docs/protocol/cbor/vectors/dm-sealed-sender.json',
    ),
    'utf8',
  ),
) as {
  context: { entries: number; encodedHex: string }
  content: { messageIdHex: string; frameHex: string }
  cryptoBox: { entries: number; envelopeHex: string }
  payload: { entries: number; frameHex: string }
}

describe('sealed-sender direct message, shared TypeScript/Rust vectors', () => {
  const sealedContext: DirectMessageCryptoContext = {
    network: VECTOR.network,
    recipient: VECTOR.recipient,
    recipientDirectoryHash: VECTOR.recipientDirectoryHash,
    recipientMessageKey: VECTOR.recipientMessageKey,
    stampKey: VECTOR.stampKey,
    ephemeralPoint: VECTOR.ephemeralPoint,
    sharedPoint: VECTOR.sharedPoint,
    dleqProof: VECTOR.dleqProof,
  }
  // A frame is the 9-byte FRNK header and then its envelope map, which holds the payload map's
  // canonical bytes.
  const body = (hex: string) =>
    decodeCanonical(
      (decodeCanonical(fromHex(hex).subarray(9)) as Map<bigint, unknown>).get(
        BigInt(FRANK_ENVELOPE.payload),
      ) as Uint8Array,
    ) as Map<bigint, unknown>

  it('encodes the 13-entry context, which names no sender', () => {
    const encoded = encodeDirectMessageCryptoContext(sealedContext)
    expect(toHex(encoded)).toBe(SEALED.context.encodedHex)
    expect(SEALED.context.entries).toBe(13)
    expect(encoded[0]).toBe(0xa0 + 13)
    expect(decodeDirectMessageCryptoContext(encoded)).toEqual(sealedContext)
  })

  it('encodes the type-11 payload without its sender (field 1)', () => {
    const P = RECIPIENT_ENCRYPTED_PAYLOAD_V2
    const payload = cborMap([
      [P.network, C.network],
      [P.recipient, accountMap(C.recipient)],
      [P.suite, ENCRYPTION_SUITE.dmAuthXchacha],
      [P.cryptoBoxEnvelope, fromHex(SEALED.cryptoBox.envelopeHex)],
      [P.ephemeralPoint, fromHex(C.ephemeralPointHex)],
      [P.sharedPoint, fromHex(C.sharedPointHex)],
      [P.dleqProof, fromHex(C.dleqProofHex)],
    ])
    expect(
      toHex(
        encodeFrame(
          {
            typeId: TYPE_RECIPIENT_ENCRYPTED_PAYLOAD,
            schemaVersion: 2,
            minReaderVersion: 2,
          },
          payload,
        ),
      ),
    ).toBe(SEALED.payload.frameHex)
    const decoded = body(SEALED.payload.frameHex)
    expect(decoded.size).toBe(SEALED.payload.entries)
    expect(decoded.has(BigInt(P.sender))).toBe(false)
  })

  it('carries the sender in the type-12 content as fields 7, 8 and 9', () => {
    const M = ENCRYPTED_MESSAGE_CONTENT
    const content = body(SEALED.content.frameHex)
    const accountOf = (value: unknown) => {
      const map = value as Map<bigint, unknown>
      return {
        keyType: Number(map.get(BigInt(ACCOUNT_REF.keyType))),
        keyHex: toHex(map.get(BigInt(ACCOUNT_REF.keyBytes)) as Uint8Array),
      }
    }
    expect(accountOf(content.get(BigInt(M.sender)))).toEqual(C.sender)
    expect(
      toHex(content.get(BigInt(M.senderDirectoryHash)) as Uint8Array),
    ).toBe(C.senderDirectoryHashHex)
    expect(accountOf(content.get(BigInt(M.senderMessageKey)))).toEqual(
      C.senderMessageKey,
    )
    expect(toHex(content.get(BigInt(M.messageId)) as Uint8Array)).toBe(
      SEALED.content.messageIdHex,
    )
  })

  it('passes direct-message validation, payload and authenticated content together', () => {
    expect(() =>
      beginDirectMessageValidation(
        fromHex(SEALED.payload.frameHex),
        defaultContext(),
      ).completeAuthenticatedContent(fromHex(SEALED.content.frameHex)),
    ).not.toThrow()
  })
})
