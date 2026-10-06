import {
  defaultContext,
  encodeStealthMessageItem,
  isStealthMessageItemFrame,
  parseFrame,
  projectStealthMessageItem,
  validateFrame,
  FrankCodecError,
  TYPE_STEALTH_MESSAGE_ITEM,
  fromHex,
  toHex,
} from '../src'

describe('stealth message items (Type 19, schema 1)', () => {
  const sampleSecpPub =
    '02' + '11'.repeat(32) // 33 bytes compressed secp256k1
  const sampleEdPub = '22'.repeat(32) // 32 bytes ed25519
  const sampleTx1 = 'aabbccddeeff00112233445566778899'
  const sampleTx2 = '11223344556677889900aabbccddeeff'

  it('encodes and validates a secp256k1 stealth message item', () => {
    const rawFrame = encodeStealthMessageItem({
      type: 'stealth',
      networkTag: 'MONT',
      keyType: 1,
      ephemeralPubKey: sampleSecpPub,
      transactions: [sampleTx1, sampleTx2],
      amount: 1000000n,
      memo: 'Coffee payment',
    })

    const parsed = parseFrame(rawFrame)
    expect(parsed.kind).toBe('parsed')
    if (parsed.kind === 'parsed') {
      expect(parsed.typeId).toBe(TYPE_STEALTH_MESSAGE_ITEM)
      expect(parsed.schemaVersion).toBe(1)
      expect(parsed.minReaderVersion).toBe(1)
      expect(parsed.typed?.type).toBe(19)
      if (parsed.typed?.type === 19) {
        expect(parsed.typed.networkTag).toBe('MONT')
        expect(parsed.typed.ephemeralPubKey.keyType).toBe(1)
        expect(toHex(parsed.typed.ephemeralPubKey.keyBytes)).toBe(sampleSecpPub)
        expect(parsed.typed.transactions).toHaveLength(2)
        expect(toHex(parsed.typed.transactions[0])).toBe(sampleTx1)
        expect(toHex(parsed.typed.transactions[1])).toBe(sampleTx2)
        expect(parsed.typed.amount).toBe(1000000n)
        expect(parsed.typed.memo).toBe('Coffee payment')
      }

      expect(isStealthMessageItemFrame(parsed)).toBe(true)
      const projected = projectStealthMessageItem(parsed)
      expect(projected).toEqual({
        type: 'stealth',
        networkTag: 'MONT',
        keyType: 1,
        ephemeralPubKey: sampleSecpPub,
        transactions: [sampleTx1, sampleTx2],
        amount: 1000000,
        memo: 'Coffee payment',
      })
    }
  })

  it('encodes and validates an ed25519 stealth message item (Solana)', () => {
    const rawFrame = encodeStealthMessageItem({
      type: 'stealth',
      networkTag: 'SOLD',
      keyType: 2,
      ephemeralPubKey: sampleEdPub,
      transactions: [sampleTx1],
      amount: 500000000,
    })

    const parsed = parseFrame(rawFrame)
    expect(parsed.kind).toBe('parsed')
    if (parsed.kind === 'parsed' && parsed.typed?.type === 19) {
      expect(parsed.typed.networkTag).toBe('SOLD')
      expect(parsed.typed.ephemeralPubKey.keyType).toBe(2)
      expect(toHex(parsed.typed.ephemeralPubKey.keyBytes)).toBe(sampleEdPub)
      expect(parsed.typed.transactions).toHaveLength(1)
      expect(parsed.typed.memo).toBeUndefined()

      const projected = projectStealthMessageItem(parsed)
      expect(projected).toEqual({
        type: 'stealth',
        networkTag: 'SOLD',
        keyType: 2,
        ephemeralPubKey: sampleEdPub,
        transactions: [sampleTx1],
        amount: 500000000,
      })
    }
  })

  it('rejects invalid keyType or mismatched ephemeralPubKey length', () => {
    // keyType 1 expects 33 bytes, given 32 bytes
    expect(() =>
      encodeStealthMessageItem({
        type: 'stealth',
        networkTag: 'MONT',
        keyType: 1,
        ephemeralPubKey: sampleEdPub, // 32 bytes
        transactions: [sampleTx1],
        amount: 100,
      }),
    ).toThrow(/ephemeralPubKey length mismatch/)

    // keyType 2 expects 32 bytes, given 33 bytes
    expect(() =>
      encodeStealthMessageItem({
        type: 'stealth',
        networkTag: 'SOLD',
        keyType: 2,
        ephemeralPubKey: sampleSecpPub, // 33 bytes
        transactions: [sampleTx1],
        amount: 100,
      }),
    ).toThrow(/ephemeralPubKey length mismatch/)

    // invalid keyType 3
    expect(() =>
      encodeStealthMessageItem({
        type: 'stealth',
        networkTag: 'MONT',
        keyType: 3 as any,
        ephemeralPubKey: sampleSecpPub,
        transactions: [sampleTx1],
        amount: 100,
      }),
    ).toThrow(/keyType must be 1 or 2/)
  })

  it('rejects empty transactions list or list exceeding 16 items', () => {
    expect(() =>
      encodeStealthMessageItem({
        type: 'stealth',
        networkTag: 'MONT',
        keyType: 1,
        ephemeralPubKey: sampleSecpPub,
        transactions: [],
        amount: 100,
      }),
    ).toThrow(/transactions must be a non-empty array/)

    const tooMany = Array.from({ length: 17 }, () => sampleTx1)
    expect(() =>
      encodeStealthMessageItem({
        type: 'stealth',
        networkTag: 'MONT',
        keyType: 1,
        ephemeralPubKey: sampleSecpPub,
        transactions: tooMany,
        amount: 100,
      }),
    ).toThrow(/transactions array cannot exceed 16 items/)
  })

  it('rejects negative amount', () => {
    expect(() =>
      encodeStealthMessageItem({
        type: 'stealth',
        networkTag: 'MONT',
        keyType: 1,
        ephemeralPubKey: sampleSecpPub,
        transactions: [sampleTx1],
        amount: -5,
      }),
    ).toThrow(/amount cannot be negative/)
  })
})
