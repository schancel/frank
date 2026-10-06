import { secp256k1 } from '@noble/curves/secp256k1.js'

import {
  cborMap,
  channelStateDigest,
  decodeAppPayload,
  decodeDiceGamePayload,
  decodePokerGamePayload,
  decodeRafflePayload,
  decodeSwapOfferPayload,
  encodeChannelUpdateItem,
  encodeDiceGamePayload,
  encodeFrame,
  encodePokerGamePayload,
  encodeRafflePayload,
  encodeSwapOfferPayload,
  FrankCodecError,
  fromHex,
  isChannelUpdateItemFrame,
  parseFrame,
  projectChannelUpdateItem,
  toHex,
  TYPE_CHANNEL_UPDATE,
  TYPE_MESSAGE_CONTENT_REVISION,
  validateAppState,
  validateChannelSequence,
  validateChannelTransition,
  validateDiceGamePayload,
  validateFrame,
  validatePokerGamePayload,
  validateRafflePayload,
  validateSwapOfferPayload,
  verifyAlgorithm1,
  verifyChannelSignature,
  verifyChannelSignatures,
  type CanonicalChannelUpdateItem,
  type ChannelUpdateItem,
  type DiceGamePayload,
  type PokerGamePayload,
  type RafflePayload,
  type SwapOfferPayload,
} from '../src'

