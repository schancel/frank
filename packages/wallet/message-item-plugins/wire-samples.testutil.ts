/**
 * One realistic item per carried message item type, with the values the app and the bots produce.
 * Shared by the wire-rule test and the two-wallet round-trip test.
 */
import { secp256k1 } from '@noble/curves/secp256k1'

import { fromHex, toHex } from '@frank/codec'
import type { MessageItem } from '@frank/cashweb/types/messages'

import { BLACKJACK_HAND_V3_ITEMS } from '../../frank-codec/fixtures/blackjack-hand-v3'

const alicePub = toHex(secp256k1.getPublicKey(fromHex('01'.repeat(32)), true))
const bobPub = toHex(secp256k1.getPublicKey(fromHex('02'.repeat(32)), true))
const ALICE = '0x' + 'a1'.repeat(20)
const BOB = '0x' + 'b2'.repeat(20)
const TX = '0x' + 'cd'.repeat(32)
const HASH = 'ef'.repeat(32)

/** Types that travel in their own frame; their bytes must stay exactly what they were. */
export const DEDICATED_SAMPLES: MessageItem[] = [
  { type: 'text', text: 'hello, world' },
  BLACKJACK_HAND_V3_ITEMS[0].item,
  {
    type: 'stealth',
    networkTag: 'MONT',
    keyType: 1,
    ephemeralPubKey: alicePub,
    transactions: ['aabbccddeeff00112233445566778899'],
    amount: 1000000,
    memo: 'Coffee payment',
  },
  {
    type: 'channel-update',
    channelId: '44'.repeat(32),
    appId: 'dice',
    sequenceNumber: 7,
    allocations: [
      {
        networkTag: 'mont',
        token: '',
        balances: [
          { participant: { keyType: 1, pubKey: alicePub }, balance: '1000' },
          { participant: { keyType: 1, pubKey: bobPub }, balance: '2000' },
        ],
      },
    ],
    appState: new Uint8Array([1, 2]),
    signatures: [
      {
        algorithm: 1,
        signer: { keyType: 1, pubKey: alicePub },
        signature: toHex(new Uint8Array(64).fill(0x11)),
      },
    ],
  },
  {
    type: 'email',
    messageId: '<simple-1@example.com>',
    from: { address: 'sender@example.com' },
    to: [{ address: 'recipient@example.com' }],
    subject: 'Hello',
    textBody: 'Body text',
  },
]

