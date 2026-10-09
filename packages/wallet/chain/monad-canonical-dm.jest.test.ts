/**
 * Canonical direct message pipeline tests for Type 24 channel-update items (#965).
 * Proves round-trip integrity:
 *   ChannelUpdateItem -> encodeChannelUpdateItem -> prepareDirectMessage -> openDirectMessage -> projectChannelUpdateItem
 * across single-chain, multi-chain, modular game payloads (dice, poker), multi-signatures,
 * settlement references, and mixed multi-item direct messages.
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { secp256k1 } from '@noble/curves/secp256k1'
import {
  channelStateDigest,
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
  fromHex,
  isChannelUpdateItemFrame,
  parseFrame,
  projectChannelUpdateItem,
  toHex,
  validateChannelSequence,
  validateChannelTransition,
  verifyChannelSignatures,
  verifyPreviewDirectoryEvidence,
} from '@frank/codec'
import type { CanonicalChannelUpdateItem } from '@frank/codec'
import {
  open,
  openAsSender,
  randomBytes,
  seal,
  selfOpenEphemeral,
  selfOpenKeyFromRoot,
} from '@frank/crypto-box'
import { openNodeDirectoryStore } from '@frank/directory-admission/node'
import type { Current, DirectoryStore } from '@frank/directory-admission'
import {
  directMessageText,
  openDirectMessage,
  openOwnDirectMessage,
  prepareDirectMessage,
  type DirectMessageRoles,
} from '@frank/cashweb/relay/canonical-dm'
import type { ChannelUpdateItem, MessageItem } from '@frank/cashweb/types/messages'
import { createDefaultMessageItemRegistry } from '../message-item-plugins/default-registry'
import { pluginCapabilitiesNotYetAvailable } from '../message-item-plugins/registry'
import corpus from '../../../docs/protocol/cbor/vectors/dm-runtime.json'

describe('canonical DM pipeline: Type 24 channel-update items (#965)', () => {
  let location: string
  let store: DirectoryStore
  let current: Current
  const v = corpus.runtime_case

  // Participant keypairs
  const alicePriv = fromHex('01'.repeat(32))
  const alicePub = secp256k1.getPublicKey(alicePriv, true)
  const alicePubHex = toHex(alicePub)

  const bobPriv = fromHex('02'.repeat(32))
  const bobPub = secp256k1.getPublicKey(bobPriv, true)
  const bobPubHex = toHex(bobPub)

  const signDer = (digest: Uint8Array, priv: Uint8Array): Uint8Array =>
    new Uint8Array(secp256k1.sign(digest, priv).toDERRawBytes())

  const sampleChannelId = '44'.repeat(32)

  beforeAll(async () => {
    location = await mkdtemp(join(tmpdir(), 'canonical-dm-channel-'))
    const statement = fromHex(v.statement)
    const attestation = fromHex(v.attestation)
    const parsed = verifyPreviewDirectoryEvidence(attestation, corpus.network)
    store = await openNodeDirectoryStore({
      location: join(location, 'db'),
      anchor: {
        network: corpus.network,
        subject: parsed.statement.subject,
        revisionZero: fromHex(v.t1),
      },
      mode: { kind: 'new' },
    })
    current = await store.enroll([{ statement, attestation }], {
      now: { seconds: 200n, nanoseconds: 0 },
      relay: parsed.statement.relays[0],
    })
  })

  afterAll(async () => {
    await store?.close()
    await rm(location, { recursive: true, force: true })
  })

  function makeRoles(
    snapshot = current,
    network = corpus.network,
  ): DirectMessageRoles {
    return {
      auth: {
        role: 'auth',
        purpose: 'identity-authentication',
        compressedPoint: verifyPreviewDirectoryEvidence(
          snapshot.evidence.attestation,
          network,
        ).statement.subject.keyBytes,
      },
      message: {
        role: 'message',
        purpose: 'messaging-encryption',
        compressedPoint: snapshot.messageKey.keyBytes,
        generation: 0,
      },
      stamp: {
        role: 'stamp',
        purpose: 'evm-wallet',
        compressedPoint: snapshot.stampKey.keyBytes,
        generation: 0,
      },
      sealMessage: input =>
        seal({
          ...input,
          suiteId: 1,
          senderPrivateKey: fromHex(v.message_secret_test_only),
          senderPublicKey: snapshot.messageKey.keyBytes,
        }),
      openMessage: input =>
        open({
          ...input,
          recipientPrivateKey: fromHex(v.message_secret_test_only),
        }),
      dispose: jest.fn(),
    }
  }

  describe('prepareDirectMessage -> openDirectMessage round-trip', () => {
    it('encodes, seals, opens, and projects a single-chain channel update item with dice game payload', () => {
      const dicePayload = encodeDiceGamePayload({
        round: 3n,
        action: 'roll',
        seedCommitment: fromHex('ab'.repeat(32)),
        targetRoll: 64,
        wager: 50_000n,
      })

      const allocations = [
        {
          networkTag: 'mont',
          token: '',
          balances: [
            {
              participant: { keyType: 1, pubKey: alicePubHex },
              balance: '2500000',
            },
            {
              participant: { keyType: 1, pubKey: bobPubHex },
              balance: '7500000',
            },
          ],
        },
      ]

      const digest = channelStateDigest({
        channelId: sampleChannelId,
        appId: 'dice',
        sequenceNumber: 5,
        allocations,
        appState: dicePayload,
        settlementRef: 'cc'.repeat(32),
      })

      const aliceSig = signDer(digest, alicePriv)
      const bobSig = signDer(digest, bobPriv)

      const channelItem: CanonicalChannelUpdateItem = {
        type: 'channel-update',
        channelId: sampleChannelId,
        appId: 'dice',
        sequenceNumber: 5,
        allocations,
        appState: dicePayload,
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
        settlementRef: 'cc'.repeat(32),
      }

      // Encode the item using encodeChannelUpdateItem
      const encodedFrame = encodeChannelUpdateItem(channelItem)

      // Prepare direct message carrying the encoded channel update frame
      const roles = makeRoles()
      const messageId = new Uint8Array(16).fill(0x11)
      const prepared = prepareDirectMessage({
        network: corpus.network,
        senderCurrent: current,
        recipientCurrent: current,
        messageId,
        items: [encodedFrame],
        roles,
      })

      // Open the direct message
      const opened = openDirectMessage({
        network: corpus.network,
        payload: prepared.payload,
        context: prepared.context,
        roles,
        senderCurrent: current,
        recipientCurrent: current,
      })

      expect(opened.items).toHaveLength(1)
      const child = opened.items[0]
      expect(child.kind).toBe('parsed')
      expect(isChannelUpdateItemFrame(child)).toBe(true)

      // Project the item using projectChannelUpdateItem
      const projected = projectChannelUpdateItem(child)
      expect(projected.type).toBe('channel-update')
      expect(projected.channelId).toBe(sampleChannelId.toLowerCase())
      expect(projected.appId).toBe('dice')
      expect(projected.sequenceNumber).toBe(5)
      expect(projected.settlementRef).toBe('cc'.repeat(32))
      expect(projected.allocations).toEqual(allocations)
      expect(toHex(projected.appState as Uint8Array)).toBe(toHex(dicePayload))
      expect(projected.signatures).toHaveLength(2)
      expect(projected.signatures[0]).toEqual({
        algorithm: 1,
        signer: { keyType: 1, pubKey: alicePubHex },
        signature: toHex(aliceSig),
      })
      expect(projected.signatures[1]).toEqual({
        algorithm: 1,
        signer: { keyType: 1, pubKey: bobPubHex },
        signature: toHex(bobSig),
      })

      // Verify game state decodes cleanly from projected appState
      const decodedDice = decodeDiceGamePayload(projected.appState as Uint8Array)
      expect(decodedDice.round).toBe(3n)
      expect(decodedDice.action).toBe('roll')
      expect(decodedDice.targetRoll).toBe(64)
      expect(decodedDice.wager).toBe(50_000n)
      expect(toHex(decodedDice.seedCommitment)).toBe('ab'.repeat(32))

      // Verify signatures against projected item
      expect(verifyChannelSignatures(projected)).toBe(true)
    })

    it('round-trips multi-chain channel allocations with poker payload', () => {
      const pokerPayload = encodePokerGamePayload({
        handId: fromHex('dd'.repeat(32)),
        phase: 'turn',
        action: 'bet',
        cardCommitments: [fromHex('11'.repeat(32)), fromHex('22'.repeat(32))],
      })

      const sampleToken = 'ee'.repeat(20)
      const allocations = [
        {
          networkTag: 'mont',
          token: '',
          balances: [
            {
              participant: { keyType: 1, pubKey: alicePubHex },
              balance: '1000000000',
            },
            {
              participant: { keyType: 1, pubKey: bobPubHex },
              balance: '2000000000',
            },
          ],
        },
        {
          networkTag: 'sol1',
          token: sampleToken,
          balances: [
            {
              participant: { keyType: 1, pubKey: alicePubHex },
              balance: '500',
            },
            {
              participant: { keyType: 1, pubKey: bobPubHex },
              balance: '500',
            },
          ],
        },
      ]

      const digest = channelStateDigest({
        channelId: sampleChannelId,
        appId: 'poker',
        sequenceNumber: 12,
        allocations,
        appState: pokerPayload,
      })

      const aliceSig = signDer(digest, alicePriv)

      const channelItem: ChannelUpdateItem = {
        type: 'channel-update',
        channelId: sampleChannelId,
        appId: 'poker',
        sequenceNumber: 12,
        allocations,
        appState: pokerPayload,
        signatures: [
          {
            algorithm: 1,
            signer: { keyType: 1, pubKey: alicePubHex },
            signature: toHex(aliceSig),
          },
        ],
      }

      const encodedFrame = encodeChannelUpdateItem(channelItem)
      const roles = makeRoles()
      const prepared = prepareDirectMessage({
        network: corpus.network,
        senderCurrent: current,
        recipientCurrent: current,
        messageId: new Uint8Array(16).fill(0x22),
        items: [encodedFrame],
        roles,
      })

      const opened = openDirectMessage({
        network: corpus.network,
        payload: prepared.payload,
        context: prepared.context,
        roles,
        senderCurrent: current,
        recipientCurrent: current,
      })

      expect(opened.items).toHaveLength(1)
      const projected = projectChannelUpdateItem(opened.items[0])
      expect(projected.allocations).toHaveLength(2)
      expect(projected.allocations[0].networkTag).toBe('mont')
      expect(projected.allocations[0].token).toBe('')
      expect(projected.allocations[1].networkTag).toBe('sol1')
      expect(projected.allocations[1].token).toBe(sampleToken.toLowerCase())

      const decodedPoker = decodePokerGamePayload(projected.appState as Uint8Array)
      expect(decodedPoker.phase).toBe('turn')
      expect(decodedPoker.action).toBe('bet')
      expect(toHex(decodedPoker.handId)).toBe('dd'.repeat(32))
      expect(decodedPoker.cardCommitments).toHaveLength(2)
    })

    it('round-trips mixed messages carrying both text and channel-update items in order', () => {
      const textFrame = directMessageText('State channel update proposal')
      const channelItem: CanonicalChannelUpdateItem = {
        type: 'channel-update',
        channelId: sampleChannelId,
        appId: 'raffle',
        sequenceNumber: 0,
        allocations: [
          {
            networkTag: 'mont',
            token: '',
            balances: [
              {
                participant: { keyType: 1, pubKey: alicePubHex },
                balance: '100',
              },
              {
                participant: { keyType: 1, pubKey: bobPubHex },
                balance: '200',
              },
            ],
          },
        ],
        appState: new Uint8Array([0xde, 0xad, 0xbe, 0xef]),
        signatures: [
          {
            algorithm: 1,
            signer: { keyType: 1, pubKey: alicePubHex },
            signature: toHex(new Uint8Array(64).fill(0x55)),
          },
        ],
      }
      const channelFrame = encodeChannelUpdateItem(channelItem)

      const roles = makeRoles()
      const prepared = prepareDirectMessage({
        network: corpus.network,
        senderCurrent: current,
        recipientCurrent: current,
        messageId: new Uint8Array(16).fill(0x33),
        items: [textFrame, channelFrame],
        roles,
      })

      const opened = openDirectMessage({
        network: corpus.network,
        payload: prepared.payload,
        context: prepared.context,
        roles,
        senderCurrent: current,
        recipientCurrent: current,
      })

      expect(opened.items).toHaveLength(2)

      // Item 0: Text item
      const item0 = opened.items[0]
      expect(item0.kind).toBe('parsed')
      expect(item0.typed?.type).toBe(17)
      expect((item0.typed as any).text).toBe('State channel update proposal')

      // Item 1: Channel-update item
      const item1 = opened.items[1]
      expect(item1.kind).toBe('parsed')
      expect(isChannelUpdateItemFrame(item1)).toBe(true)
      const projectedChannel = projectChannelUpdateItem(item1)
      expect(projectedChannel.appId).toBe('raffle')
      expect(projectedChannel.sequenceNumber).toBe(0)
      expect(toHex(projectedChannel.appState as Uint8Array)).toBe('deadbeef')
    })

    it('round-trips channel-update items via openOwnDirectMessage (outbound pathway)', () => {
      const selfOpenKey = selfOpenKeyFromRoot(new Uint8Array(32).fill(0x33))
      const role = makeRoles()
      role.sealMessage = input => {
        const salt = randomBytes(32)
        const ephemeralSecret = selfOpenEphemeral({
          selfOpenKey,
          salt,
          recipientPublicKey: input.recipientPublicKey,
          senderPublicKey: current.messageKey.keyBytes,
        })!
        return seal({
          ...input,
          suiteId: 1,
          senderPrivateKey: fromHex(v.message_secret_test_only),
          senderPublicKey: current.messageKey.keyBytes,
          salt,
          ephemeralSecret,
        })
      }
      role.openOwnMessage = input =>
        openAsSender({
          ...input,
          selfOpenKey,
          senderPrivateKey: fromHex(v.message_secret_test_only),
          senderPublicKey: current.messageKey.keyBytes,
        })

      const channelItem: CanonicalChannelUpdateItem = {
        type: 'channel-update',
        channelId: sampleChannelId,
        appId: 'dice',
        sequenceNumber: 2,
        allocations: [
          {
            networkTag: 'mont',
            token: '',
            balances: [
              {
                participant: { keyType: 1, pubKey: alicePubHex },
                balance: '5000',
              },
              {
                participant: { keyType: 1, pubKey: bobPubHex },
                balance: '5000',
              },
            ],
          },
        ],
        appState: new Uint8Array([1, 2, 3]),
        signatures: [
          {
            algorithm: 1,
            signer: { keyType: 1, pubKey: alicePubHex },
            signature: toHex(new Uint8Array(64).fill(0x99)),
          },
        ],
      }
      const channelFrame = encodeChannelUpdateItem(channelItem)

      const prepared = prepareDirectMessage({
        network: corpus.network,
        senderCurrent: current,
        recipientCurrent: current,
        messageId: new Uint8Array(16).fill(0x44),
        items: [channelFrame],
        roles: role,
      })

      const selfOpened = openOwnDirectMessage({
        network: corpus.network,
        payload: prepared.payload,
        context: prepared.context,
        roles: role,
        senderCurrent: current,
        recipientCurrent: current,
      })

      expect(selfOpened.mode).toBe('send')
      expect(selfOpened.items).toHaveLength(1)
      expect(isChannelUpdateItemFrame(selfOpened.items[0])).toBe(true)
      const projected = projectChannelUpdateItem(selfOpened.items[0])
      expect(projected.type).toBe('channel-update')
      expect(projected.channelId).toBe(sampleChannelId.toLowerCase())
      expect(projected.sequenceNumber).toBe(2)
      expect(projected.appId).toBe('dice')
    })
  })

  describe('message item plugin and preview', () => {
    it('produces formatted preview text for channel-update items', () => {
      const channelItem: ChannelUpdateItem = {
        type: 'channel-update',
        channelId: sampleChannelId,
        appId: 'dice',
        sequenceNumber: 7,
        allocations: [
          {
            networkTag: 'mont',
            token: '',
            balances: [
              {
                participant: { keyType: 1, pubKey: alicePubHex },
                balance: '1000',
              },
              {
                participant: { keyType: 1, pubKey: bobPubHex },
                balance: '2000',
              },
            ],
          },
        ],
        appState: new Uint8Array([1, 2]),
        signatures: [
          {
            algorithm: 1,
            signer: { keyType: 1, pubKey: alicePubHex },
            signature: toHex(new Uint8Array(64).fill(0x11)),
          },
        ],
      }

      const preview = createDefaultMessageItemRegistry(
        pluginCapabilitiesNotYetAvailable,
      ).previewText(channelItem)
      expect(preview).toBe('State channel update: dice (seq 7)')
    })

    it('hydrates channel-update items through the registry', async () => {
      const channelItem: ChannelUpdateItem = {
        type: 'channel-update',
        channelId: sampleChannelId,
        appId: 'dice',
        sequenceNumber: 0,
        allocations: [
          {
            networkTag: 'mont',
            token: '',
            balances: [
              {
                participant: { keyType: 1, pubKey: alicePubHex },
                balance: '1000',
              },
              {
                participant: { keyType: 1, pubKey: bobPubHex },
                balance: '2000',
              },
            ],
          },
        ],
        appState: new Uint8Array([1]),
        signatures: [
          {
            algorithm: 1,
            signer: { keyType: 1, pubKey: alicePubHex },
            signature: toHex(new Uint8Array(64).fill(0x22)),
          },
        ],
      }

      const mockMessage = {
        id: 'msg-1',
        senderAddress: '0x1234',
        recipientAddress: '0x5678',
        sentTime: 1000,
        items: [channelItem],
      } as any

      const mockProvider = {} as any
      const hydrated = await createDefaultMessageItemRegistry(
        pluginCapabilitiesNotYetAvailable,
      ).hydrateItems(mockMessage, mockProvider)
      expect(hydrated).toHaveLength(1)
      expect(hydrated[0].item).toEqual(channelItem)
      expect(hydrated[0]).toMatchObject({
        kind: 'hydrated',
        hydrated: channelItem,
      })
    })
  })

  describe('validation and error handling', () => {
    it('throws error when encoding invalid channel-update items', () => {
      expect(() => {
        encodeChannelUpdateItem({
          type: 'channel-update',
          channelId: 'short',
          appId: 'dice',
          sequenceNumber: 0,
          allocations: [],
          appState: new Uint8Array(0),
          signatures: [],
        })
      }).toThrow()

      expect(() => {
        encodeChannelUpdateItem({
          type: 'channel-update',
          channelId: sampleChannelId,
          appId: '',
          sequenceNumber: 0,
          allocations: [],
          appState: new Uint8Array(0),
          signatures: [],
        })
      }).toThrow()

      expect(() => {
        encodeChannelUpdateItem({
          type: 'channel-update',
          channelId: sampleChannelId,
          appId: 'dice',
          sequenceNumber: -1,
          allocations: [],
          appState: new Uint8Array(0),
          signatures: [],
        })
      }).toThrow()
    })

    it('detects tampering with appState or sequenceNumber via signature verification', () => {
      const dicePayload = encodeDiceGamePayload({
        round: 1n,
        action: 'roll',
        seedCommitment: fromHex('12'.repeat(32)),
        targetRoll: 40,
        wager: 10_000n,
      })

      const allocations = [
        {
          networkTag: 'mont',
          token: '',
          balances: [
            { participant: { keyType: 1, pubKey: alicePubHex }, balance: '500' },
            { participant: { keyType: 1, pubKey: bobPubHex }, balance: '500' },
          ],
        },
      ]

      const digest = channelStateDigest({
        channelId: sampleChannelId,
        appId: 'dice',
        sequenceNumber: 1,
        allocations,
        appState: dicePayload,
      })

      const aliceSig = signDer(digest, alicePriv)

      const channelItem: CanonicalChannelUpdateItem = {
        type: 'channel-update',
        channelId: sampleChannelId,
        appId: 'dice',
        sequenceNumber: 1,
        allocations,
        appState: dicePayload,
        signatures: [
          {
            algorithm: 1,
            signer: { keyType: 1, pubKey: alicePubHex },
            signature: toHex(aliceSig),
          },
        ],
      }

      // Valid item verifies
      expect(verifyChannelSignatures(channelItem)).toBe(true)

      // Tampered appState fails signature verification
      const tamperedState = {
        ...channelItem,
        appState: new Uint8Array([9, 9, 9]),
      }
      expect(verifyChannelSignatures(tamperedState)).toBe(false)

      // Tampered sequence number fails signature verification
      const tamperedSeq = {
        ...channelItem,
        sequenceNumber: 2,
      }
      expect(verifyChannelSignatures(tamperedSeq)).toBe(false)
    })
  })

  describe('modular application payloads', () => {
    it('round-trips raffle payload in channel-update item', () => {
      const rafflePayload = encodeRafflePayload({
        raffleId: fromHex('55'.repeat(32)),
        ticketPrice: 10_000n,
        ticketsSold: 50,
        winningHash: fromHex('aa'.repeat(32)),
      })

      const channelItem: CanonicalChannelUpdateItem = {
        type: 'channel-update',
        channelId: sampleChannelId,
        appId: 'raffle',
        sequenceNumber: 3,
        allocations: [
          {
            networkTag: 'mont',
            token: '',
            balances: [
              { participant: { keyType: 1, pubKey: alicePubHex }, balance: '50000' },
              { participant: { keyType: 1, pubKey: bobPubHex }, balance: '50000' },
            ],
          },
        ],
        appState: rafflePayload,
        signatures: [
          {
            algorithm: 1,
            signer: { keyType: 1, pubKey: alicePubHex },
            signature: toHex(new Uint8Array(64).fill(0x33)),
          },
        ],
      }

      const frame = encodeChannelUpdateItem(channelItem)
      const parsed = parseFrame(frame)
      expect(isChannelUpdateItemFrame(parsed)).toBe(true)

      const projected = projectChannelUpdateItem(parsed)
      expect(projected.appId).toBe('raffle')
      expect(projected.sequenceNumber).toBe(3)

      const decodedRaffle = decodeRafflePayload(projected.appState as Uint8Array)
      expect(toHex(decodedRaffle.raffleId)).toBe('55'.repeat(32))
      expect(decodedRaffle.ticketPrice).toBe(10_000n)
      expect(decodedRaffle.ticketsSold).toBe(50n)
      expect(toHex(decodedRaffle.winningHash!)).toBe('aa'.repeat(32))
    })

    it('round-trips swap-offer payload in channel-update item', () => {
      const swapPayload = encodeSwapOfferPayload({
        swapId: fromHex('66'.repeat(32)),
        makerAsset: fromHex('aa'.repeat(20)),
        makerAmount: 1_000_000n,
        takerAsset: fromHex('bb'.repeat(20)),
        takerAmount: 500_000n,
        expiration: 1000,
        htlcHash: fromHex('cc'.repeat(32)),
      })

      const channelItem: CanonicalChannelUpdateItem = {
        type: 'channel-update',
        channelId: sampleChannelId,
        appId: 'swap-offer',
        sequenceNumber: 0,
        allocations: [
          {
            networkTag: 'mont',
            token: '',
            balances: [
              { participant: { keyType: 1, pubKey: alicePubHex }, balance: '1000000' },
              { participant: { keyType: 1, pubKey: bobPubHex }, balance: '0' },
            ],
          },
        ],
        appState: swapPayload,
        signatures: [
          {
            algorithm: 1,
            signer: { keyType: 1, pubKey: alicePubHex },
            signature: toHex(new Uint8Array(64).fill(0x44)),
          },
        ],
      }

      const frame = encodeChannelUpdateItem(channelItem)
      const parsed = parseFrame(frame)
      expect(isChannelUpdateItemFrame(parsed)).toBe(true)

      const projected = projectChannelUpdateItem(parsed)
      expect(projected.appId).toBe('swap-offer')
      expect(projected.sequenceNumber).toBe(0)

      const decodedSwap = decodeSwapOfferPayload(projected.appState as Uint8Array)
      expect(toHex(decodedSwap.swapId)).toBe('66'.repeat(32))
      expect(toHex(decodedSwap.makerAsset)).toBe('aa'.repeat(20))
      expect(decodedSwap.makerAmount).toBe(1_000_000n)
      expect(toHex(decodedSwap.takerAsset)).toBe('bb'.repeat(20))
      expect(decodedSwap.takerAmount).toBe(500_000n)
      expect(decodedSwap.expiration).toBe(1000n)
      expect(toHex(decodedSwap.htlcHash!)).toBe('cc'.repeat(32))
    })
  })

  describe('state channel sequence progression and transitions', () => {
    it('validates strictly increasing sequence numbers across consecutive updates', () => {
      const allocations = [
        {
          networkTag: 'mont',
          token: '',
          balances: [
            { participant: { keyType: 1, pubKey: alicePubHex }, balance: '100' },
            { participant: { keyType: 1, pubKey: bobPubHex }, balance: '100' },
          ],
        },
      ]

      const item0: CanonicalChannelUpdateItem = {
        type: 'channel-update',
        channelId: sampleChannelId,
        appId: 'dice',
        sequenceNumber: 0,
        allocations,
        appState: new Uint8Array([0]),
        signatures: [
          {
            algorithm: 1,
            signer: { keyType: 1, pubKey: alicePubHex },
            signature: toHex(new Uint8Array(64).fill(0x11)),
          },
        ],
      }

      const item1: CanonicalChannelUpdateItem = {
        ...item0,
        sequenceNumber: 1,
        appState: new Uint8Array([1]),
      }

      // Valid strictly increasing sequence transition
      expect(() => validateChannelSequence(item0, item1)).not.toThrow()
      expect(() => validateChannelTransition(item0, item1)).not.toThrow()

      // Non-increasing sequence fails
      const itemStale: CanonicalChannelUpdateItem = {
        ...item0,
        sequenceNumber: 0,
      }
      expect(() => validateChannelSequence(item0, itemStale)).toThrow()
      expect(() => validateChannelTransition(item0, itemStale)).toThrow()
    })
  })

  describe('DM item mapping parity (monad-canonical-dm.ts)', () => {
    it('maps recognized channel-update frames to CanonicalChannelUpdateItem and unrecognized to fallback', () => {
      const channelItem: CanonicalChannelUpdateItem = {
        type: 'channel-update',
        channelId: sampleChannelId,
        appId: 'dice',
        sequenceNumber: 1,
        allocations: [
          {
            networkTag: 'mont',
            token: '',
            balances: [
              { participant: { keyType: 1, pubKey: alicePubHex }, balance: '10' },
              { participant: { keyType: 1, pubKey: bobPubHex }, balance: '20' },
            ],
          },
        ],
        appState: new Uint8Array([42]),
        signatures: [
          {
            algorithm: 1,
            signer: { keyType: 1, pubKey: alicePubHex },
            signature: toHex(new Uint8Array(64).fill(0x77)),
          },
        ],
      }

      const channelFrameBytes = encodeChannelUpdateItem(channelItem)
      const parsedChannel = parseFrame(channelFrameBytes)

      const textFrameBytes = directMessageText('hello world')
      const parsedText = parseFrame(textFrameBytes)

      const opaqueUnknown = {
        kind: 'opaque' as const,
        typeId: 9999,
        frame: new Uint8Array(4),
      }

      // Simulate mapping from monad-canonical-dm.ts lines 924-946
      const mapItem = (item: any): MessageItem => {
        return item.kind === 'parsed' && item.typed?.type === 17
          ? { type: 'text' as const, text: item.typed.text }
          : item.kind === 'parsed' && isChannelUpdateItemFrame(item)
          ? projectChannelUpdateItem(item)
          : {
              type: 'text' as const,
              text: '[This message item is not supported yet]',
            }
      }

      const mappedChannel = mapItem(parsedChannel)
      expect(mappedChannel.type).toBe('channel-update')
      if (mappedChannel.type === 'channel-update') {
        expect(mappedChannel.channelId).toBe(sampleChannelId.toLowerCase())
        expect(mappedChannel.appId).toBe('dice')
        expect(mappedChannel.sequenceNumber).toBe(1)
      }

      const mappedText = mapItem(parsedText)
      expect(mappedText.type).toBe('text')
      if (mappedText.type === 'text') {
        expect(mappedText.text).toBe('hello world')
      }

      const mappedUnknown = mapItem(opaqueUnknown)
      expect(mappedUnknown.type).toBe('text')
      if (mappedUnknown.type === 'text') {
        expect(mappedUnknown.text).toBe('[This message item is not supported yet]')
      }
    })

  })
})


