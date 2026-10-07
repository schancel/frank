import {
  decodeCanonical,
  encodeCanonical,
  encodePaymentTransfer,
  decodePaymentTransfer,
  projectPaymentTransfer,
  paymentTransferToCborMap,
  paymentTransfer,
  stealthMetadata,
  paymentTransferFromMember,
  paymentTransferToMember,
  paymentTransferFromStealthItem,
  paymentTransferToStealthItem,
  fromHex,
  toHex,
  FrankCodecError,
  type PaymentTransfer,
  type PaymentMember,
  type CanonicalPaymentTransfer,
  type StealthMetadata,
} from '../src'

function mapOf(entries: Array<[number | bigint, any]>): Map<bigint, any> {
  return new Map(entries.map(([k, v]) => [BigInt(k), v]))
}

describe('unified payment transfer schema and codec (Issue #948)', () => {
  const sampleNetwork = 'monad-testnet'
  const sampleTxId = 'aa'.repeat(32)
  const sampleTxIdBytes = fromHex(sampleTxId)
  const sampleDest = 'bb'.repeat(20)
  const sampleDestBytes = fromHex(sampleDest)
  const sampleToken = 'cc'.repeat(20)
  const sampleTokenBytes = fromHex(sampleToken)
  const sampleCommitment = 'dd'.repeat(32)
  const sampleCommitmentBytes = fromHex(sampleCommitment)

  const sampleSecpPub = '02' + '11'.repeat(32) // 33 bytes compressed
  const sampleSecpPubBytes = fromHex(sampleSecpPub)
  const sampleEdPub = '22'.repeat(32) // 32 bytes ed25519
  const sampleEdPubBytes = fromHex(sampleEdPub)

  describe('schema validation: paymentTransfer and stealthMetadata', () => {
    it('validates minimal valid payment-transfer with uint satoshis', () => {
      const map = mapOf([
        [0, sampleNetwork],
        [1, sampleTxIdBytes],
        [3, sampleDestBytes],
        [4, 50000n],
      ])

      const parsed = paymentTransfer(map)
      expect(parsed.networkTag).toBe(sampleNetwork)
      expect(toHex(parsed.txId)).toBe(sampleTxId)
      expect(parsed.vout).toBeUndefined()
      expect(toHex(parsed.destination)).toBe(sampleDest)
      expect(parsed.value).toBe(50000n)
      expect(parsed.token).toBeUndefined()
      expect(parsed.stealthMetadata).toBeUndefined()
      expect(parsed.commitment).toBeUndefined()
    })

    it('validates minimal valid payment-transfer with 32-byte EVM quantity', () => {
      const evmQty = fromHex('00'.repeat(30) + '04d2') // 1234
      const map = mapOf([
        [0, sampleNetwork],
        [1, sampleTxIdBytes],
        [3, sampleDestBytes],
        [4, evmQty],
      ])

      const parsed = paymentTransfer(map)
      expect(parsed.value).toBeInstanceOf(Uint8Array)
      expect(toHex(parsed.value as Uint8Array)).toBe(toHex(evmQty))
    })

    it('validates payment-transfer with all fields populated (UTXO, token, stealth, commitment)', () => {
      const stealthMap = mapOf([
        [
          0,
          mapOf([
            [0, 1n],
            [1, sampleSecpPubBytes],
          ]),
        ],
        [1, 0x2an], // view tag
      ])

      const map = mapOf([
        [0, sampleNetwork],
        [1, sampleTxIdBytes],
        [2, 3n], // vout
        [3, sampleDestBytes],
        [4, 1000000n],
        [5, sampleTokenBytes],
        [6, stealthMap],
        [7, sampleCommitmentBytes],
      ])

      const parsed = paymentTransfer(map)
      expect(parsed.networkTag).toBe(sampleNetwork)
      expect(toHex(parsed.txId)).toBe(sampleTxId)
      expect(parsed.vout).toBe(3)
      expect(toHex(parsed.destination)).toBe(sampleDest)
      expect(parsed.value).toBe(1000000n)
      expect(toHex(parsed.token!)).toBe(sampleToken)
      expect(toHex(parsed.commitment!)).toBe(sampleCommitment)
      expect(parsed.stealthMetadata).toBeDefined()
      expect(parsed.stealthMetadata?.ephemeralPubKey.keyType).toBe(1)
      expect(toHex(parsed.stealthMetadata!.ephemeralPubKey.keyBytes)).toBe(
        sampleSecpPub,
      )
      expect(parsed.stealthMetadata?.viewTag).toBe(0x2a)
    })

    it('validates stealth-metadata with byte-string view tag', () => {
      const viewTagBytes = new Uint8Array([0x01, 0x02, 0x03, 0x04])
      const stealthMap = mapOf([
        [
          0,
          mapOf([
            [0, 2n],
            [1, sampleEdPubBytes],
          ]),
        ],
        [1, viewTagBytes],
      ])

      const parsed = stealthMetadata(stealthMap)
      expect(parsed.ephemeralPubKey.keyType).toBe(2)
      expect(toHex(parsed.ephemeralPubKey.keyBytes)).toBe(sampleEdPub)
      expect(parsed.viewTag).toEqual(viewTagBytes)
    })

    it('validates stealth-metadata without view tag', () => {
      const stealthMap = mapOf([
        [
          0,
          mapOf([
            [0, 1n],
            [1, sampleSecpPubBytes],
          ]),
        ],
      ])

      const parsed = stealthMetadata(stealthMap)
      expect(parsed.ephemeralPubKey.keyType).toBe(1)
      expect(parsed.viewTag).toBeUndefined()
    })

    it('rejects non-map inputs', () => {
      expect(() => paymentTransfer('not a map' as any)).toThrow(FrankCodecError)
      expect(() => paymentTransfer(123 as any)).toThrow(FrankCodecError)
      expect(() => paymentTransfer(null as any)).toThrow(FrankCodecError)
      expect(() => paymentTransfer([] as any)).toThrow(FrankCodecError)
    })

    it('rejects missing required fields', () => {
      // Missing key 0
      expect(() =>
        paymentTransfer(
          mapOf([
            [1, sampleTxIdBytes],
            [3, sampleDestBytes],
            [4, 100n],
          ]),
        ),
      ).toThrow(/missing required key 0/)

      // Missing key 1
      expect(() =>
        paymentTransfer(
          mapOf([
            [0, sampleNetwork],
            [3, sampleDestBytes],
            [4, 100n],
          ]),
        ),
      ).toThrow(/missing required key 1/)

      // Missing key 3
      expect(() =>
        paymentTransfer(
          mapOf([
            [0, sampleNetwork],
            [1, sampleTxIdBytes],
            [4, 100n],
          ]),
        ),
      ).toThrow(/missing required key 3/)

      // Missing key 4
      expect(() =>
        paymentTransfer(
          mapOf([
            [0, sampleNetwork],
            [1, sampleTxIdBytes],
            [3, sampleDestBytes],
          ]),
        ),
      ).toThrow(/missing required key 4/)
    })

    it('rejects undeclared keys (C12 closed schema rule)', () => {
      expect(() =>
        paymentTransfer(
          mapOf([
            [0, sampleNetwork],
            [1, sampleTxIdBytes],
            [3, sampleDestBytes],
            [4, 100n],
            [9, 'unexpected'],
          ]),
        ),
      ).toThrow(/undeclared key 9/)
    })

    it('rejects invalid field bounds and types', () => {
      // Empty networkTag
      expect(() =>
        paymentTransfer(
          mapOf([
            [0, ''],
            [1, sampleTxIdBytes],
            [3, sampleDestBytes],
            [4, 100n],
          ]),
        ),
      ).toThrow(/text size outside 1..64/)

      // NetworkTag too long (>64)
      expect(() =>
        paymentTransfer(
          mapOf([
            [0, 'a'.repeat(65)],
            [1, sampleTxIdBytes],
            [3, sampleDestBytes],
            [4, 100n],
          ]),
        ),
      ).toThrow(/text size outside 1..64/)

      // Empty txId
      expect(() =>
        paymentTransfer(
          mapOf([
            [0, sampleNetwork],
            [1, new Uint8Array(0)],
            [3, sampleDestBytes],
            [4, 100n],
          ]),
        ),
      ).toThrow(/byte string size outside 1..128/)

      // txId too long (>128)
      expect(() =>
        paymentTransfer(
          mapOf([
            [0, sampleNetwork],
            [1, new Uint8Array(129)],
            [3, sampleDestBytes],
            [4, 100n],
          ]),
        ),
      ).toThrow(/byte string size outside 1..128/)

      // rawTx too long (>16384)
      expect(() =>
        paymentTransfer(
          mapOf([
            [0, sampleNetwork],
            [1, sampleTxIdBytes],
            [3, sampleDestBytes],
            [4, 100n],
            [8, new Uint8Array(16385)],
          ]),
        ),
      ).toThrow(/byte string size outside 1..16384/)

      // vout negative or exceeding u32
      expect(() =>
        paymentTransfer(
          mapOf([
            [0, sampleNetwork],
            [1, sampleTxIdBytes],
            [2, 4294967296n],
            [3, sampleDestBytes],
            [4, 100n],
          ]),
        ),
      ).toThrow(/integer outside/)

      // destination empty
      expect(() =>
        paymentTransfer(
          mapOf([
            [0, sampleNetwork],
            [1, sampleTxIdBytes],
            [3, new Uint8Array(0)],
            [4, 100n],
          ]),
        ),
      ).toThrow(/byte string size outside 1..128/)

      // value not 32-byte bstr and not uint
      expect(() =>
        paymentTransfer(
          mapOf([
            [0, sampleNetwork],
            [1, sampleTxIdBytes],
            [3, sampleDestBytes],
            [4, 'invalid-value'],
          ]),
        ),
      ).toThrow(/expected a 32-byte string or an unsigned integer/)

      // commitment not 32 bytes
      expect(() =>
        paymentTransfer(
          mapOf([
            [0, sampleNetwork],
            [1, sampleTxIdBytes],
            [3, sampleDestBytes],
            [4, 100n],
            [7, new Uint8Array(31)],
          ]),
        ),
      ).toThrow(/byte string size outside 32..32/)
    })

    it('rejects invalid stealth-metadata', () => {
      // not a map
      expect(() => stealthMetadata('bad' as any)).toThrow(FrankCodecError)

      // missing key 0 (ephemeral-pubkey)
      expect(() => stealthMetadata(mapOf([[1, 42n]]))).toThrow(
        /missing required key 0/,
      )

      // keyType 1 with mismatched length (expects 33, given 32)
      expect(() =>
        stealthMetadata(
          mapOf([
            [
              0,
              mapOf([
                [0, 1n],
                [1, sampleEdPubBytes],
              ]),
            ],
          ]),
        ),
      ).toThrow(/requires 33 key bytes/)

      // keyType 2 with mismatched length (expects 32, given 33)
      expect(() =>
        stealthMetadata(
          mapOf([
            [
              0,
              mapOf([
                [0, 2n],
                [1, sampleSecpPubBytes],
              ]),
            ],
          ]),
        ),
      ).toThrow(/requires 32 key bytes/)

      // viewTag exceeding uint16
      expect(() =>
        stealthMetadata(
          mapOf([
            [
              0,
              mapOf([
                [0, 1n],
                [1, sampleSecpPubBytes],
              ]),
            ],
            [1, 65536n],
          ]),
        ),
      ).toThrow(/integer outside/)

      // extra key in stealth-metadata
      expect(() =>
        stealthMetadata(
          mapOf([
            [
              0,
              mapOf([
                [0, 1n],
                [1, sampleSecpPubBytes],
              ]),
            ],
            [2, 'unexpected'],
          ]),
        ),
      ).toThrow(/undeclared key 2/)
    })
  })

  describe('encoding, decoding, and round-trips', () => {
    it('encodes and decodes a minimal PaymentTransfer', () => {
      const transfer: PaymentTransfer = {
        networkTag: sampleNetwork,
        txId: sampleTxIdBytes,
        destination: sampleDestBytes,
        value: 123456n,
      }

      const encoded = encodePaymentTransfer(transfer)
      expect(encoded).toBeInstanceOf(Uint8Array)

      const decoded = decodePaymentTransfer(encoded)
      expect(decoded.networkTag).toBe(sampleNetwork)
      expect(toHex(decoded.txId)).toBe(sampleTxId)
      expect(toHex(decoded.destination)).toBe(sampleDest)
      expect(decoded.value).toBe(123456n)
      expect(decoded.vout).toBeUndefined()
      expect(decoded.token).toBeUndefined()
      expect(decoded.stealthMetadata).toBeUndefined()
      expect(decoded.commitment).toBeUndefined()
    })

    it('encodes and decodes from a CanonicalPaymentTransfer (hex strings)', () => {
      const canonical: CanonicalPaymentTransfer = {
        networkTag: sampleNetwork,
        txId: '0x' + sampleTxId,
        vout: 0,
        destination: '0x' + sampleDest,
        value: 99999,
        token: '0x' + sampleToken,
        stealthMetadata: {
          keyType: 1,
          ephemeralPubKey: '0x' + sampleSecpPub,
          viewTag: 0x5a,
        },
        commitment: '0x' + sampleCommitment,
      }

      const encoded = encodePaymentTransfer(canonical)
      const decoded = decodePaymentTransfer(encoded)

      expect(decoded.networkTag).toBe(sampleNetwork)
      expect(toHex(decoded.txId)).toBe(sampleTxId)
      expect(decoded.vout).toBe(0)
      expect(toHex(decoded.destination)).toBe(sampleDest)
      expect(decoded.value).toBe(99999n)
      expect(toHex(decoded.token!)).toBe(sampleToken)
      expect(toHex(decoded.commitment!)).toBe(sampleCommitment)
      expect(decoded.stealthMetadata?.ephemeralPubKey.keyType).toBe(1)
      expect(toHex(decoded.stealthMetadata!.ephemeralPubKey.keyBytes)).toBe(
        sampleSecpPub,
      )
      expect(decoded.stealthMetadata?.viewTag).toBe(0x5a)

      const projected = projectPaymentTransfer(decoded)
      expect(projected).toEqual({
        networkTag: sampleNetwork,
        txId: sampleTxId,
        vout: 0,
        destination: sampleDest,
        value: 99999n,
        token: sampleToken,
        stealthMetadata: {
          keyType: 1,
          ephemeralPubKey: sampleSecpPub,
          viewTag: 0x5a,
        },
        commitment: sampleCommitment,
      })
    })

    it('encodes and decodes a large 256-bit EVM value', () => {
      const largeValue = 2n ** 128n + 42n
      const canonical: CanonicalPaymentTransfer = {
        networkTag: sampleNetwork,
        txId: sampleTxId,
        destination: sampleDest,
        value: largeValue,
      }

      const encoded = encodePaymentTransfer(canonical)
      const decoded = decodePaymentTransfer(encoded)
      expect(decoded.value).toBeInstanceOf(Uint8Array)
      const decodedBigInt = BigInt('0x' + toHex(decoded.value as Uint8Array))
      expect(decodedBigInt).toBe(largeValue)
    })

    it('returns CBOR map representation with paymentTransferToCborMap', () => {
      const map = paymentTransferToCborMap({
        networkTag: sampleNetwork,
        txId: sampleTxIdBytes,
        destination: sampleDestBytes,
        value: 500n,
      })
      expect(map).toBeInstanceOf(Map)
      expect(map.get(0n)).toBe(sampleNetwork)
      expect(map.get(1n)).toEqual(sampleTxIdBytes)
      expect(map.get(3n)).toEqual(sampleDestBytes)
      expect(map.get(4n)).toBe(500n)
    })
  })

  describe('conversions: envelope stamps and in-chat stealth transfers', () => {
    it('converts PaymentMember (stamp) -> PaymentTransfer -> PaymentMember', () => {
      const member: PaymentMember = {
        childIndex: 5,
        transactionId: sampleTxIdBytes,
        value: 2500000000000000n,
        address: sampleDestBytes,
        commitment: sampleCommitmentBytes,
        vout: 1,
      }

      const transfer = paymentTransferFromMember(member, 'monad-testnet')
      expect(transfer.networkTag).toBe('monad-testnet')
      expect(transfer.txId).toEqual(member.transactionId)
      expect(transfer.vout).toBe(1)
      expect(transfer.destination).toEqual(member.address)
      expect(transfer.value).toBe(member.value)
      expect(transfer.commitment).toEqual(member.commitment)

      const roundTrip = paymentTransferToMember(transfer, 5)
      expect(roundTrip).toEqual(member)
    })

    it('rejects converting PaymentTransfer to PaymentMember without commitment', () => {
      const transfer: PaymentTransfer = {
        networkTag: 'monad-testnet',
        txId: sampleTxIdBytes,
        destination: sampleDestBytes,
        value: 100n,
      }

      expect(() => paymentTransferToMember(transfer)).toThrow(
        /must have a commitment/,
      )
    })

    it('converts StealthMessageItem -> PaymentTransfer -> CanonicalStealthItem', () => {
      const stealthTransfer = paymentTransferFromStealthItem(
        {
          type: 'stealth',
          networkTag: 'MONT',
          keyType: 1,
          ephemeralPubKey: sampleSecpPub,
          transactions: [sampleTxId],
          amount: 50000,
        },
        sampleDestBytes,
      )

      expect(stealthTransfer.networkTag).toBe('MONT')
      expect(toHex(stealthTransfer.txId)).toBe(sampleTxId)
      expect(toHex(stealthTransfer.destination)).toBe(sampleDest)
      expect(stealthTransfer.value).toBe(50000n)
      expect(stealthTransfer.stealthMetadata?.ephemeralPubKey.keyType).toBe(1)
      expect(
        toHex(stealthTransfer.stealthMetadata!.ephemeralPubKey.keyBytes),
      ).toBe(sampleSecpPub)

      const reconverted = paymentTransferToStealthItem(
        stealthTransfer,
        'Coffee payment',
      )
      expect(reconverted).toEqual({
        type: 'stealth',
        networkTag: 'MONT',
        keyType: 1,
        ephemeralPubKey: sampleSecpPub,
        transactions: [sampleTxId],
        amount: 50000n,
        memo: 'Coffee payment',
      })
    })

    it('rejects converting PaymentTransfer to stealth item without stealthMetadata', () => {
      const transfer: PaymentTransfer = {
        networkTag: 'MONT',
        txId: sampleTxIdBytes,
        destination: sampleDestBytes,
        value: 100n,
      }

      expect(() => paymentTransferToStealthItem(transfer)).toThrow(
        /must have stealthMetadata/,
      )
    })

    it('round-trips PaymentTransfer with rawTx and converts to/from PaymentMember', () => {
      const sampleRawTx = fromHex(
        '02f87082279f80843b9aca008502540be40082520894' +
          'ee'.repeat(20) +
          '830186a080c0',
      )
      const transfer: PaymentTransfer = {
        networkTag: sampleNetwork,
        txId: sampleTxIdBytes,
        destination: sampleDestBytes,
        value: 50000n,
        commitment: sampleCommitmentBytes,
        rawTx: sampleRawTx,
      }

      const encoded = encodePaymentTransfer(transfer)
      const decoded = decodePaymentTransfer(encoded)
      expect(decoded.rawTx).toBeDefined()
      expect(toHex(decoded.rawTx!)).toBe(toHex(sampleRawTx))

      const member = paymentTransferToMember(transfer, 5)
      expect(member.childIndex).toBe(5)
      expect(toHex(member.transactionId)).toBe(sampleTxId)
      expect(member.rawTx).toBeDefined()
      expect(toHex(member.rawTx!)).toBe(toHex(sampleRawTx))

      const back = paymentTransferFromMember(member, sampleNetwork)
      expect(back.rawTx).toBeDefined()
      expect(toHex(back.rawTx!)).toBe(toHex(sampleRawTx))
      expect(toHex(back.txId)).toBe(sampleTxId)

      const projected = projectPaymentTransfer(transfer)
      expect(projected.rawTx).toBe(toHex(sampleRawTx))
    })
  })
})
