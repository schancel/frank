import { type6Frame, rev8Frame, textItem, bytesOf } from '../fixtures/builders'
import {
  decodeEncryptedMessageContent,
  decodeTokenTransfer,
  encodeEncryptedMessageContent,
  encodeTokenTransfer,
  encodeTokenTransferMap,
  validateFrame,
  defaultContext,
  FrankCodecError,
  cborMap,
  encodeCanonical,
  encodeFrame,
  TYPE_ENCRYPTED_MESSAGE_CONTENT,
} from '../src'
import type { TokenTransfer } from '../src'

describe('Type 6 CBOR token transfer (tickets #1152, #1153)', () => {
  const sampleTransfer: TokenTransfer = {
    chainNamespace: 'monad',
    contractAddress: '0xf817257fed379853cDe0fa4F97AB987181B1E5Ea',
    amount: 50_000_000n, // 50 USDC (6 decimals)
    decimals: 6,
    symbol: 'USDC',
  }

  const sampleTransferWithPermit: TokenTransfer = {
    chainNamespace: 'ethereum',
    contractAddress: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
    amount: 1_000_000_000_000_000_000n,
    decimals: 18,
    symbol: 'AVU',
    rawTxOrPermit: new Uint8Array([0xde, 0xad, 0xbe, 0xef, 0x01, 0x02]),
  }

  describe('TokenTransfer standalone codec', () => {
    it('round-trips encode and decode for TokenTransfer without rawTxOrPermit', () => {
      const encoded = encodeTokenTransfer(sampleTransfer)
      expect(encoded).toBeInstanceOf(Uint8Array)
      const decoded = decodeTokenTransfer(encoded)
      expect(decoded).toEqual(sampleTransfer)
    })

    it('round-trips encode and decode for TokenTransfer with rawTxOrPermit', () => {
      const encoded = encodeTokenTransfer(sampleTransferWithPermit)
      expect(encoded).toBeInstanceOf(Uint8Array)
      const decoded = decodeTokenTransfer(encoded)
      expect(decoded.chainNamespace).toBe('ethereum')
      expect(decoded.contractAddress).toBe(
        '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
      )
      expect(decoded.amount).toBe(1_000_000_000_000_000_000n)
      expect(decoded.decimals).toBe(18)
      expect(decoded.symbol).toBe('AVU')
      expect(decoded.rawTxOrPermit).toEqual(
        sampleTransferWithPermit.rawTxOrPermit,
      )
    })
  })

  describe('Type 6 EncryptedMessageContent wire format with and without tokenTransfer', () => {
    const rev8 = rev8Frame([textItem('Hello with payment')])
    const convId = bytesOf(16, 42)
    const msgId = bytesOf(16, 7)

    it('round-trips Type 6 message-content without tokenTransfer', () => {
      const frameBytes = encodeEncryptedMessageContent({
        network: 'frank-test',
        messageId: msgId,
        conversationId: convId,
        revisionFrame: rev8,
        conversationName: 'General Chat',
      })

      const decoded = decodeEncryptedMessageContent(frameBytes)
      expect(decoded.type).toBe(6)
      expect(decoded.network).toBe('frank-test')
      expect(decoded.conversationName).toBe('General Chat')
      expect(decoded.tokenTransfer).toBeUndefined()
    })

    it('round-trips Type 6 message-content with tokenTransfer', () => {
      const frameBytes = encodeEncryptedMessageContent({
        network: 'frank-test',
        messageId: msgId,
        conversationId: convId,
        revisionFrame: rev8,
        conversationName: 'Token Transfer Chat',
        tokenTransfer: sampleTransfer,
      })

      const decoded = decodeEncryptedMessageContent(frameBytes)
      expect(decoded.type).toBe(6)
      expect(decoded.network).toBe('frank-test')
      expect(decoded.conversationName).toBe('Token Transfer Chat')
      expect(decoded.tokenTransfer).toBeDefined()
      expect(decoded.tokenTransfer).toEqual(sampleTransfer)
    })

    it('round-trips Type 6 message-content built via type6Frame fixture builder', () => {
      const frameBytes = type6Frame(
        rev8,
        convId,
        'Direct Payment',
        sampleTransferWithPermit,
      )

      const parsed = validateFrame(frameBytes, defaultContext())
      expect(parsed.kind).toBe('parsed')
      if (parsed.kind !== 'parsed') throw new Error('expected parsed')

      expect(parsed.typed?.type).toBe(6)
      if (parsed.typed?.type !== 6) throw new Error('expected type 6')

      expect(parsed.typed.conversationName).toBe('Direct Payment')
      expect(parsed.typed.tokenTransfer).toBeDefined()
      expect(parsed.typed.tokenTransfer?.chainNamespace).toBe('ethereum')
      expect(parsed.typed.tokenTransfer?.contractAddress).toBe(
        '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
      )
      expect(parsed.typed.tokenTransfer?.amount).toBe(
        1_000_000_000_000_000_000n,
      )
      expect(parsed.typed.tokenTransfer?.decimals).toBe(18)
      expect(parsed.typed.tokenTransfer?.symbol).toBe('AVU')
      expect(parsed.typed.tokenTransfer?.rawTxOrPermit).toEqual(
        sampleTransferWithPermit.rawTxOrPermit,
      )
    })
  })

  describe('Validation & error handling', () => {
    const rev8 = rev8Frame()
    const convId = bytesOf(16, 1)
    const msgId = bytesOf(16, 2)

    it('rejects token transfer with non-positive amount during encoding', () => {
      expect(() =>
        encodeTokenTransfer({
          ...sampleTransfer,
          amount: 0n,
        }),
      ).toThrow(FrankCodecError)

      expect(() =>
        encodeTokenTransfer({
          ...sampleTransfer,
          amount: -10n,
        }),
      ).toThrow(FrankCodecError)
    })

    it('rejects token transfer with invalid decimals during encoding', () => {
      expect(() =>
        encodeTokenTransfer({
          ...sampleTransfer,
          decimals: -1,
        }),
      ).toThrow(FrankCodecError)

      expect(() =>
        encodeTokenTransfer({
          ...sampleTransfer,
          decimals: 300,
        }),
      ).toThrow(FrankCodecError)
    })

    it('rejects token transfer with empty strings during encoding', () => {
      expect(() =>
        encodeTokenTransfer({
          ...sampleTransfer,
          chainNamespace: '',
        }),
      ).toThrow(FrankCodecError)

      expect(() =>
        encodeTokenTransfer({
          ...sampleTransfer,
          contractAddress: '   ',
        }),
      ).toThrow(FrankCodecError)

      expect(() =>
        encodeTokenTransfer({
          ...sampleTransfer,
          symbol: '',
        }),
      ).toThrow(FrankCodecError)
    })

    it('rejects token transfer with empty rawTxOrPermit byte string', () => {
      expect(() =>
        encodeTokenTransfer({
          ...sampleTransfer,
          rawTxOrPermit: new Uint8Array([]),
        }),
      ).toThrow(FrankCodecError)
    })

    it('rejects missing required fields in tokenTransfer CBOR payload at schema stage', () => {
      // Map missing key 5 (symbol)
      const badMap = cborMap([
        [1, 'monad'],
        [2, '0x1234'],
        [3, 100n],
        [4, 18],
      ])
      const badBytes = encodeCanonical(badMap)
      expect(() => decodeTokenTransfer(badBytes)).toThrow(
        /missing required key 5/,
      )
    })

    it('rejects undeclared key in tokenTransfer at schema stage', () => {
      const badMap = cborMap([
        [1, 'monad'],
        [2, '0x1234'],
        [3, 100n],
        [4, 18],
        [5, 'USDC'],
        [99, 'extra'],
      ])
      const badBytes = encodeCanonical(badMap)
      expect(() => decodeTokenTransfer(badBytes)).toThrow(/undeclared key 99/)
    })

    it('rejects zero amount in Type 6 validation during semantic stage', () => {
      // Construct raw Type 6 frame with amount = 0
      const transferMap = cborMap([
        [1, 'monad'],
        [2, '0x1234567890123456789012345678901234567890'],
        [3, 0n],
        [4, 6],
        [5, 'USDC'],
      ])
      const payloadMap = cborMap([
        [0, 'frank-test'],
        [1, msgId],
        [2, rev8],
        [3, new Uint8Array(32)],
        [4, convId],
        [6, transferMap],
      ])
      const frame = encodeFrame(
        {
          typeId: TYPE_ENCRYPTED_MESSAGE_CONTENT,
          schemaVersion: 1,
          minReaderVersion: 1,
        },
        { bytes: encodeCanonical(payloadMap) },
      )
      expect(() => validateFrame(frame, defaultContext())).toThrow(
        /token transfer amount must be positive/,
      )
    })
  })
})
