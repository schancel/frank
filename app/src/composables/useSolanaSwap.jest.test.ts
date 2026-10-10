/** @jest-environment jsdom */
/**
 * What the app composes around the Solana wallet's swaps: the exchanges it lists for the swap
 * view, the wallet's sync event as a free note to self, and the activity list's reads.
 */
const mockSend = jest.fn()
const mockIdentityWallet = { identity: { address: { raw: '0xSELF' } } }

jest.mock('@frank/wallet/chain', () => ({
  ...jest.requireActual('@frank/wallet/chain'),
  activeChain: {
    isTestnet: true,
    directMessages: { send: (...args: unknown[]) => mockSend(...args) },
  },
}))
jest.mock('../accounts/native-transfer', () => ({
  createNativeTransferContext: jest.fn(),
}))
const mockSession = { account: 'SoLAccount', revision: 1 }
jest.mock('../accounts/session', () => ({
  accountSession: {
    state: {
      get revision() {
        return mockSession.revision
      },
    },
    getWallet: async () => mockIdentityWallet,
    getCachedChainAddress: () => mockSession.account,
  },
}))
const mockResume = jest.fn()
jest.mock('@frank/wallet/solana-swap', () => ({
  ...jest.requireActual('@frank/wallet/solana-swap'),
  resumeSolanaLegacyTransactions: (...args: unknown[]) => mockResume(...args),
}))
const mockConnections = jest.fn()
jest.mock('@solana/web3.js', () => {
  const actual = jest.requireActual('@solana/web3.js')
  return {
    ...actual,
    Connection: class extends actual.Connection {
      constructor(url: string, commitment: string) {
        super(url, commitment)
        mockConnections(url)
      }
    },
  }
})

import type { SwapRecordItem } from '@frank/cashweb/types/messages'
import { keccak256, toUtf8Bytes, getBytes } from 'ethers'
import {
  sendSolanaLegacySyncNote,
  solanaLegacyJournal,
} from '../accounts/solana-legacy'
import type { SolanaSwapRecord } from '@frank/wallet/solana-swap'
import {
  resumeSolanaSwaps,
  solanaSwapActivity,
  solanaSwapVenuePresentations,
} from './useSolanaSwap'

const mockHandleSwapItem = jest.fn()
jest.mock('../stores/swaps', () => ({
  useSwapStore: () => ({ handleSwapItem: mockHandleSwapItem }),
}))

const record = (account: string, transactionId: string): SolanaSwapRecord => ({
  chainIdentifier: 'solana-devnet',
  venueId: 'orca-whirlpools',
  venueName: 'Orca Whirlpools (devnet)',
  route: 'Orca Whirlpool',
  transactionId,
  account,
  assetIn: { symbol: 'SOL', address: null, decimals: 9 },
  amountIn: '10000000',
  assetOut: { symbol: 'devUSDC', address: 'mint', decimals: 6 },
  quotedAmountOut: '222201',
  minimumAmountOut: '221089',
  interfaceFeeAmount: '0',
  networkFeeLamports: '5000',
  priorityFeeLamports: '0',
  signedAtMs: 1,
  recovery: { signedTransaction: 'AQID', lastValidBlockHeight: '100' },
})

const item: SwapRecordItem = {
  type: 'swap-record',
  swapId: 'b'.repeat(64),
  chainIdentifier: 'solana-devnet',
  venueId: 'orca-whirlpools',
  txHash: 'SIG123',
  account: 'SoLAccount',
  assetIn: { symbol: 'SOL', decimals: 9 },
  amountIn: '10000000',
  assetOut: { symbol: 'devUSDC', address: 'mint', decimals: 6 },
  quotedAmountOut: '222201',
  minimumAmountOut: '221089',
  interfaceFee: '0',
  networkFee: '5000',
  route: '{"label":"Orca Whirlpool"}',
  timestamp: 1,
}

beforeEach(() => {
  window.localStorage.clear()
  mockSend.mockReset().mockResolvedValue(undefined)
  mockResume.mockReset()
  mockConnections.mockReset()
  mockHandleSwapItem.mockReset()
  mockSession.account = 'SoLAccount'
  mockSession.revision = 1
})

