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
const mockOpened: unknown[] = []
jest.mock('src/accounts/evm-wallets', () => ({
  openEvmWallet: (id: string) => mockOpenEvmWallet(id),
  peekOpenedEvmWallets: () => mockOpened,
}))

import { Interface } from 'ethers'
import {
  EvmSwapUnavailableError,
  evmRecordedSwapVenues,
  evmSwapVenues,
  openEvmSwapSession,
  openRecordedEvmSwapSession,
} from './evm-swap-session'

const ACCOUNT = '0x1111111111111111111111111111111111111111'
const mockReceipts = new Map<string, unknown>()
const walletFor = (chainIdentifier: string) => ({
  family: 'evm',
  chainIdentifier,
  evmReader: {
    call: jest.fn(),
    getTransactionReceipt: async (hash: string) =>
      mockReceipts.get(hash) ?? null,
    getTransaction: async () => ({}),
  },
  reobserveNativeOperations: jest.fn(async () => undefined),
  sendContractCall: jest.fn(),
  getContractCallFunds: jest.fn(),
  getReceiveAddress: async () => ({
    raw: '0x1111111111111111111111111111111111111111',
  }),
})

beforeEach(() => {
  mockReceipts.clear()
  mockOpened.length = 0
  mockOpenEvmWallet.mockReset()
  mockOpenEvmWallet.mockImplementation(async (id: string) => {
    const open = { wallet: walletFor(id) }
    mockOpened.push(open)
    return open
  })
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
  // A session whose wallet was closed (or replaced) is no longer current.
  mockOpened.length = 0
  expect(session.isCurrent()).toBe(false)
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

describe('while an interface fee is configured', () => {
  const saved = { ...process.env }
  beforeEach(() => {
    process.env.EVM_SWAP_INTERFACE_FEE_RECIPIENT =
      '0x3333333333333333333333333333333333333333'
    process.env.SWAP_INTERFACE_FEE_BPS = '25'
  })
  afterEach(() => {
    process.env = { ...saved }
  })

  it('offers no new HyperSwap quote, but a past HyperSwap swap still shows and reconciles', async () => {
    // Not offered: HyperSwap's routers cannot carry the fee.
    expect(evmSwapVenues('hyperliquid-testnet')).toEqual([])
    await expect(openEvmSwapSession('hyperliquid-testnet')).rejects.toEqual(
      new EvmSwapUnavailableError('no-deployment'),
    )
    // What was already done there is still read and finished.
    expect(
      evmRecordedSwapVenues('hyperliquid-testnet').map(v => v.displayName),
    ).toEqual(['HyperSwap V2'])
    const session = await openRecordedEvmSwapSession(
      'hyperliquid-testnet',
      'hyperswap-v2',
    )
    expect(session.dex).toBeInstanceOf(HyperSwapV2Dex)
    const entry = evmRecordedSwapVenues('hyperliquid-testnet')[0] as {
      swapRouter: string
      wrappedNative: string
      pairs: { address: string }[]
      tokens: { address: string | null }[]
    }
    const purr = entry.tokens[1]!.address!
    const pair = entry.pairs[0]!.address
    const route = {
      kind: 'hyperswap-v2',
      pair,
      path: [entry.wrappedNative, purr],
    }
    const pairAbi = new Interface([
      'event Swap(address indexed sender, uint256 amount0In, uint256 amount1In, uint256 amount0Out, uint256 amount1Out, address indexed to)',
    ])
    const erc20 = new Interface([
      'event Transfer(address indexed from, address indexed to, uint256 value)',
    ])
    mockReceipts.set('0xpast', {
      from: ACCOUNT,
      to: entry.swapRouter,
      status: 1,
      blockNumber: 7,
      gasUsed: 100_000n,
      gasPrice: 1n,
      logs: [
        {
          address: purr,
          ...erc20.encodeEventLog('Transfer', [pair, ACCOUNT, 1900n]),
        },
        {
          address: pair,
          ...pairAbi.encodeEventLog('Swap', [
            entry.swapRouter,
            1000n,
            0n,
            0n,
            1900n,
            ACCOUNT,
          ]),
        },
      ],
    })
    expect(
      await session.dex.observe({
        transactionId: '0xpast',
        account: ACCOUNT,
        route,
      }),
    ).toMatchObject({ status: 'confirmed', amountOut: 1900n })
    const swapRouter = new Interface([
      'function swapExactTokensForTokens(uint256 amountIn, uint256 amountOutMin, address[] path, address to) payable returns (uint256 amountOut)',
      'function multicall(uint256 deadline, bytes[] data) payable returns (bytes[] results)',
    ])
    expect(
      await session.dex.reconcile({
        transactionId: '0xpast',
        operationId: 'op-1',
        account: ACCOUNT,
        route,
        call: {
          to: entry.swapRouter,
          value: '1000',
          data: swapRouter.encodeFunctionData('multicall', [
            2_000_000_000,
            [
              swapRouter.encodeFunctionData('swapExactTokensForTokens', [
                1000n,
                1n,
                route.path,
                ACCOUNT,
              ]),
            ],
          ]),
        },
      }),
    ).toMatchObject({ status: 'confirmed', amountOut: 1900n })
  })

  it('reads a recorded Uniswap swap with the fee it is offered with', async () => {
    expect(evmRecordedSwapVenues('monad-testnet')[0]?.interfaceFee).toEqual({
      bps: 25,
      recipient: '0x3333333333333333333333333333333333333333',
    })
  })
})