/** Types that travel in the generic plugin item frame. */
export const GENERIC_SAMPLES: MessageItem[] = [
  {
    type: 'dice',
    action: 'result',
    target: 32768,
    multiplier: 1.962,
    wagerWei: '10000000000000000',
    luckyNumber: 1234,
    isWin: true,
    serverSecret: '0123456789abcdef0123456789abcdef',
    userNonce: '0123456789abcdef_1760000000000',
    payoutWei: '19620000000000000',
    txHash: TX,
  },
  {
    type: 'rps',
    action: 'resolve',
    commitHash: HASH,
    playerMove: 'rock',
    botMove: 'scissors',
    secretSalt: '0123456789abcdef0123456789abcdef',
    wagerWei: '10000000000000000',
    outcome: 'win',
    txHash: TX,
  },
  {
    type: 'raffle',
    raffleId: '00112233445566778899aabbccddeeff',
    action: 'draw',
    entryPriceWei: '20000000000000000',
    serverSeedHash: HASH,
    serverSeed: 'ab'.repeat(32),
    winnerAddress: BOB,
    entrants: [ALICE, BOB],
    entryTxHashes: ['11'.repeat(32), '22'.repeat(32)],
    potWei: '40000000000000000',
  },
  {
    type: 'poker',
    tableId: '0011223344556677',
    action: 'action',
    buyInWei: '100000000000000000',
    smallBlind: 10,
    bigBlind: 20,
    street: 'flop',
    pot: 60,
    currentBet: 20,
    minRaise: 20,
    activePlayer: BOB,
    boardCards: [0, 13, 51],
    players: [
      {
        address: ALICE,
        chips: 980,
        currentStreetBet: 20,
        totalHandBet: 20,
        folded: false,
        isAllIn: false,
        isDealerButton: true,
        isSmallBlind: true,
        isBigBlind: false,
        holeCards: [-1, -1],
      },
      {
        address: BOB,
        chips: 960,
        currentStreetBet: 20,
        totalHandBet: 40,
        folded: false,
        isAllIn: false,
        isDealerButton: false,
        isSmallBlind: false,
        isBigBlind: true,
      },
    ],
    myHoleCards: [12, 25],
    lastAction: { player: ALICE, action: 'call', amount: 20 },
  },
  {
    type: 'liars-dice',
    tableId: '8899aabbccddeeff',
    action: 'bid',
    buyInWei: '50000000000000000',
    maxPlayers: 4,
    dicePerPlayer: 5,
    players: [ALICE, BOB],
    diceCounts: [5, 4],
    roundNumber: 2,
    activePlayer: BOB,
    turnTimeoutSeconds: 45,
    currentBid: { bidder: ALICE, quantity: 3, face: 4 },
    serverCommit: HASH,
    myDice: [1, 3, 4, 4, 6],
    potWei: '100000000000000000',
  },
  {
    type: 'digital-goods',
    action: 'catalog',
    catalog: [
      {
        itemId: 'sticker_1',
        description: 'A sticker',
        priceWei: '50000000000000000',
        thumbnail: 'data:image/png;base64,AAAA',
      },
    ],
  },
  { type: 'digital-goods', action: 'request', itemId: 'sticker_1' },
  { type: 'image', image: 'data:image/png;base64,AAAA' },
  { type: 'reply', payloadDigest: HASH },
]

/** Well-formed items of two registered types this path does not carry: a peer's proposal that
 * today's receivers would act on without checking it. */
export const NOT_CARRIED_PROPOSAL_SAMPLES: MessageItem[] = [
  {
    type: 'swap-offer',
    swapId: '00112233445566778899aabbccddeeff',
    offeredChain: 'monad-testnet',
    offeredAsset: 'MON',
    offeredAmount: '0.5',
    requestedChain: 'solana-testnet',
    requestedAsset: 'SOL',
    requestedAmount: '0.01',
    status: 'pending',
    recipientAddress: BOB,
    createdAt: 1760000000000,
  },
  {
    type: 'blackjack-move',
    gameId: 'g',
    action: 'deal',
    serverSeedHash: 'ab'.repeat(32),
    playerCards: [1, 2],
    dealerUpCard: 3,
  },
]

/** One well-formed item of every registered type that is never interpreted when it comes from
 * another person, on any transport: the types not carried at all, and the self-only ones. */
export const NEVER_FROM_A_PEER_SAMPLES: MessageItem[] = [
  {
    type: 'wallet-sync',
    direction: 'out',
    chainIdentifier: 'monad-testnet',
    txHash: '0x' + 'ab'.repeat(32),
  },
  {
    type: 'payment-transfer',
    direction: 'in',
    chainIdentifier: 'monad-testnet',
    txHash: '0x' + 'ab'.repeat(32),
  },
  {
    type: 'swap-record',
    swapId: '00112233445566778899aabbccddeeff',
    chain: 'monad-testnet',
    fromAsset: 'MON',
    toAsset: 'USDC',
    fromAmount: '1',
    toAmount: '2',
    txHash: '0x' + 'ab'.repeat(32),
    route: 'direct',
    feeDisplay: '0.1%',
    status: 'confirmed',
    timestamp: 1760000000000,
  },
  {
    type: 'device-claim',
    instanceId: '123e4567-e89b-42d3-a456-426614174000',
    claimedAt: 1760000000000,
  },
  {
    type: 'p2pkh',
    address: 'lotus_16PSJNf1EDEfGvaYzaXJCJZrXH4pgiTo7kyW61iGi',
    amount: 5,
  },
  ...NOT_CARRIED_PROPOSAL_SAMPLES,
]
