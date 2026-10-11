/**
 * Every range, size and format rule of the sixteen CBOR item decoders, tested against bytes a
 * peer could send: a valid item's own bytes with exactly one field replaced by a value outside
 * the rule. Each must be refused with the typed decode error, and the unmodified bytes must be
 * accepted.
 */
import { decodeCanonical, encodeCanonical, type Encodable } from '@frank/codec'
import type { MessageItem } from '@frank/cashweb/types/messages'

import { createDefaultMessageItemRegistry } from './default-registry'
import {
  MessageItemDecodeError,
  MessageItemEncodeError,
  pluginCapabilitiesNotYetAvailable,
} from './registry'
import { standaloneDecodeContext } from './shared/plugin-contract.testutil'

const registry = createDefaultMessageItemRegistry(
  pluginCapabilitiesNotYetAvailable,
)

const A = '0x' + 'aa'.repeat(20)
const B = '0x' + 'bb'.repeat(20)
const H = 'ab'.repeat(32)
const TX = '0x' + 'cd'.repeat(32)
const many = <T>(n: number, v: T): T[] => Array.from({ length: n }, () => v)
const addresses = (n: number): string[] =>
  Array.from({ length: n }, (_, i) => '0x' + i.toString(16).padStart(40, '0'))

type Path = Array<number>
type Case = [what: string, path: Path, value: Encodable]

/** The item's own bytes with the value at `path` replaced. Map keys and array indexes are both
 * numbers; a record is an array of `[key, value]` pairs. */
function forge(item: MessageItem, path: Path, value: Encodable): Uint8Array {
  const root = decodeCanonical(registry.encodeItem(item).bytes) as unknown
  let node = root as Map<bigint, unknown> | unknown[]
  path.forEach((step, depth) => {
    const last = depth === path.length - 1
    if (node instanceof Map) {
      if (last) node.set(BigInt(step), value)
      else {
        if (!node.has(BigInt(step))) throw new Error(`no key ${step} in sample`)
        node = node.get(BigInt(step)) as never
      }
    } else if (Array.isArray(node)) {
      if (last) node[step] = value
      else node = node[step] as never
    } else throw new Error('path leaves the structure')
  })
  return encodeCanonical(root as Encodable)
}

const decode = (type: string, bytes: Uint8Array) =>
  registry.decodeItem(type, bytes, standaloneDecodeContext())

const BAD_AMOUNTS: Encodable[] = [
  '-1',
  '+1',
  '1e18',
  '0x10',
  '01',
  '1.5',
  ' 1',
  '',
  '1'.repeat(79),
  10,
]
const BAD_ADDRESSES: Encodable[] = [
  '0xB',
  'aa'.repeat(20),
  '0x' + 'aa'.repeat(21),
  '0x' + 'zz'.repeat(20),
  '',
]
const BAD_HASHES: Encodable[] = [
  '0x1',
  'ab'.repeat(31),
  'ab'.repeat(33),
  'zz'.repeat(32),
]
const BAD_IDS: Encodable[] = ['', 'x'.repeat(65), 'a b', 'a\nb', '-a']
const BAD_SECRETS: Encodable[] = ['zz', 'abc', 'ab'.repeat(7), 'ab'.repeat(65)]
const BAD_TIMESTAMPS: Encodable[] = [-1, 8_640_000_000_000_001, '1760000000000']
const BAD_DISPLAY_AMOUNTS: Encodable[] = [
  '-1',
  '1e5',
  '.5',
  '1.',
  '1,5',
  '',
  '1'.repeat(41),
]
const BAD_CHAINS: Encodable[] = [
  'monad',
  'evm',
  'MONT',
  'Monad-Testnet',
  'eip155:10143',
  '',
]
const BAD_TX_IDS: Encodable[] = ['', 'a b', '0x12-34', 'a'.repeat(129)]
const BAD_CHAIN_ADDRESSES: Encodable[] = [
  '',
  'a b',
  'a'.repeat(129),
  '<script>',
]

