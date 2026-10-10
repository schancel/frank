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
jest.mock('../accounts/session', () => ({
  accountSession: {
    getWallet: async () => mockIdentityWallet,
    getCachedChainAddress: () => 'SoLAccount',
  },
}))

import type { SwapRecordItem } from '@frank/cashweb/types/messages'
import { keccak256, toUtf8Bytes, getBytes } from 'ethers'
import {
  sendSolanaLegacySyncNote,
  solanaLegacyJournal,
} from '../accounts/solana-legacy'
import {
  solanaSwapActivity,
  solanaSwapVenuePresentations,
} from './useSolanaSwap'

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

  it('journals on this device, and an unreadable journal is an error, not an empty one', () => {
    expect(solanaLegacyJournal().list()).toEqual([])
    window.localStorage.setItem('frank:solana-legacy:v1', '{not json')
    expect(() => solanaLegacyJournal().list()).toThrow(/could not be read/)
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
})