describe("the Solana wallet's sync event", () => {
  it('goes out as a free note from the account to itself, carrying only the record', async () => {
    await sendSolanaLegacySyncNote(item)
    expect(mockSend).toHaveBeenCalledWith({
      wallet: mockIdentityWallet,
      recipient: { raw: '0xSELF' },
      items: [item],
      stampValue: 0n,
      // Derived from the chain and the transaction: sending it again is the same message.
      messageId: getBytes(
        keccak256(toUtf8Bytes('frank-wallet-sync:solana-devnet:SIG123')),
      ).slice(0, 16),
    })
  })

  it('counts a note this wallet already sent as sent, and reports any other failure', async () => {
    mockSend.mockRejectedValueOnce(
      Object.assign(new Error('again'), {
        name: 'DirectMessageAlreadyAttemptedError',
      }),
    )
    await expect(sendSolanaLegacySyncNote(item)).resolves.toBeUndefined()
    mockSend.mockRejectedValueOnce(new Error('mailbox unreachable'))
    await expect(sendSolanaLegacySyncNote(item)).rejects.toThrow(
      'mailbox unreachable',
    )
  })

  it("is not sent from another account: the note stays owed to the swap's own account", async () => {
    // The user switched accounts while the swap was landing.
    mockSession.account = 'OtherAccount'
    await expect(sendSolanaLegacySyncNote(item)).rejects.toThrow(
      /another account/,
    )
    expect(mockSend).not.toHaveBeenCalled()
    // Back on the swap's account it goes out.
    mockSession.account = 'SoLAccount'
    await expect(sendSolanaLegacySyncNote(item)).resolves.toBeUndefined()
    expect(mockSend).toHaveBeenCalledTimes(1)
  })

  it('journals on this device, and an unreadable journal is an error, not an empty one', () => {
    const journal = solanaLegacyJournal('SoLAccount', 'solana-devnet')
    expect(journal.list()).toEqual([])
    window.localStorage.setItem(
      'frank:solana-legacy:v2:solana-devnet:SoLAccount',
      '{not json',
    )
    expect(() => journal.list()).toThrow(/could not be read/)
  })

  it("keeps each account's transactions to itself", () => {
    const mine = solanaLegacyJournal('SoLAccount', 'solana-devnet')
    const theirs = solanaLegacyJournal('OtherAccount', 'solana-devnet')
    mine.put(record('SoLAccount', 'MINE'))
    theirs.put(record('OtherAccount', 'THEIRS'))
    expect(mine.list().map(entry => entry.record.transactionId)).toEqual([
      'MINE',
    ])
    // One account cannot settle or clear another's entry, nor record under another's name.
    mine.settle('THEIRS', 'confirmed')
    mine.remove('THEIRS')
    expect(theirs.list()).toEqual([
      { record: record('OtherAccount', 'THEIRS') },
    ])
    expect(() => mine.put(record('OtherAccount', 'X'))).toThrow(
      /another account/,
    )
    // Nor does the same account's other network see it.
    expect(solanaLegacyJournal('SoLAccount', 'solana-mainnet').list()).toEqual(
      [],
    )
  })
})

describe('when the account opens', () => {
  it('asks the network nothing when the wallet has no unfinished transaction', async () => {
    await resumeSolanaSwaps()
    expect(mockResume).not.toHaveBeenCalled()
    expect(mockConnections).not.toHaveBeenCalled()
    expect(mockHandleSwapItem).not.toHaveBeenCalled()
  })

  it("follows this account's unfinished transactions and offers its owed notes, no swap screen needed", async () => {
    const journal = solanaLegacyJournal('SoLAccount', 'solana-devnet')
    journal.put(record('SoLAccount', 'UNFINISHED'))
    journal.put(record('SoLAccount', 'OWED'))
    journal.settle('OWED', 'confirmed')
    solanaLegacyJournal('OtherAccount', 'solana-devnet').put(
      record('OtherAccount', 'THEIRS'),
    )
    await resumeSolanaSwaps()
    // The wallet's own resume: follows the unfinished one, offers the owed note again.
    expect(mockResume).toHaveBeenCalledTimes(1)
    const [connection, resumed, options] = mockResume.mock.calls[0]
    expect(mockConnections).toHaveBeenCalledTimes(1)
    expect(connection.rpcEndpoint).toMatch(/solana-devnet/)
    expect(
      resumed
        .list()
        .map((entry: { record: SolanaSwapRecord }) => [
          entry.record.transactionId,
        ]),
    ).toEqual([['UNFINISHED'], ['OWED']])
    expect(options.onSync).toBe(sendSolanaLegacySyncNote)
    // This device's records are in the swap history at once.
    expect(mockHandleSwapItem.mock.calls.map(([swap]) => swap.txHash)).toEqual([
      'UNFINISHED',
      'OWED',
    ])
  })

  it('does not take an unreadable journal for an empty one', async () => {
    window.localStorage.setItem(
      'frank:solana-legacy:v2:solana-devnet:SoLAccount',
      '{not json',
    )
    await expect(resumeSolanaSwaps()).rejects.toThrow(/could not be read/)
  })
})

describe('what the swap view and the activity list are given', () => {
  it('lists only enabled exchanges, with the props the swap view passes the panel', () => {
    expect(solanaSwapVenuePresentations('solana-devnet', 'solana')).toEqual([
      {
        id: 'orca-whirlpools',
        label: 'Orca Whirlpools (devnet)',
        panelProps: {
          chainIdentifier: 'solana-devnet',
          walletId: 'solana',
          venueId: 'orca-whirlpools',
        },
      },
    ])
    expect(solanaSwapVenuePresentations('solana-mainnet', 'solana')).toEqual([])
  })

  it('answers for Solana networks that list an exchange, and for no other', async () => {
    const devnet = solanaSwapActivity('solana-devnet')
    expect(await devnet?.account()).toBe('SoLAccount')
    expect(devnet?.venueName('orca-whirlpools')).toBe(
      'Orca Whirlpools (devnet)',
    )
    expect(devnet?.venueName('nope')).toBeUndefined()
    // Listed though not enabled: a record made there is still readable.
    expect(solanaSwapActivity('solana-mainnet')?.venueName('jupiter')).toBe(
      'Jupiter',
    )
    expect(solanaSwapActivity('monad-testnet')).toBeUndefined()
    expect(solanaSwapActivity('solana-testnet')).toBeUndefined()
  })

  it('a record from an exchange this build does not list is unknown, not disowned', async () => {
    // Nothing is decided, so nothing is remembered against the record; and no read is made.
    await expect(
      solanaSwapActivity('solana-devnet')!.observe({
        ...item,
        venueId: 'an-exchange-added-later',
      } as never),
    ).resolves.toBeUndefined()
    expect(mockConnections).not.toHaveBeenCalled()
  })
})