const each = (what: string, path: Path, values: Encodable[]): Case[] =>
  values.map(v => [
    `${what} = ${JSON.stringify(v, (_, x) =>
      typeof x === 'bigint' ? `${x}n` : x,
    )?.slice(0, 48)}`,
    path,
    v,
  ])

const SUITES: Array<{ item: MessageItem; cases: Case[] }> = [
  {
    item: {
      type: 'dice',
      action: 'result',
      rollId: '0011223344556677',
      target: 32768,
      multiplier: 1.962,
      wagerWei: '10',
      luckyNumber: 1234,
      isWin: true,
      serverSecret: '5a'.repeat(16),
      clientSeed: '6b'.repeat(16),
      payoutWei: '19',
      commitment: 'ef'.repeat(32),
      nextRollId: '8899aabbccddeeff',
      nextCommitment: 'ef'.repeat(32),
    },
    cases: [
      ...each('rollId', [1], BAD_IDS),
      ...each('target', [2], [0, 65_536, -1, '5']),
      ...each('multiplier', [3], [65_537, -1, 'NaN', '1e999', true]),
      ...each('wagerWei', [4], BAD_AMOUNTS),
      ...each('luckyNumber', [5], [65_536, -1, '7']),
      ...each('serverSecret', [7], BAD_SECRETS),
      ...each('clientSeed', [8], BAD_SECRETS),
      ...each('payoutWei', [9], BAD_AMOUNTS),
      ...each('commitment', [10], BAD_HASHES),
      ...each('nextRollId', [11], BAD_IDS),
      ...each('nextCommitment', [12], BAD_HASHES),
    ],
  },
  {
    item: {
      type: 'rps',
      action: 'resolve',
      matchId: '0011223344556677',
      commitHash: H,
      playerMove: 'rock',
      botMove: 'paper',
      secretSalt: '5a'.repeat(16),
      wagerWei: '10',
      outcome: 'lose',
      txHash: TX,
      opponentAddress: A,
    },
    cases: [
      ...each('matchId', [1], BAD_IDS),
      ...each('commitHash', [2], BAD_HASHES),
      ...each('playerMove', [3], ['lizard']),
      ...each('secretSalt', [5], BAD_SECRETS),
      ...each('wagerWei', [6], BAD_AMOUNTS),
      ...each('txHash', [8], BAD_HASHES),
      ...each('opponentAddress', [9], BAD_ADDRESSES),
    ],
  },
  {
    item: {
      type: 'raffle',
      raffleId: '00112233445566778899aabbccddeeff',
      action: 'draw',
      entryPriceWei: '10',
      maxEntries: 5,
      entryCount: 2,
      serverSeedHash: H,
      winnerAddress: B,
      serverSeed: '5e'.repeat(32),
      entrants: [A, B],
      entryTxHashes: [H, TX],
      potWei: '20',
      message: 'ok',
    },
    cases: [
      ...each('raffleId', [0], BAD_IDS),
      ...each('entryPriceWei', [2], BAD_AMOUNTS),
      ...each('maxEntries', [3], [0, 1001, -1, '5']),
      ...each('entryCount', [4], [-1, 1001]),
      ...each('serverSeedHash', [5], BAD_HASHES),
      ...each('winnerAddress', [6], BAD_ADDRESSES),
      ...each('serverSeed', [7], BAD_SECRETS),
      ['entrants: 1,001 entries', [8], addresses(1001)],
      ...each('entrants[0]', [8, 0], BAD_ADDRESSES),
      ['entryTxHashes: 1,001 entries', [9], many(1001, H)],
      ...each('entryTxHashes[0]', [9, 0], BAD_HASHES),
      ...each('potWei', [10], BAD_AMOUNTS),
      ['message: 1,025 bytes', [11], 'x'.repeat(1025)],
    ],
  },
  {
    item: {
      type: 'poker',
      tableId: '0011223344556677',
      action: 'settle',
      buyInWei: '100',
      smallBlind: 10,
      bigBlind: 20,
      street: 'settled',
      pot: 60,
      sidePots: [{ amount: 1, eligiblePlayers: [A] }],
      currentBet: 20,
      minRaise: 20,
      activePlayer: A,
      boardCards: [0, 13, 51],
      players: [
        {
          address: A,
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
      ],
      myHoleCards: [12, 25],
      lastAction: { player: A, action: 'call', amount: 20 },
      winners: [
        { address: B, amount: 60, handDescription: 'Pair', best5Cards: [1, 2] },
      ],
      winnerAddress: B,
      txHash: TX,
      stealthAddress: B,
    },
    cases: [
      ...each('tableId', [0], BAD_IDS),
      ...each('buyInWei', [2], BAD_AMOUNTS),
      ...each('smallBlind', [3], [-1, 1_000_000_000_001, '10']),
      ...each('bigBlind', [4], [-1, 1_000_000_000_001]),
      ...each('pot', [6], [-1, 1_000_000_000_001, 'NaN']),
      [
        'sidePots: 17 entries',
        [7],
        many(
          17,
          new Map<number, Encodable>([
            [0, 1],
            [1, [A]],
          ]),
        ),
      ],
      ...each('sidePots[0].amount', [7, 0, 0], [-1]),
      ['sidePots[0].eligiblePlayers: 17', [7, 0, 1], addresses(17)],
      ...each('sidePots[0].eligiblePlayers[0]', [7, 0, 1, 0], BAD_ADDRESSES),
      ...each('currentBet', [8], [-1]),
      ...each('minRaise', [9], [-1]),
      ...each('activePlayer', [10], BAD_ADDRESSES),
      ['boardCards: 6 cards', [11], [0, 1, 2, 3, 4, 5]],
      ...each('boardCards[0]', [11, 0], [52, -1, '1']),
      ['players: 17 seats', [12], many(17, 0)],
      ...each('players[0].address', [12, 0, 0], BAD_ADDRESSES),
      ...each('players[0].chips', [12, 0, 1], [-1, 1_000_000_000_001]),
      ['players[0].holeCards: 3 cards', [12, 0, 9], [1, 2, 3]],
      ...each('players[0].holeCards[0]', [12, 0, 9, 0], [-2, 52]),
      ['myHoleCards: 3 cards', [13], [1, 2, 3]],
      ...each('myHoleCards[0]', [13, 0], [-2, 52]),
      ...each('lastAction.player', [14, 0], BAD_ADDRESSES),
      ...each('lastAction.amount', [14, 2], [-1]),
      ['winners: 17 entries', [15], many(17, 0)],
      ...each('winners[0].amount', [15, 0, 1], [-1]),
      ['winners[0].handDescription: 129 bytes', [15, 0, 2], 'x'.repeat(129)],
      ['winners[0].best5Cards: 6 cards', [15, 0, 3], [0, 1, 2, 3, 4, 5]],
      ...each('winners[0].best5Cards[0]', [15, 0, 3, 0], [52, -1]),
      ...each('winnerAddress', [16], BAD_ADDRESSES),
      ...each('txHash', [17], BAD_HASHES),
      ...each('stealthAddress', [18], BAD_ADDRESSES),
    ],
  },
  {
    item: {
      type: 'liars-dice',
      tableId: '8899aabbccddeeff',
      action: 'showdown',
      buyInWei: '50',
      maxPlayers: 4,
      dicePerPlayer: 5,
      players: [A, B],
      diceCounts: [5, 4],
      roundNumber: 2,
      activePlayer: B,
      turnTimeoutSeconds: 45,
      currentBid: { bidder: A, quantity: 3, face: 4 },
      challenger: B,
      serverCommit: H,
      serverSeed: 'c5'.repeat(32),
      playerCommits: { [A]: H },
      playerSeeds: { [A]: 'a5'.repeat(32) },
      myDice: [1, 3, 4, 4, 6],
      revealedCups: { [A]: [1, 2] },
      challengeResult: {
        bidQuantity: 3,
        bidFace: 4,
        actualCount: 2,
        wildAcesCount: 1,
        challengerWon: true,
        loserAddress: A,
        eliminated: false,
      },
      winnerAddress: B,
      potWei: '100',
      txHash: TX,
      stealthAddress: B,
    },
    cases: [
      ...each('tableId', [0], BAD_IDS),
      ...each('buyInWei', [2], BAD_AMOUNTS),
      ...each('maxPlayers', [3], [0, 17]),
      ...each('dicePerPlayer', [4], [0, 11]),
      ['players: 17', [5], addresses(17)],
      ...each('players[0]', [5, 0], BAD_ADDRESSES),
      ['diceCounts: 17', [6], many(17, 1)],
      ...each('diceCounts[0]', [6, 0], [-1, 11]),
      ...each('roundNumber', [7], [-1, 1_000_001]),
      ...each('activePlayer', [8], BAD_ADDRESSES),
      ...each('turnTimeoutSeconds', [9], [-1, 86_401]),
      ...each('currentBid.bidder', [10, 0], BAD_ADDRESSES),
      ...each('currentBid.quantity', [10, 1], [0, 161]),
      ...each('currentBid.face', [10, 2], [0, 7]),
      ...each('challenger', [11], BAD_ADDRESSES),
      ...each('serverCommit', [12], BAD_HASHES),
      ...each('serverSeed', [13], BAD_SECRETS),
      ['playerCommits: 17 entries', [14], addresses(17).map(a => [a, H])],
      ...each('playerCommits key', [14, 0, 0], BAD_ADDRESSES),
      ...each('playerCommits value', [14, 0, 1], BAD_HASHES),
      ...each('playerSeeds key', [15, 0, 0], BAD_ADDRESSES),
      ...each('playerSeeds value', [15, 0, 1], BAD_SECRETS),
      ['myDice: 11 dice', [16], many(11, 1)],
      ...each('myDice[0]', [16, 0], [0, 7]),
      ['revealedCups: 17 entries', [17], addresses(17).map(a => [a, [1]])],
      ...each('revealedCups key', [17, 0, 0], BAD_ADDRESSES),
      ['revealedCups cup: 11 dice', [17, 0, 1], many(11, 1)],
      ...each('revealedCups die', [17, 0, 1, 0], [0, 7]),
      ...each('challengeResult.bidQuantity', [18, 0], [0, 161]),
      ...each('challengeResult.bidFace', [18, 1], [0, 7]),
      ...each('challengeResult.actualCount', [18, 2], [-1, 161]),
      ...each('challengeResult.wildAcesCount', [18, 3], [-1, 161]),
      ...each('challengeResult.loserAddress', [18, 5], BAD_ADDRESSES),
      ...each('winnerAddress', [19], BAD_ADDRESSES),
      ...each('potWei', [20], BAD_AMOUNTS),
      ...each('txHash', [21], BAD_HASHES),
      ...each('stealthAddress', [22], BAD_ADDRESSES),
    ],
  },
  {
    item: {
      type: 'swap-offer',
      swapId: '00112233445566778899aabbccddeeff',
      offeredChain: 'monad-testnet',
      offeredAsset: 'MON',
      offeredAmount: '0.5',
      requestedChain: 'solana-testnet',
      requestedAsset: 'SOL',
      requestedAmount: '0.01',
      status: 'pending',
      initiatorAddress: A,
      recipientAddress: B,
      createdAt: 1760000000000,
      expiresAt: 1760000600000,
      hashLock: H,
      preimage: H,
      legATxHash: TX,
      legBTxHash: TX,
      claimTxHash: TX,
      originInstanceId: '123e4567-e89b-42d3-a456-426614174000',
    },
    cases: [
      ...each('swapId', [0], BAD_IDS),
      ...each('offeredChain', [1], BAD_CHAINS),
      ...each('offeredAsset', [2], ['', 'a b', 'x'.repeat(129)]),
      ...each('offeredAmount', [3], BAD_DISPLAY_AMOUNTS),
      ...each('requestedChain', [4], BAD_CHAINS),
      ...each('requestedAsset', [5], ['', 'a b']),
      ...each('requestedAmount', [6], BAD_DISPLAY_AMOUNTS),
      ...each('initiatorAddress', [8], BAD_CHAIN_ADDRESSES),
      ...each('recipientAddress', [9], BAD_CHAIN_ADDRESSES),
      ...each('createdAt', [10], BAD_TIMESTAMPS),
      ...each('expiresAt', [11], BAD_TIMESTAMPS),
      ...each('hashLock', [12], BAD_HASHES),
      ...each('preimage', [13], BAD_HASHES),
      ...each('legATxHash', [14], BAD_TX_IDS),
      ...each('legBTxHash', [15], BAD_TX_IDS),
      ...each('claimTxHash', [16], BAD_TX_IDS),
      ...each('originInstanceId', [17], BAD_IDS),
    ],
  },
  {
    item: {
      type: 'swap-record',
      swapId: '00112233445566778899aabbccddeeff',
      chainIdentifier: 'monad-testnet',
      venueId: 'uniswap-v4',
      txHash: '0x' + 'ab'.repeat(32),
      account: '0x' + 'bb'.repeat(20),
      assetIn: { symbol: 'MON', decimals: 18 },
      amountIn: '5000000000000000',
      assetOut: {
        symbol: 'USDC',
        address: '0x534b2f3A21130d7a60830c2Df862319e593943A3',
        decimals: 6,
      },
      quotedAmountOut: '4997',
      minimumAmountOut: '4947',
      interfaceFee: '0',
      networkFee: '21131544000000000',
      route: '{"zeroForOne":true}',
      timestamp: 1760000000000,
    },
    cases: [
      ...each('swapId', [0], BAD_IDS),
      ...each('chainIdentifier', [1], BAD_CHAINS),
      ...each('venueId', [2], BAD_IDS),
      ...each('txHash', [3], BAD_TX_IDS),
      ...each('account', [4], BAD_CHAIN_ADDRESSES),
      ...each('assetIn.symbol', [5, 0], ['', 'a b', 'x'.repeat(33)]),
      ...each('assetIn.decimals', [5, 2], [-1, 37, '18']),
      ...each('amountIn', [6], BAD_AMOUNTS),
      ...each('assetOut.address', [7, 1], BAD_CHAIN_ADDRESSES),
      ...each('quotedAmountOut', [8], BAD_AMOUNTS),
      ...each('minimumAmountOut', [9], BAD_AMOUNTS),
      ...each('interfaceFee', [10], BAD_AMOUNTS),
      ...each('networkFee', [11], BAD_AMOUNTS),
      ['route: 1025 bytes', [12], 'x'.repeat(1025)],
      ...each('timestamp', [13], BAD_TIMESTAMPS),
    ],
  },
  {
    item: {
      type: 'received-coin',
      chainIdentifier: 'monad-testnet',
      address: A,
      origin: 'stamp',
      ephemeralPubKey: '03' + 'cd'.repeat(32),
      stampSharedPoint: '02' + 'ab'.repeat(32),
      childIndex: 1,
      claimedAmountWei: '1000000000000',
      transactions: [H],
      payloadDigest: H,
      timestamp: 1760000000000,
    },
    cases: [
      ...each('chainIdentifier', [0], BAD_CHAINS),
      ...each('address', [1], BAD_CHAIN_ADDRESSES),
      ...each('origin', [2], ['', 'utxo', 1]),
      ...each('ephemeralPubKey', [3], ['zz', 'ab'.repeat(32), 'ab'.repeat(66)]),
      ...each('stampSharedPoint', [4], ['zz', 'ab'.repeat(32), 'ab'.repeat(66)]),
      ...each('childIndex', [5], [-1, 2_147_483_648, '1']),
      ...each('claimedAmountWei', [6], BAD_AMOUNTS),
      ...each('transactions[0]', [7, 0], [
        'zz',
        'ab'.repeat(31),
        'ab'.repeat(16_385),
      ]),
      ['transactions: 17 entries', [7], many(17, H)],
      ...each('payloadDigest', [8], BAD_HASHES),
      ...each('timestamp', [9], BAD_TIMESTAMPS),
    ],
  },
  {
    item: {
      type: 'conversation-state',
      conversationId: '123e4567-e89b-52d3-a456-426614174000',
      peer: A,
      clearedBefore: 1760000000000,
      readUpTo: 1760000000001,
      subject: 'Audit thread',
      subjectSetAt: 1760000000002,
    },
    cases: [
      ...each(
        'conversationId',
        [0],
        [
          '',
          '123e4567e89b52d3a456426614174000',
          '123E4567-E89B-52D3-A456-426614174000',
          '123e4567-e89b-52d3-a456-42661417400',
          1,
        ],
      ),
      ...each('peer', [1], BAD_CHAIN_ADDRESSES),
      ...each('clearedBefore', [2], BAD_TIMESTAMPS),
      ...each('readUpTo', [3], BAD_TIMESTAMPS),
      ['subject: 513 bytes', [4], 'x'.repeat(513)],
      ['subject: not text', [4], 1],
      ...each('subjectSetAt', [5], BAD_TIMESTAMPS),
    ],
  },
  {
    item: {
      type: 'device-claim',
      instanceId: '123e4567-e89b-42d3-a456-426614174000',
      deviceName: 'iOS Device',
      claimedAt: 1760000000000,
      leaseDurationMs: 30_000,
    },
    cases: [
      ...each('instanceId', [0], BAD_IDS),
      ['deviceName: 129 bytes', [1], 'x'.repeat(129)],
      ...each('claimedAt', [2], BAD_TIMESTAMPS),
      ...each('leaseDurationMs', [3], [-1, 2_592_000_001, '30000']),
    ],
  },
  {
    item: { type: 'image', image: 'data:image/png;base64,AAAA' },
    cases: [
      ['image: empty', [0], new Uint8Array()],
      ['image: 524,289 bytes', [0], new Uint8Array(524_289).fill(0x41)],
      ['image: text instead of bytes', [0], 'data:image/png;base64,AAAA'],
      ['image: not UTF-8', [0], Uint8Array.of(0xff, 0xfe)],
    ],
  },
  {
    item: {
      type: 'p2pkh',
      address: 'lotus_16PSJNf1EDEfGvaYzaXJCJZrXH4pgiTo7kyW61iGi',
      amount: 5,
    },
    cases: [
      ...each('address', [0], BAD_CHAIN_ADDRESSES),
      ...each('amount', [1], [-1, 'NaN', '-0.5']),
    ],
  },
  {
    item: { type: 'reply', payloadDigest: H },
    cases: [...each('payloadDigest', [0], ['', 'a b', 'x'.repeat(129), '<b>'])],
  },
  ...(['wallet-sync', 'payment-transfer'] as const).map(type => ({
    item: {
      type,
      direction: 'out' as const,
      chainIdentifier: 'monad-testnet',
      chainId: 'monad-testnet',
      txHash: TX,
      rawTx: '0x02abcd',
      spentInputs: [
        { address: A, nonce: 3, outpoint: `${H}:0`, valueWei: '150' },
      ],
      createdOutputs: [
        {
          address: B,
          valueWei: '100',
          branch: 'spend' as const,
          index: 4,
          outpoint: `${H}:1`,
        },
      ],
      transfer: {
        networkTag: 'monad-testnet',
        txId: TX,
        vout: 0,
        destination: B,
        value: '100',
        token: 'MON',
        rawTx: '0x02abcd',
      },
      memo: 'thanks',
      timestamp: 1760000000000,
    },
    cases: [
      ...each('chainIdentifier', [1], BAD_CHAINS),
      ...each('chainId', [2], ['', 'a b', 'x'.repeat(65)]),
      ...each('txHash', [3], BAD_TX_IDS),
      ...each('rawTx', [4], ['', 'zz', 'abc', 'ab'.repeat(16_385)]),
      ['spentInputs: 257 entries', [5], many(257, 0)],
      ...each('spentInputs[0].address', [5, 0, 0], BAD_CHAIN_ADDRESSES),
      ...each('spentInputs[0].nonce', [5, 0, 1], [-1, '3']),
      ...each(
        'spentInputs[0].outpoint',
        [5, 0, 2],
        ['', 'a b', 'x'.repeat(141)],
      ),
      ...each('spentInputs[0].valueWei', [5, 0, 3], BAD_AMOUNTS),
      ['createdOutputs: 257 entries', [6], many(257, 0)],
      ...each('createdOutputs[0].address', [6, 0, 0], BAD_CHAIN_ADDRESSES),
      ...each('createdOutputs[0].valueWei', [6, 0, 1], BAD_AMOUNTS),
      ...each('createdOutputs[0].index', [6, 0, 3], [-1, 2_147_483_648]),
      ...each('transfer.networkTag', [7, 0], ['', 'a b']),
      ...each('transfer.txId', [7, 1], BAD_TX_IDS),
      ...each('transfer.vout', [7, 2], [-1, 4_294_967_296]),
      ...each('transfer.destination', [7, 3], BAD_CHAIN_ADDRESSES),
      ...each('transfer.value', [7, 4], BAD_AMOUNTS),
      ...each('transfer.rawTx', [7, 6], ['zz']),
      ['memo: 1,025 bytes', [8], 'x'.repeat(1025)],
      ...each('timestamp', [9], BAD_TIMESTAMPS),
    ] as Case[],
  })),
  {
    item: {
      type: 'digital-goods',
      action: 'catalog',
      catalog: [
        {
          itemId: 'sticker_1',
          description: 'A sticker',
          priceWei: '50',
          thumbnail: 'data:image/png;base64,AAAA',
        },
      ],
      itemId: 'sticker_1',
      message: 'ok',
    },
    cases: [
      ['catalog: 51 entries', [1], many(51, 0)],
      ...each(
        'catalog[0].itemId',
        [1, 0, 0],
        ['', 'a b', 'x'.repeat(65), 'a/b'],
      ),
      ...each('catalog[0].description', [1, 0, 1], ['', 'x'.repeat(801)]),
      ...each('catalog[0].priceWei', [1, 0, 2], BAD_AMOUNTS),
      [
        'catalog[0].thumbnail: 65,537 bytes',
        [1, 0, 3],
        new Uint8Array(65_537).fill(0x41),
      ],
      ['catalog[0].thumbnail: empty', [1, 0, 3], new Uint8Array()],
      ...each('itemId', [2], ['', 'a b', 'x'.repeat(65)]),
      ['message: 1,025 bytes', [3], 'x'.repeat(1025)],
    ],
  },
]

describe('the sixteen CBOR item decoders refuse out-of-range, misformatted and oversize fields', () => {
  it('covers exactly the sixteen CBOR-map plugins', () => {
    expect(SUITES.map(s => s.item.type).sort()).toEqual(
      [
        'conversation-state',
        'device-claim',
        'dice',
        'digital-goods',
        'image',
        'liars-dice',
        'p2pkh',
        'payment-transfer',
        'poker',
        'raffle',
        'received-coin',
        'reply',
        'rps',
        'swap-offer',
        'swap-record',
        'wallet-sync',
      ].sort(),
    )
  })

  describe.each(SUITES.map(s => [s.item.type, s] as const))(
    '%s',
    (type, suite) => {
      it('accepts the unmodified sample', () => {
        const { bytes } = registry.encodeItem(suite.item)
        expect(decode(type, bytes)).toEqual({ kind: 'item', item: suite.item })
      })

      it.each(suite.cases)('refuses %s', (_, path, value) => {
        const bytes = forge(suite.item, path, value)
        expect(() => decode(type, bytes)).toThrow(MessageItemDecodeError)
      })
    },
  )

  it('the forgery itself is sound: a valid replacement at the same place is accepted', () => {
    const [dice, , , poker, liars] = SUITES
    expect(decode('dice', forge(dice.item, [2], 5))).toMatchObject({
      item: { target: 5 },
    })
    expect(decode('poker', forge(poker.item, [12, 0, 9, 0], 51))).toMatchObject(
      { item: { players: [{ holeCards: [51, -1] }] } },
    )
    expect(
      decode('liars-dice', forge(liars.item, [17, 0, 1, 0], 6)),
    ).toMatchObject({ item: { revealedCups: { [A]: [6, 2] } } })
    expect(
      decode('liars-dice', forge(liars.item, [14, 0, 0], B)),
    ).toMatchObject({ item: { playerCommits: { [B]: H } } })
  })

  it('refuses the same values when an item is written, with the typed encode error', () => {
    const bad: MessageItem[] = [
      { type: 'dice', action: 'result', target: 0 },
      { type: 'dice', action: 'result', luckyNumber: 1.5 },
      { type: 'dice', action: 'result', wagerWei: '-1' },
      { type: 'dice', action: 'result', multiplier: NaN },
      { type: 'rps', action: 'challenge', opponentAddress: '0xB' },
      {
        type: 'raffle',
        raffleId: 'r',
        action: 'draw',
        entrants: addresses(1001),
      },
      { type: 'raffle', raffleId: 'r', action: 'announce', maxEntries: NaN },
      {
        type: 'poker',
        tableId: 't',
        action: 'action',
        smallBlind: 10,
        bigBlind: 20,
        pot: NaN,
      },
      { type: 'liars-dice', tableId: 't', action: 'bid', myDice: [7] },
      { type: 'reply', payloadDigest: 'a b' },
      { type: 'image', image: '' },
      {
        type: 'wallet-sync',
        direction: 'out',
        chainIdentifier: 'monad',
        txHash: TX,
      },
      { type: 'digital-goods', action: 'request', itemId: 'a b' },
    ]
    for (const item of bad)
      expect(() => registry.encodeItem(item)).toThrow(MessageItemEncodeError)
  })
})

describe('tallyValue is never NaN', () => {
  it('ignores a value that is not a finite number, whatever a plugin returns', () => {
    const swap = {
      type: 'swap-offer',
      swapId: 's',
      offeredChain: 'monad-testnet',
      offeredAsset: 'MON',
      offeredAmount: 'not a number',
      requestedChain: 'monad-testnet',
      requestedAsset: 'MON',
      requestedAmount: '1',
      status: 'pending',
      createdAt: 0,
    } as MessageItem
    const sync = {
      type: 'wallet-sync',
      direction: 'in',
      chainIdentifier: 'monad-testnet',
      txHash: TX,
      createdOutputs: [
        { address: A, valueWei: 'junk' },
        { address: B, valueWei: '7' },
      ],
    } as MessageItem
    expect(registry.tallyValue([swap])).toBe(0)
    expect(registry.tallyValue([sync])).toBe(7)
    expect(
      registry.tallyValue([
        swap,
        sync,
        { type: 'stealth', amount: NaN },
        { type: 'stealth', amount: 5 },
      ]),
    ).toBe(12)
  })

  it('such an amount never arrives: the decoder refuses it first', () => {
    const good = {
      type: 'swap-offer',
      swapId: 's1',
      offeredChain: 'monad-testnet',
      offeredAsset: 'MON',
      offeredAmount: '0.5',
      requestedChain: 'monad-testnet',
      requestedAsset: 'MON',
      requestedAmount: '1',
      status: 'pending',
      createdAt: 0,
    } as MessageItem
    expect(() =>
      decode('swap-offer', forge(good, [3], 'not a number')),
    ).toThrow(MessageItemDecodeError)
    expect(registry.tallyValue([good])).toBe(0.5)
  })
})
