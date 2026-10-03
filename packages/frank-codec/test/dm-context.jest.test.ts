import { readFileSync } from 'fs'
import { join } from 'path'

import {
  DM_CRYPTO_CONTEXT_DOMAIN,
  encodeDirectMessageCryptoContext,
  toHex,
  type DirectMessageCryptoContext,
} from '../src'

const bytes = (length: number, value: number) =>
  new Uint8Array(length).fill(value)
const point = (prefix: number, value: number) =>
  Uint8Array.from([prefix, ...bytes(32, value)])

const VECTOR: DirectMessageCryptoContext = {
  network: 'monad-testnet',
  sender: { keyType: 1, keyBytes: point(2, 0x11) },
  recipient: { keyType: 2, keyBytes: bytes(32, 0x22) },
  senderDirectoryHash: bytes(32, 0xaa),
  recipientDirectoryHash: bytes(32, 0xbb),
  senderMessageKey: { keyType: 1, keyBytes: point(2, 0x33) },
  recipientMessageKey: { keyType: 1, keyBytes: point(3, 0x44) },
  stampKey: { keyType: 1, keyBytes: point(2, 0x55) },
  ephemeralPoint: point(3, 0x66),
  sharedPoint: point(2, 0x77),
  dleqProof: bytes(64, 0x88),
}
const CORPUS = JSON.parse(
  readFileSync(
    join(__dirname, '../../../docs/protocol/cbor/vectors/dm-suite-1.json'),
    'utf8',
  ),
) as { context: { encodedHex: string } }

describe('DM crypto context v1', () => {
  it('matches the shared TypeScript/Rust vector', () => {
    expect(DM_CRYPTO_CONTEXT_DOMAIN).toBe('frank/dm-crypto-context/v1')
    expect(toHex(encodeDirectMessageCryptoContext(VECTOR))).toBe(
      CORPUS.context.encodedHex,
    )
  })

  it.each([
    'network',
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
    else if (field.endsWith('Key')) {
      const prior = VECTOR[field]
      changed[field] = { ...prior, keyBytes: point(2, 0x99) }
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
    ).toThrow('exactly 64 bytes')
  })
})