describe('universal state channel update item (Type 24, schema 1)', () => {
  // Keypairs for participants Alice and Bob
  const alicePriv = fromHex('01'.repeat(32))
  const alicePub = secp256k1.getPublicKey(alicePriv, true) // 33 bytes compressed
  const alicePubHex = toHex(alicePub)

  const bobPriv = fromHex('02'.repeat(32))
  const bobPub = secp256k1.getPublicKey(bobPriv, true) // 33 bytes compressed
  const bobPubHex = toHex(bobPub)

  const signDer = (digest: Uint8Array, priv: Uint8Array): Uint8Array =>
    new Uint8Array(secp256k1.sign(digest, priv).toDERRawBytes())

  const sampleChannelId = 'aa'.repeat(32) // 32 bytes hex
  const sampleTokenId = 'bb'.repeat(20) // 20-byte token address

  // -------------------------------------------------------------------------------------------
  // 1. Single-chain allocation
  // -------------------------------------------------------------------------------------------
  describe('single-chain allocation', () => {
    it('encodes, validates, and projects a valid single-chain channel update item', () => {
      const stateBytes = new Uint8Array([1, 2, 3, 4, 5])
      const allocations = [
        {
          networkTag: 'mont',
          token: '', // native currency
          balances: [
            {
              participant: { keyType: 1, pubKey: alicePubHex },
              balance: 1000000n,
            },
            {
              participant: { keyType: 1, pubKey: bobPubHex },
              balance: 2000000n,
            },
          ],
        },
      ]

      const digest = channelStateDigest({
        channelId: sampleChannelId,
        appId: 'dice',
        sequenceNumber: 0,
        allocations,
        appState: stateBytes,
      })

      const aliceSig = signDer(digest, alicePriv)

      const canonicalItem: CanonicalChannelUpdateItem = {
        type: 'channel-update',
        channelId: sampleChannelId,
        appId: 'dice',
        sequenceNumber: 0,
        allocations,
        appState: stateBytes,
        signatures: [
          {
            algorithm: 1,
            signer: { keyType: 1, pubKey: alicePubHex },
            signature: toHex(aliceSig),
          },
        ],
      }

      const rawFrame = encodeChannelUpdateItem(canonicalItem)
      const parsed = parseFrame(rawFrame)

      expect(parsed.kind).toBe('parsed')
      if (parsed.kind === 'parsed') {
        expect(parsed.typeId).toBe(TYPE_CHANNEL_UPDATE)
        expect(parsed.schemaVersion).toBe(1)
        expect(parsed.minReaderVersion).toBe(1)
        expect(parsed.typed?.type).toBe(24)

        if (parsed.typed?.type === 24) {
          expect(toHex(parsed.typed.channelId)).toBe(sampleChannelId)
          expect(parsed.typed.appId).toBe('dice')
          expect(parsed.typed.sequenceNumber).toBe(0)
          expect(parsed.typed.allocations).toHaveLength(1)
          expect(parsed.typed.allocations[0].networkTag).toBe('mont')
          expect(parsed.typed.allocations[0].token).toHaveLength(0)
          expect(parsed.typed.allocations[0].balances).toHaveLength(2)
          expect(parsed.typed.allocations[0].balances[0].balance).toBe(1000000n)
          expect(parsed.typed.allocations[0].balances[1].balance).toBe(2000000n)
          expect(parsed.typed.signatures).toHaveLength(1)
          expect(parsed.typed.signatures[0].algorithm).toBe(1)
          expect(toHex(parsed.typed.signatures[0].signer.keyBytes)).toBe(alicePubHex)
          expect(toHex(parsed.typed.signatures[0].signature)).toBe(toHex(aliceSig))
        }

        expect(isChannelUpdateItemFrame(parsed)).toBe(true)
        const projected = projectChannelUpdateItem(parsed)
        expect(projected.channelId).toBe(sampleChannelId)
        expect(projected.appId).toBe('dice')
        expect(projected.sequenceNumber).toBe(0)
        expect(projected.allocations).toHaveLength(1)
        expect(projected.allocations[0].balances).toHaveLength(2)
        expect(projected.allocations[0].balances[0].balance).toBe('1000000')
        expect(projected.allocations[0].balances[1].balance).toBe('2000000')
        expect(projected.signatures).toHaveLength(1)
      }
    })
  })

  // -------------------------------------------------------------------------------------------
  // 2. Multi-chain allocation
  // -------------------------------------------------------------------------------------------
  describe('multi-chain allocation', () => {
    it('encodes and validates channel update items across multiple networks and tokens', () => {
      const charliePriv = fromHex('03'.repeat(32))
      const charliePub = secp256k1.getPublicKey(charliePriv, true)
      const charliePubHex = toHex(charliePub)

      const stateBytes = new Uint8Array([0xde, 0xad, 0xbe, 0xef])
      const settlementRef = fromHex('cc'.repeat(32)) // optional settlement contract script

      const multiChainAllocations = [
        {
          networkTag: 'mont',
          token: sampleTokenId, // ERC20 on Monad
          balances: [
            {
              participant: { keyType: 1, pubKey: alicePubHex },
              balance: 500000000000000000n,
            },
            {
              participant: { keyType: 1, pubKey: bobPubHex },
              balance: 250000000000000000n,
            },
          ],
        },
        {
          networkTag: 'sold',
          token: '', // native SOL
          balances: [
            {
              participant: { keyType: 1, pubKey: alicePubHex },
              balance: 1000000000n,
            },
            {
              participant: { keyType: 1, pubKey: charliePubHex },
              balance: 2000000000n,
            },
          ],
        },
      ]

      const digest = channelStateDigest({
        channelId: sampleChannelId,
        appId: 'swap',
        sequenceNumber: 15,
        allocations: multiChainAllocations,
        appState: stateBytes,
        settlementRef,
      })

      const aliceSig = signDer(digest, alicePriv)
      const bobSig = signDer(digest, bobPriv)

      const item: CanonicalChannelUpdateItem = {
        type: 'channel-update',
        channelId: sampleChannelId,
        appId: 'swap',
        sequenceNumber: 15,
        allocations: multiChainAllocations,
        appState: stateBytes,
        signatures: [
          {
            algorithm: 1,
            signer: { keyType: 1, pubKey: alicePubHex },
            signature: toHex(aliceSig),
          },
          {
            algorithm: 1,
            signer: { keyType: 1, pubKey: bobPubHex },
            signature: toHex(bobSig),
          },
        ],
        settlementRef: toHex(settlementRef),
      }

      const frameBytes = encodeChannelUpdateItem(item)
      const parsed = parseFrame(frameBytes)

      expect(parsed.kind).toBe('parsed')
      if (parsed.kind === 'parsed' && parsed.typed?.type === 24) {
        expect(parsed.typed.allocations).toHaveLength(2)
        expect(parsed.typed.allocations[0].networkTag).toBe('mont')
        expect(toHex(parsed.typed.allocations[0].token)).toBe(sampleTokenId)
        expect(parsed.typed.allocations[1].networkTag).toBe('sold')
        expect(parsed.typed.signatures).toHaveLength(2)
        expect(parsed.typed.settlementRef).toBeDefined()
        expect(toHex(parsed.typed.settlementRef!)).toBe(toHex(settlementRef))

        const projected = projectChannelUpdateItem(parsed)
        expect(projected.allocations).toHaveLength(2)
        expect(projected.settlementRef).toBe(toHex(settlementRef))
      }
    })
  })

  // -------------------------------------------------------------------------------------------
  // 3. Modular Application Schemas (Dice, Poker, Swaps, Raffles)
  // -------------------------------------------------------------------------------------------
  describe('modular application schemas', () => {
    // --- Dice ---
    describe('dice-game-payload', () => {
      it('encodes, validates, and decodes a dice game payload (commit, reveal, roll)', () => {
        const seedCommitment = fromHex('11'.repeat(32))
        const revealSeed = fromHex('22'.repeat(32))

        // Commit phase
        const commitPayload: DiceGamePayload = {
          round: 1,
          action: 'commit',
          seedCommitment,
          wager: 1000000n,
        }
        validateDiceGamePayload(commitPayload)
        const commitBytes = encodeDiceGamePayload(commitPayload)
        const decodedCommit = decodeDiceGamePayload(commitBytes)
        expect(decodedCommit.round).toBe(1n)
        expect(decodedCommit.action).toBe('commit')
        expect(toHex(decodedCommit.seedCommitment)).toBe(toHex(seedCommitment))
        expect(decodedCommit.wager).toBe(1000000n)

        // Reveal phase
        const revealPayload: DiceGamePayload = {
          round: 1,
          action: 'reveal',
          seedCommitment,
          revealSeed,
          wager: 1000000n,
        }
        const revealBytes = encodeDiceGamePayload(revealPayload)
        const decodedReveal = decodeDiceGamePayload(revealBytes)
        expect(decodedReveal.action).toBe('reveal')
        expect(decodedReveal.revealSeed).toBeDefined()
        expect(toHex(decodedReveal.revealSeed!)).toBe(toHex(revealSeed))

        // Roll phase
        const rollPayload: DiceGamePayload = {
          round: 1,
          action: 'roll',
          seedCommitment,
          targetRoll: 50,
          wager: 1000000n,
        }
        const rollBytes = encodeDiceGamePayload(rollPayload)
        const decodedRoll = decodeDiceGamePayload(rollBytes)
        expect(decodedRoll.action).toBe('roll')
        expect(decodedRoll.targetRoll).toBe(50)

        // Integrated inside channel update
        validateAppState('dice', commitBytes)
        const decodedFromDispatcher = decodeAppPayload('dice', commitBytes) as DiceGamePayload
        expect(decodedFromDispatcher.action).toBe('commit')
      })

      it('rejects malformed dice payloads', () => {
        expect(() =>
          validateDiceGamePayload({
            round: -1,
            action: 'commit',
            seedCommitment: new Uint8Array(32),
            wager: 100n,
          }),
        ).toThrow('round cannot be negative')

        expect(() =>
          validateDiceGamePayload({
            round: 0,
            action: 'invalid' as any,
            seedCommitment: new Uint8Array(32),
            wager: 100n,
          }),
        ).toThrow('invalid dice action')

        expect(() =>
          validateDiceGamePayload({
            round: 0,
            action: 'commit',
            seedCommitment: new Uint8Array(16), // wrong length
            wager: 100n,
          }),
        ).toThrow('must be 32 bytes')

        expect(() =>
          validateDiceGamePayload({
            round: 0,
            action: 'roll',
            seedCommitment: new Uint8Array(32),
            targetRoll: 101, // exceeds 100
            wager: 100n,
          }),
        ).toThrow('targetRoll must be 0..100')
      })
    })

    // --- Poker ---
    describe('poker-game-payload', () => {
      it('encodes, validates, and decodes a poker game payload', () => {
        const handId = fromHex('33'.repeat(32))
        const flopCard1 = fromHex('44'.repeat(32))
        const flopCard2 = fromHex('55'.repeat(32))
        const flopCard3 = fromHex('66'.repeat(32))
        const cardCommitments = [flopCard1, flopCard2, flopCard3]
        const key1 = fromHex('77'.repeat(16))

        const pokerPayload: PokerGamePayload = {
          handId,
          phase: 'flop',
          action: 'raise',
          cardCommitments,
          keys: [key1],
        }

        validatePokerGamePayload(pokerPayload)
        const bytes = encodePokerGamePayload(pokerPayload)
        const decoded = decodePokerGamePayload(bytes)

        expect(toHex(decoded.handId)).toBe(toHex(handId))
        expect(decoded.phase).toBe('flop')
        expect(decoded.action).toBe('raise')
        expect(decoded.cardCommitments).toHaveLength(3)
        expect(decoded.keys).toHaveLength(1)
        expect(toHex(decoded.keys![0])).toBe(toHex(key1))

        // Dispatcher
        validateAppState('poker', bytes)
        const fromDispatcher = decodeAppPayload('poker', bytes) as PokerGamePayload
        expect(fromDispatcher.phase).toBe('flop')
      })

      it('rejects malformed poker payloads', () => {
        expect(() =>
          validatePokerGamePayload({
            handId: new Uint8Array(16), // invalid
            phase: 'preflop',
            action: 'call',
          }),
        ).toThrow('poker handId must be 32 bytes')

        expect(() =>
          validatePokerGamePayload({
            handId: new Uint8Array(32),
            phase: '', // empty
            action: 'call',
          }),
        ).toThrow('poker phase must be 1..32 characters')

        expect(() =>
          validatePokerGamePayload({
            handId: new Uint8Array(32),
            phase: 'flop',
            action: 'call',
            cardCommitments: [new Uint8Array(20)], // not 32 bytes
          }),
        ).toThrow('must be 32 bytes')
      })
    })

    // --- Swaps ---
    describe('swap-offer-payload', () => {
      it('encodes, validates, and decodes an atomic swap offer payload', () => {
        const swapId = fromHex('88'.repeat(32))
        const makerAsset = fromHex('99'.repeat(20))
        const takerAsset = fromHex('aa'.repeat(20))
        const htlcHash = fromHex('bb'.repeat(32))

        const swapPayload: SwapOfferPayload = {
          swapId,
          makerAsset,
          makerAmount: 1000000000000000000n,
          takerAsset,
          takerAmount: 500000000000000000n,
          expiration: 1735689600,
          htlcHash,
        }

        validateSwapOfferPayload(swapPayload)
        const bytes = encodeSwapOfferPayload(swapPayload)
        const decoded = decodeSwapOfferPayload(bytes)

        expect(toHex(decoded.swapId)).toBe(toHex(swapId))
        expect(toHex(decoded.makerAsset)).toBe(toHex(makerAsset))
        expect(decoded.makerAmount).toBe(1000000000000000000n)
        expect(toHex(decoded.takerAsset)).toBe(toHex(takerAsset))
        expect(decoded.takerAmount).toBe(500000000000000000n)
        expect(decoded.expiration).toBe(1735689600n)
        expect(decoded.htlcHash).toBeDefined()
        expect(toHex(decoded.htlcHash!)).toBe(toHex(htlcHash))

        // Dispatcher
        validateAppState('swap', bytes)
        const fromDispatcher = decodeAppPayload('swap', bytes) as SwapOfferPayload
        expect(toHex(fromDispatcher.swapId)).toBe(toHex(swapId))
      })

      it('rejects malformed swap payloads', () => {
        expect(() =>
          validateSwapOfferPayload({
            swapId: new Uint8Array(10), // invalid
            makerAsset: new Uint8Array(0),
            makerAmount: 100n,
            takerAsset: new Uint8Array(0),
            takerAmount: 100n,
            expiration: 100,
          }),
        ).toThrow('swapId must be 32 bytes')

        expect(() =>
          validateSwapOfferPayload({
            swapId: new Uint8Array(32),
            makerAsset: new Uint8Array(0),
            makerAmount: 100n,
            takerAsset: new Uint8Array(0),
            takerAmount: 100n,
            expiration: -1,
          }),
        ).toThrow('expiration must be in range')
      })
    })

    // --- Raffles ---
    describe('raffle-payload', () => {
      it('encodes, validates, and decodes a raffle payload', () => {
        const raffleId = fromHex('cc'.repeat(32))
        const winningHash = fromHex('dd'.repeat(32))

        const rafflePayload: RafflePayload = {
          raffleId,
          ticketPrice: 25000000000000000n,
          ticketsSold: 42,
          winningHash,
        }

        validateRafflePayload(rafflePayload)
        const bytes = encodeRafflePayload(rafflePayload)
        const decoded = decodeRafflePayload(bytes)

        expect(toHex(decoded.raffleId)).toBe(toHex(raffleId))
        expect(decoded.ticketPrice).toBe(25000000000000000n)
        expect(decoded.ticketsSold).toBe(42n)
        expect(decoded.winningHash).toBeDefined()
        expect(toHex(decoded.winningHash!)).toBe(toHex(winningHash))

        // Dispatcher
        validateAppState('raffle', bytes)
        const fromDispatcher = decodeAppPayload('raffle', bytes) as RafflePayload
        expect(fromDispatcher.ticketsSold).toBe(42n)
      })

      it('rejects malformed raffle payloads', () => {
        expect(() =>
          validateRafflePayload({
            raffleId: new Uint8Array(10),
            ticketPrice: 10n,
            ticketsSold: 5,
          }),
        ).toThrow('raffleId must be 32 bytes')

        expect(() =>
          validateRafflePayload({
            raffleId: new Uint8Array(32),
            ticketPrice: 10n,
            ticketsSold: -5,
          }),
        ).toThrow('ticketsSold cannot be negative')
      })
    })
  })

  // -------------------------------------------------------------------------------------------
  // 4. Signature verification format and monotonic sequence checks
  // -------------------------------------------------------------------------------------------
  describe('signature verification and monotonic sequence checks', () => {
    it('verifies algorithm 1 signatures over state digest and detects tampering', () => {
      const diceBytes = encodeDiceGamePayload({
        round: 1,
        action: 'commit',
        seedCommitment: fromHex('ff'.repeat(32)),
        wager: 500000n,
      })

      const allocations = [
        {
          networkTag: 'mont',
          token: '',
          balances: [
            { participant: { keyType: 1, pubKey: alicePubHex }, balance: 100n },
            { participant: { keyType: 1, pubKey: bobPubHex }, balance: 200n },
          ],
        },
      ]

      const stateInput = {
        channelId: sampleChannelId,
        appId: 'dice',
        sequenceNumber: 1,
        allocations,
        appState: diceBytes,
      }

      const digest = channelStateDigest(stateInput)
      const aliceSig = signDer(digest, alicePriv)
      const bobSig = signDer(digest, bobPriv)

      // Signature verification helper verifies algorithm 1 correctly
      const aliceSigEntry = {
        algorithm: 1,
        signer: { keyType: 1, pubKey: alicePubHex },
        signature: toHex(aliceSig),
      }
      expect(verifyChannelSignature(aliceSigEntry, digest)).toBe(true)

      // Verify all signatures on the item
      const item: CanonicalChannelUpdateItem = {
        type: 'channel-update',
        channelId: sampleChannelId,
        appId: 'dice',
        sequenceNumber: 1,
        allocations,
        appState: diceBytes,
        signatures: [
          aliceSigEntry,
          {
            algorithm: 1,
            signer: { keyType: 1, pubKey: bobPubHex },
            signature: toHex(bobSig),
          },
        ],
      }

      expect(verifyChannelSignatures(item)).toBe(true)

      // Tampered state digest causes signature verification to fail
      const tamperedDigest = new Uint8Array(digest)
      tamperedDigest[0] ^= 0xff
      expect(verifyChannelSignature(aliceSigEntry, tamperedDigest)).toBe(false)
      expect(verifyChannelSignatures(item, tamperedDigest)).toBe(false)
    })

    it('enforces strictly monotonic sequence progression', () => {
      // Numbers
      expect(() => validateChannelSequence(0, 1)).not.toThrow()
      expect(() => validateChannelSequence(5, 10)).not.toThrow()

      expect(() => validateChannelSequence(1, 1)).toThrow(
        /sequence number must be strictly monotonic/,
      )
      expect(() => validateChannelSequence(5, 4)).toThrow(
        /sequence number must be strictly monotonic/,
      )

      // Channel items
      const item0: CanonicalChannelUpdateItem = {
        type: 'channel-update',
        channelId: sampleChannelId,
        appId: 'poker',
        sequenceNumber: 0,
        allocations: [
          {
            networkTag: 'mont',
            balances: [
              { participant: { keyType: 1, pubKey: alicePubHex }, balance: 100n },
              { participant: { keyType: 1, pubKey: bobPubHex }, balance: 100n },
            ],
          },
        ],
        appState: new Uint8Array(0),
        signatures: [
          {
            algorithm: 1,
            signer: { keyType: 1, pubKey: alicePubHex },
            signature: toHex(new Uint8Array(64)),
          },
        ],
      }

      const item1: CanonicalChannelUpdateItem = {
        ...item0,
        sequenceNumber: 1,
      }

      const itemStale: CanonicalChannelUpdateItem = {
        ...item0,
        sequenceNumber: 0,
      }

      const itemDifferentChannel: CanonicalChannelUpdateItem = {
        ...item1,
        channelId: 'ee'.repeat(32),
      }

      expect(() => validateChannelSequence(item0, item1)).not.toThrow()
      expect(() => validateChannelTransition(item0, item1)).not.toThrow()

      expect(() => validateChannelSequence(item1, itemStale)).toThrow(
        /sequence number must be strictly monotonic/,
      )
      expect(() => validateChannelSequence(item0, itemDifferentChannel)).toThrow(
        /channelId mismatch/,
      )

      const itemDifferentApp: CanonicalChannelUpdateItem = {
        ...item1,
        appId: 'swap',
      }
      expect(() => validateChannelTransition(item0, itemDifferentApp)).toThrow(
        /appId mismatch/,
      )
    })
  })

  // -------------------------------------------------------------------------------------------
  // 5. Bounds and schema rejection tests
  // -------------------------------------------------------------------------------------------
  describe('bounds and schema validation', () => {
    it('rejects channelId with invalid byte length', () => {
      expect(() =>
        encodeChannelUpdateItem({
          type: 'channel-update',
          channelId: 'aa'.repeat(16), // 16 bytes instead of 32
          appId: 'dice',
          sequenceNumber: 0,
          allocations: [
            {
              networkTag: 'mont',
              balances: [
                { participant: { keyType: 1, pubKey: alicePubHex }, balance: 10n },
                { participant: { keyType: 1, pubKey: bobPubHex }, balance: 10n },
              ],
            },
          ],
          appState: new Uint8Array(0),
          signatures: [
            {
              algorithm: 1,
              signer: { keyType: 1, pubKey: alicePubHex },
              signature: toHex(new Uint8Array(64)),
            },
          ],
        }),
      ).toThrow(/must be exactly 32 bytes/)
    })

    it('rejects empty or excessively long appId', () => {
      expect(() =>
        encodeChannelUpdateItem({
          type: 'channel-update',
          channelId: sampleChannelId,
          appId: '', // empty
          sequenceNumber: 0,
          allocations: [
            {
              networkTag: 'mont',
              balances: [
                { participant: { keyType: 1, pubKey: alicePubHex }, balance: 10n },
                { participant: { keyType: 1, pubKey: bobPubHex }, balance: 10n },
              ],
            },
          ],
          appState: new Uint8Array(0),
          signatures: [
            {
              algorithm: 1,
              signer: { keyType: 1, pubKey: alicePubHex },
              signature: toHex(new Uint8Array(64)),
            },
          ],
        }),
      ).toThrow(/appId must be a string of 1..64 characters/)

      expect(() =>
        encodeChannelUpdateItem({
          type: 'channel-update',
          channelId: sampleChannelId,
          appId: 'a'.repeat(65), // > 64 chars
          sequenceNumber: 0,
          allocations: [
            {
              networkTag: 'mont',
              balances: [
                { participant: { keyType: 1, pubKey: alicePubHex }, balance: 10n },
                { participant: { keyType: 1, pubKey: bobPubHex }, balance: 10n },
              ],
            },
          ],
          appState: new Uint8Array(0),
          signatures: [
            {
              algorithm: 1,
              signer: { keyType: 1, pubKey: alicePubHex },
              signature: toHex(new Uint8Array(64)),
            },
          ],
        }),
      ).toThrow(/appId must be a string of 1..64 characters/)
    })

    it('rejects allocations with fewer than 2 participants', () => {
      expect(() =>
        encodeChannelUpdateItem({
          type: 'channel-update',
          channelId: sampleChannelId,
          appId: 'dice',
          sequenceNumber: 0,
          allocations: [
            {
              networkTag: 'mont',
              balances: [
                { participant: { keyType: 1, pubKey: alicePubHex }, balance: 10n },
              ], // only 1 balance
            },
          ],
          appState: new Uint8Array(0),
          signatures: [
            {
              algorithm: 1,
              signer: { keyType: 1, pubKey: alicePubHex },
              signature: toHex(new Uint8Array(64)),
            },
          ],
        }),
      ).toThrow(/must have 2..16 participant balances/)
    })

    it('rejects appState exceeding 65536 bytes', () => {
      expect(() =>
        encodeChannelUpdateItem({
          type: 'channel-update',
          channelId: sampleChannelId,
          appId: 'dice',
          sequenceNumber: 0,
          allocations: [
            {
              networkTag: 'mont',
              balances: [
                { participant: { keyType: 1, pubKey: alicePubHex }, balance: 10n },
                { participant: { keyType: 1, pubKey: bobPubHex }, balance: 10n },
              ],
            },
          ],
          appState: new Uint8Array(65537), // exceeds 65536
          signatures: [
            {
              algorithm: 1,
              signer: { keyType: 1, pubKey: alicePubHex },
              signature: toHex(new Uint8Array(64)),
            },
          ],
        }),
      ).toThrow(/exceeds maximum of 65536 bytes/)
    })
  })

  // -------------------------------------------------------------------------------------------
  // 6. Encapsulation inside Direct Message content revision (Type 8)
  // -------------------------------------------------------------------------------------------
  describe('container encapsulation', () => {
    it('successfully encapsulates a channel update item frame within a type-8 content revision', () => {
      const channelFrame = encodeChannelUpdateItem({
        type: 'channel-update',
        channelId: sampleChannelId,
        appId: 'raffle',
        sequenceNumber: 0,
        allocations: [
          {
            networkTag: 'mont',
            balances: [
              { participant: { keyType: 1, pubKey: alicePubHex }, balance: 50n },
              { participant: { keyType: 1, pubKey: bobPubHex }, balance: 50n },
            ],
          },
        ],
        appState: encodeRafflePayload({
          raffleId: fromHex('12'.repeat(32)),
          ticketPrice: 10n,
          ticketsSold: 0,
        }),
        signatures: [
          {
            algorithm: 1,
            signer: { keyType: 1, pubKey: alicePubHex },
            signature: toHex(new Uint8Array(64)),
          },
        ],
      })

      // Construct a type-8 message-content-revision containing the channel update frame
      const type8Frame = encodeFrame(
        {
          typeId: TYPE_MESSAGE_CONTENT_REVISION,
          schemaVersion: 1,
          minReaderVersion: 1,
        },
        cborMap([
          [0, 'frank'],
          [1, [channelFrame]],
        ]),
      )

      const parsed = validateFrame(type8Frame)
      expect(parsed.kind).toBe('parsed')
      if (parsed.kind === 'parsed' && parsed.typed?.type === 8) {
        expect(parsed.typed.items).toHaveLength(1)
        const child = parsed.typed.items[0]
        expect(child.kind).toBe('parsed')
        if (child.kind === 'parsed') {
          expect(child.typeId).toBe(TYPE_CHANNEL_UPDATE)
          expect(child.typed?.type).toBe(24)
          expect((child.typed as ChannelUpdateItem).appId).toBe('raffle')
        }
      }
    })
  })
})
