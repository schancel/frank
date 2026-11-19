/**
 * The EVM swap composition: which wallet a session swaps with, and which adapter class an
 * entry's `adapter` key builds. The adapters have their own tests.
 */
import { HyperSwapV2Dex } from '@frank/wallet/swap/hyperswap-v2'
import { UniswapV4Dex } from '@frank/wallet/swap/uniswap-v4-dex'

const mockState = { status: 'ready', account: { id: 'a' }, revision: 1 }
const mockGetWallet = jest.fn(async () => ({}))
jest.mock('src/accounts/session', () => ({
  accountSession: {
    getWallet: () => mockGetWallet(),
    get state() {
      return mockState
    },
  },
}))
const mockOpenEvmWallet = jest.fn()
jest.mock('src/accounts/evm-wallets', () => ({
  openEvmWallet: (id: string) => mockOpenEvmWallet(id),
}))

import {
  EvmSwapUnavailableError,
  evmSwapVenues,
  openEvmSwapSession,
} from './evm-swap-session'

const walletFor = (chainIdentifier: string) => ({
  family: 'evm',
  chainIdentifier,
  evmReader: { call: jest.fn() },
  sendContractCall: jest.fn(),
  getContractCallFunds: jest.fn(),
  getReceiveAddress: async () => ({
    raw: '0x1111111111111111111111111111111111111111',
  }),
})

beforeEach(() => {
  mockOpenEvmWallet.mockReset()
  mockOpenEvmWallet.mockImplementation(async (id: string) => ({
    wallet: walletFor(id),
  }))
})

it('swaps on Hyperliquid testnet with its own EVM wallet, through HyperSwap V2', async () => {
  expect(evmSwapVenues('hyperliquid-testnet').map(v => v.id)).toEqual([
    'hyperswap-v2',
  ])
  const session = await openEvmSwapSession('hyperliquid-testnet')
  expect(mockOpenEvmWallet).toHaveBeenCalledWith('hyperliquid-testnet')
  expect(session.dex).toBeInstanceOf(HyperSwapV2Dex)
  expect(session.dex.chainIdentifier).toBe('hyperliquid-testnet')
  expect(session.dex.entry.id).toBe('hyperswap-v2')
  expect(session.isCurrent()).toBe(true)
})

it('keeps Uniswap v4 for Monad testnet, through the same wallet path', async () => {
  const session = await openEvmSwapSession('monad-testnet')
  expect(mockOpenEvmWallet).toHaveBeenCalledWith('monad-testnet')
  expect(session.dex).toBeInstanceOf(UniswapV4Dex)
})

it('names no default: a network with no venue, or a venue it lacks, has no swap', async () => {
  for (const [chain, venue] of [
    ['hyperliquid-mainnet', undefined],
    ['ethereum-sepolia', undefined],
    ['hyperliquid-testnet', 'uniswap-v4'],
  ] as const)
    await expect(openEvmSwapSession(chain, venue)).rejects.toEqual(
      new EvmSwapUnavailableError('no-deployment'),
    )
  expect(mockOpenEvmWallet).not.toHaveBeenCalled()
})

it('refuses a wallet of another network', async () => {
  mockOpenEvmWallet.mockImplementation(async () => ({
    wallet: walletFor('monad-testnet'),
  }))
  await expect(openEvmSwapSession('hyperliquid-testnet')).rejects.toEqual(
    new EvmSwapUnavailableError('wrong-network'),
  )
})
