import { secp256k1 } from '@noble/curves/secp256k1.js'
import * as codec from '../src'
import {
  FrankCodecError,
  defaultContext,
  directorySignatureDigest,
  encodeFrame,
  validateFrame,
  CANONICAL_USERNAME_REGEX,
  isValidCanonicalUsername,
} from '../src'
import { M } from '../fixtures/builders'

describe('Directory Statement Canonical Username (Field 14, Tickets 1.2 & 1.3)', () => {
  const secretKey = new Uint8Array(32).fill(0x2a)
  const secpKey = secp256k1.getPublicKey(secretKey, true)

  const makeRawStatement = (field14Value?: unknown) => {
    const fields: Array<[number | bigint, unknown]> = [
      [0, 'monad-testnet'],
      [
        1,
        M([
          [0, 1],
          [1, secpKey],
        ]),
      ],
      [2, 42n],
      [
        3,
        M([
          [0, 1700000000n],
          [1, 0],
        ]),
      ],
      [
        4,
        [
          M([
            [0, new Uint8Array(16).fill(1)],
            [1, 'https://relay1.example.com'],
            [
              2,
              M([
                [0, 1],
                [1, secpKey],
              ]),
            ],
            [
              3,
              M([
                [0, 1700003600n],
                [1, 0],
              ]),
            ],
          ]),
        ],
      ],
      [
        8,
        M([
          [0, 1],
          [1, secpKey],
        ]),
      ],
    ]

    if (field14Value !== undefined) {
      fields.push([14, field14Value])
    }

    return encodeFrame(
      { typeId: 4, schemaVersion: 3, minReaderVersion: 2 },
      M(fields),
    )
  }

  describe('Validation Rules (lowercase ASCII ^[a-z0-9][a-z0-9_-]{2,31}$)', () => {
    it('validates canonical usernames with helper functions and regex', () => {
      expect(CANONICAL_USERNAME_REGEX.test('alice')).toBe(true)
      expect(CANONICAL_USERNAME_REGEX.test('bob-42')).toBe(true)
      expect(CANONICAL_USERNAME_REGEX.test('charlie_dev')).toBe(true)
      expect(CANONICAL_USERNAME_REGEX.test('a'.repeat(32))).toBe(true)

      expect(CANONICAL_USERNAME_REGEX.test('ab')).toBe(false)
      expect(CANONICAL_USERNAME_REGEX.test('a'.repeat(33))).toBe(false)
      expect(CANONICAL_USERNAME_REGEX.test('Alice')).toBe(false)
      expect(CANONICAL_USERNAME_REGEX.test('-alice')).toBe(false)
      expect(CANONICAL_USERNAME_REGEX.test('_alice')).toBe(false)

      expect(isValidCanonicalUsername('alice')).toBe(true)
      expect(isValidCanonicalUsername('bob-42')).toBe(true)
      expect(isValidCanonicalUsername('charlie_dev')).toBe(true)
      expect(isValidCanonicalUsername('a'.repeat(32))).toBe(true)

      expect(isValidCanonicalUsername('ab')).toBe(false) // too short (< 3)
      expect(isValidCanonicalUsername('a'.repeat(33))).toBe(false) // too long (> 32)
      expect(isValidCanonicalUsername('Alice')).toBe(false) // uppercase
      expect(isValidCanonicalUsername('-alice')).toBe(false) // leading hyphen
      expect(isValidCanonicalUsername('_alice')).toBe(false) // leading underscore
      expect(isValidCanonicalUsername('alice.frank')).toBe(false) // invalid symbol '.'
      expect(isValidCanonicalUsername('alice frank')).toBe(false) // whitespace
      expect(isValidCanonicalUsername(12345)).toBe(false) // non-string
      expect(isValidCanonicalUsername(null)).toBe(false) // null
    })

    it('decodes and validates directory statements with valid canonical handles', () => {
      const validHandles = [
        'alice',
        'bob01',
        'carol-99',
        'dan_the_coder',
        'x-1',
        'z_2',
        '007',
        'a'.repeat(32),
      ]

      for (const handle of validHandles) {
        const frame = makeRawStatement(handle)
        const parsed = validateFrame(frame, defaultContext({ operation: 'typed' }))
        expect(parsed.kind).toBe('parsed')
        if (parsed.kind === 'parsed' && parsed.typed?.type === 4) {
          expect(parsed.typed.canonicalUsername).toBe(handle)
        }
      }
    })

    it('rejects uppercase characters, whitespace, and invalid symbols at stage 9 semantic', () => {
      const invalidHandles = [
        'Alice', // uppercase
        'ALICE', // all uppercase
        'aliceSmith', // camelCase
        'alice smith', // internal space
        ' alice', // leading space
        'alice ', // trailing space
        '-alice', // leading hyphen
        '_alice', // leading underscore
        'alice@domain', // @ symbol
        'alice.frank', // dot
        'alice#1', // hash
        'alice$pay', // dollar
        'alice!wow', // exclamation
        'alice:443', // colon
        'alice/path', // slash
      ]

      for (const handle of invalidHandles) {
        const frame = makeRawStatement(handle)
        const ctx = defaultContext({ operation: 'typed' })
        expect(() => validateFrame(frame, ctx)).toThrow(FrankCodecError)
        try {
          validateFrame(frame, ctx)
        } catch (e: unknown) {
          if (e instanceof FrankCodecError) {
            expect(e.category).toBe('semantic')
            expect(e.stage).toBe('9')
            expect(e.location).toBe('root/payload.14')
          } else {
            throw e
          }
        }
      }
    })

    it('rejects length bound violations and invalid CBOR types at stage 8.2 schema', () => {
      const schemaRejections = [
        '', // length 0
        'a', // length 1
        'ab', // length 2
        'a'.repeat(33), // length 33 (> 32)
        12345, // uint
        true, // bool
      ]

      for (const val of schemaRejections) {
        const frame = makeRawStatement(val)
        const ctx = defaultContext({ operation: 'typed' })
        expect(() => validateFrame(frame, ctx)).toThrow(FrankCodecError)
        try {
          validateFrame(frame, ctx)
        } catch (e: unknown) {
          if (e instanceof FrankCodecError) {
            expect(e.category).toBe('schema')
            expect(e.stage).toBe('8.2')
          } else {
            throw e
          }
        }
      }
    })
  })

  describe('Roundtrip Encoding and Decoding', () => {
    const relays = [
      {
        relayId: new Uint8Array(16).fill(0xaa),
        endpoint: 'https://relay.monad.xyz',
        identity: { keyType: 1, keyBytes: secpKey },
        expiry: { seconds: 1800000000n, nanoseconds: 0 },
        unknownFields: new Map(),
      },
    ]

    it('roundtrips a directory statement with canonicalUsername (key 14)', () => {
      const handle = 'alice-crypto_99'
      const encoded = codec.encodeDirectoryStatement({
        network: 'monad-mainnet',
        subject: { keyType: 1, keyBytes: secpKey },
        revision: 100n,
        timestamp: { seconds: 1750000000n, nanoseconds: 0 },
        relays,
        stampKey: { keyType: 1, keyBytes: secpKey },
        canonicalUsername: handle,
      })

      const decoded = validateFrame(encoded, defaultContext({ operation: 'typed' }))
      expect(decoded.kind).toBe('parsed')
      if (decoded.kind === 'parsed' && decoded.typed?.type === 4) {
        expect(decoded.typed.canonicalUsername).toBe(handle)
        expect(decoded.typed.network).toBe('monad-mainnet')
        expect(decoded.typed.revision).toBe(100n)
      }
    })

    it('roundtrips a directory statement without canonicalUsername (optional field 14)', () => {
      const encoded = codec.encodeDirectoryStatement({
        network: 'monad-mainnet',
        subject: { keyType: 1, keyBytes: secpKey },
        revision: 101n,
        timestamp: { seconds: 1750000000n, nanoseconds: 0 },
        relays,
        stampKey: { keyType: 1, keyBytes: secpKey },
      })

      const decoded = validateFrame(encoded, defaultContext({ operation: 'typed' }))
      expect(decoded.kind).toBe('parsed')
      if (decoded.kind === 'parsed' && decoded.typed?.type === 4) {
        expect(decoded.typed.canonicalUsername).toBeUndefined()
      }
    })

    it('verifies algorithm-1 signature on Type 2 DirectoryAttestation carrying canonicalUsername', () => {
      const network = 'monad-testnet'
      const type4Bytes = codec.encodeDirectoryStatement({
        network,
        subject: { keyType: 1, keyBytes: secpKey },
        revision: 1n,
        timestamp: { seconds: 1000n, nanoseconds: 0 },
        relays,
        stampKey: { keyType: 1, keyBytes: secpKey },
        canonicalUsername: 'authenticated-user',
      })

      const digest = directorySignatureDigest(network, type4Bytes)
      const sigDer = new Uint8Array(secp256k1.sign(digest, secretKey).toDERRawBytes())

      const type2Bytes = encodeFrame(
        { typeId: 2, schemaVersion: 1, minReaderVersion: 1 },
        M([
          [0, type4Bytes],
          [
            1,
            [
              M([
                [0, 1], // algorithm 1
                [
                  1,
                  M([
                    [0, 1],
                    [1, secpKey],
                  ]),
                ],
                [2, sigDer],
              ]),
            ],
          ],
        ]),
      )

      const result = validateFrame(
        type2Bytes,
        defaultContext({
          network,
          operation: 'full',
          currentTimeSeconds: 1000n,
        }),
      )

      expect(result.kind).toBe('parsed')
      if (result.kind === 'parsed' && result.typed?.type === 2) {
        const inner = result.typed.statementFrame.typed
        if (inner?.type === 4) {
          expect(inner.canonicalUsername).toBe('authenticated-user')
        }
      }

      // Tampering with canonicalUsername invalidates the signature at stage 10.6
      const tamperedType4 = codec.encodeDirectoryStatement({
        network,
        subject: { keyType: 1, keyBytes: secpKey },
        revision: 1n,
        timestamp: { seconds: 1000n, nanoseconds: 0 },
        relays,
        stampKey: { keyType: 1, keyBytes: secpKey },
        canonicalUsername: 'tampered-user',
      })

      const tamperedType2 = encodeFrame(
        { typeId: 2, schemaVersion: 1, minReaderVersion: 1 },
        M([
          [0, tamperedType4],
          [
            1,
            [
              M([
                [0, 1],
                [
                  1,
                  M([
                    [0, 1],
                    [1, secpKey],
                  ]),
                ],
                [2, sigDer],
              ]),
            ],
          ],
        ]),
      )

      expect(() =>
        validateFrame(
          tamperedType2,
          defaultContext({ network, operation: 'full' }),
        ),
      ).toThrow(FrankCodecError)
    })
  })
})
