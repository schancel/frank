import { readFileSync } from 'fs'
import { join } from 'path'

import {
  DM_CRYPTO_CONTEXT_DOMAIN,
  cborMap,
  encodeDirectMessageCryptoContext,
  encodeFrame,
  toHex,
  type DirectMessageCryptoContext,
} from '../src'

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
    [0, value.keyType],
    [1, fromHex(value.keyHex)],
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

  it('matches the shared type-5 schema-2 frame', () => {
    const payload = cborMap([
      [0, C.network],
      [1, accountMap(C.sender)],
      [2, accountMap(C.recipient)],
      [3, 1],
      [4, fromHex(CORPUS.cryptoBox.envelopeHex)],
      [5, fromHex(C.ephemeralPointHex)],
      [6, fromHex(C.sharedPointHex)],
      [7, fromHex(C.dleqProofHex)],
    ])
    expect(
      toHex(
        encodeFrame(
          { typeId: 5, schemaVersion: 2, minReaderVersion: 2 },
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
})
