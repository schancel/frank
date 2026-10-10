/** @jest-environment jsdom */

import { webcrypto } from 'crypto'
import { Keypair } from '@solana/web3.js'
import { getBase58Decoder } from '@solana/codecs-strings'
import {
  activeChain,
  NativeTransactionSubmissionError,
} from '@frank/wallet/chain'
import {
  createNativeTransferContext,
  inspectNativeTransferOperations,
} from './native-transfer'
import protocol from '../../../docs/protocol/chains/v1.json'

const mockPrimaryWallet = { chainIdentifier: 'monad-testnet' }
const mockState = { status: 'ready', account: { id: 'account-a' }, revision: 1 }
const mockGetWallet = jest.fn()
const mockGetRoot = jest.fn()
const mockConnection = {
  getGenesisHash: jest.fn(),
  getBalance: jest.fn(),
  getLatestBlockhash: jest.fn(),
  getSignatureStatus: jest.fn(),
  sendRawTransaction: jest.fn(),
}
const mockRpcUrl = jest.fn()

jest.mock('./session', () => ({
  accountSession: {
    get state() {
      return mockState
    },
    getWallet: () => mockGetWallet(),
    getActiveDomainRoot: (purpose: string) => mockGetRoot(purpose),
  },
}))
jest.mock('@solana/web3.js', () => ({
  ...jest.requireActual('@solana/web3.js'),
  Connection: jest.fn((url: string) => {
    mockRpcUrl(url)
    return mockConnection
  }),
}))
const mockRegistryOverride = jest.fn((_id: string): unknown => undefined)
jest.mock('@frank/wallet/chain', () => {
  const actual = jest.requireActual('@frank/wallet/chain')
  return {
    ...actual,
    getChainRegistryEntry: (id: string) =>
      mockRegistryOverride(id) ?? actual.getChainRegistryEntry(id),
    loadMonadChainConfigFromEnv: () => ({
      relayBaseUrl: 'https://relay.invalid',
    }),
  }
})
const mockOpenUtxoWallet = jest.fn()
jest.mock('./utxo-wallets', () => ({
  openUtxoWallet: (chainIdentifier: string) =>
    mockOpenUtxoWallet(chainIdentifier),
}))

const genesis = protocol.chains
  .find(chain => chain.id === 'solana-devnet')!
  .identity_probes.find(probe => probe.kind === 'genesis-hash')!.expected!

beforeAll(() => {
  Object.defineProperty(navigator, 'locks', {
    value: {
      request: (_key: string, operation: () => Promise<unknown>) => operation(),
    },
    configurable: true,
  })
  Object.defineProperty(globalThis, 'isSecureContext', {
    value: true,
    configurable: true,
  })
  Object.defineProperty(globalThis, 'crypto', {
    value: webcrypto,
    configurable: true,
  })
})

beforeEach(() => {
  jest.clearAllMocks()
  localStorage.clear()
  mockState.status = 'ready'
  mockState.account = { id: 'account-a' }
  mockState.revision = 1
  mockGetWallet.mockReset().mockResolvedValue(mockPrimaryWallet)
  mockGetRoot
    .mockReset()
    .mockImplementation(async () => new Uint8Array(32).fill(7))
  mockConnection.getGenesisHash.mockReset().mockResolvedValue(genesis)
  mockConnection.getBalance.mockReset().mockResolvedValue(15_000_000_000)
  mockConnection.getLatestBlockhash.mockReset().mockResolvedValue({
    blockhash: '11111111111111111111111111111111',
    lastValidBlockHeight: 500,
  })
  mockConnection.getSignatureStatus
    .mockReset()
    .mockResolvedValue({ value: null })
  mockConnection.sendRawTransaction
    .mockReset()
    .mockImplementation(async (raw: Uint8Array) =>
      getBase58Decoder().decode(raw.subarray(1, 65)),
    )
})

it('composes canonical Solana from the same receive-address root and sends only through that wallet', async () => {
  const root = new Uint8Array(32).fill(7)
  const expected = await Keypair.fromSeed(new Uint8Array(root))
  mockGetRoot.mockResolvedValueOnce(root)
  const context = await createNativeTransferContext('solana-devnet')
  expect(mockGetRoot).not.toHaveBeenCalled()
  const binding = await context.captureWallet()
  expect(mockGetRoot).toHaveBeenCalledWith('solana-wallet')
  expect(root.every(byte => byte === 0)).toBe(true)
  expect((await binding.wallet.getReceiveAddress()).raw).toBe(
    expected.publicKey.toBase58(),
  )
  expect(binding.wallet.chainIdentifier).toBe('solana-devnet')
  expect(mockRpcUrl).toHaveBeenCalledWith(
    'https://relay.invalid/chain-rpc/solana-devnet/rpc',
  )
  const onSigned = jest.fn(async () => undefined)
  const result = await context.chain.nativeTransfers.send({
    wallet: binding.wallet,
    recipient: {
      raw: (
        await Keypair.fromSeed(new Uint8Array(32).fill(8))
      ).publicKey.toBase58(),
    },
    value: 1_000_000n,
    onSigned,
  })
  expect(result.txHash).toBeTruthy()
  expect(onSigned).toHaveBeenCalledWith({ txHash: result.txHash })
  expect(mockConnection.sendRawTransaction).toHaveBeenCalledTimes(1)
  expect(mockConnection.getGenesisHash).toHaveBeenCalled()
})

it('rejects an RPC on another Solana cluster before signing or broadcast', async () => {
  mockConnection.getGenesisHash.mockResolvedValue('wrong-genesis')
  const context = await createNativeTransferContext('solana-devnet')
  const binding = await context.captureWallet()
  const onSigned = jest.fn()
  await expect(
    context.chain.nativeTransfers.send({
      wallet: binding.wallet,
      recipient: { raw: '11111111111111111111111111111111' },
      value: 1_000_000n,
      onSigned,
    }),
  ).rejects.toThrow('genesis mismatch')
  expect(onSigned).not.toHaveBeenCalled()
  expect(mockConnection.sendRawTransaction).not.toHaveBeenCalled()
})

it.each(['unknown', 'solana', 'xec-testnet', 'solana-testnet'])(
  'rejects unsupported/noncanonical route %s',
  async id => {
    await expect(createNativeTransferContext(id)).rejects.toThrow()
    expect(mockGetWallet).not.toHaveBeenCalled()
    expect(mockGetRoot).not.toHaveBeenCalled()
  },
)

it('refuses a root acquired while the account changed and wipes its copy', async () => {
  const root = new Uint8Array(32).fill(7)
  mockGetRoot.mockImplementationOnce(async () => {
    mockState.revision++
    return root
  })
  const context = await createNativeTransferContext('solana-devnet')
  await expect(context.captureWallet()).rejects.toThrow('Account changed')
  expect(root.every(byte => byte === 0)).toBe(true)
})

it.each(['revision', 'account', 'locked', 'wallet'])(
  'refuses confirmation after %s changes',
  async change => {
    const context = await createNativeTransferContext('solana-devnet')
    const binding = await context.captureWallet()
    if (change === 'revision') mockState.revision++
    if (change === 'account') mockState.account = { id: 'account-b' }
    if (change === 'locked') mockState.status = 'locked'
    if (change === 'wallet')
      mockGetWallet.mockResolvedValue({ chainIdentifier: 'monad-testnet' })
    await expect(binding.assertCurrent()).rejects.toThrow('Account changed')
    expect(mockConnection.sendRawTransaction).not.toHaveBeenCalled()
  },
)

it('snapshots the primary adapter and rejects a primary wallet with a different network', async () => {
  const original = activeChain.chainIdentifier
  const context = await createNativeTransferContext(original)
  expect(context.chain).not.toBe(activeChain)
  mockGetWallet.mockResolvedValue({ chainIdentifier: 'monad-mainnet' })
  await expect(context.captureWallet()).rejects.toThrow(
    'Wallet network differs',
  )
})

it('keeps the exact signed hash after a broadcast timeout and blocks a fresh transaction on retry', async () => {
  // Fresh account avoids the successful-attempt record from the earlier send test.
  mockGetRoot.mockImplementation(async () => new Uint8Array(32).fill(9))
  mockConnection.sendRawTransaction.mockRejectedValue(
    new TypeError('confirmation response lost after broadcast'),
  )
  const context = await createNativeTransferContext('solana-devnet')
  const binding = await context.captureWallet()
  const onSigned = jest.fn(async () => undefined)
  const params = {
    wallet: binding.wallet,
    recipient: {
      raw: (
        await Keypair.fromSeed(new Uint8Array(32).fill(8))
      ).publicKey.toBase58(),
    },
    value: 1_000_000n,
    onSigned,
  }
  let error: unknown
  try {
    await context.chain.nativeTransfers.send(params)
  } catch (err) {
    error = err
  }
  expect(error).toBeInstanceOf(NativeTransactionSubmissionError)
  const hash = (error as NativeTransactionSubmissionError).transaction.txHash
  expect(onSigned).toHaveBeenCalledWith({ txHash: hash })
  // Reopening the page creates another owned handle; its persisted guard still blocks resending.
  const reopened = await context.captureWallet()
  await expect(
    context.chain.nativeTransfers.send({ ...params, wallet: reopened.wallet }),
  ).rejects.toMatchObject({
    transaction: { txHash: hash },
  })
  expect(onSigned).toHaveBeenCalledTimes(1)
  expect(mockConnection.sendRawTransaction).toHaveBeenCalledTimes(1)
})

it('inspects only the captured compatible owner and makes capability absence explicit', () => {
  const effects = jest.fn(() => {
    throw new Error('unexpected mutation')
  })
  const wallet = {
    family: 'evm',
    chainIdentifier: 'monad-testnet',
    getNativeOperations: jest.fn(() => []),
    sendNative: effects,
    resumeNativeOperation: effects,
  } as unknown as import('@frank/wallet/chain').NativeWalletHandle
  expect(inspectNativeTransferOperations(wallet, 'monad-testnet')).toEqual({
    status: 'available',
    operations: [],
  })
  expect(inspectNativeTransferOperations(wallet, 'monad-mainnet')).toEqual({
    status: 'unavailable',
  })
  expect(
    inspectNativeTransferOperations(
      { ...wallet, family: 'solana' },
      'monad-testnet',
    ),
  ).toEqual({ status: 'unsupported' })
  expect(
    inspectNativeTransferOperations(
      { ...wallet, getNativeOperations: undefined },
      'monad-testnet',
    ),
  ).toEqual({ status: 'unsupported' })
  expect(wallet.getNativeOperations).toHaveBeenCalledTimes(1)
  expect(mockGetWallet).not.toHaveBeenCalled()
  expect(mockGetRoot).not.toHaveBeenCalled()
  expect(effects).not.toHaveBeenCalled()
})

it('invalidates the captured presentation synchronously when the account changes', async () => {
  const context = await createNativeTransferContext('monad-testnet')
  const binding = await context.captureWallet()
  expect(binding.isCurrent()).toBe(true)
  mockState.revision++
  expect(binding.isCurrent()).toBe(false)
})

describe('Bitcoin-family chains', () => {
  it.each(['xec-testnet', 'btc-testnet', 'bch-testnet', 'doge-testnet'])(
    'refuses Send on %s while the registry does not offer it, without opening a wallet',
    async chainIdentifier => {
      await expect(
        createNativeTransferContext(chainIdentifier),
      ).rejects.toThrow(`Native Send is unavailable for ${chainIdentifier}`)
      expect(mockOpenUtxoWallet).not.toHaveBeenCalled()
      expect(mockGetRoot).not.toHaveBeenCalled()
    },
  )

  it('sends through the session wallet of the chain once the registry offers Send', async () => {
    const actual = jest.requireActual('@frank/wallet/chain')
    mockRegistryOverride.mockImplementation((id: string) =>
      id === 'btc-testnet'
        ? {
            ...actual.getChainRegistryEntry(id),
            wallet: { indexer: 'electrum', send: true },
          }
        : undefined,
    )
    const wallet = { chainIdentifier: 'btc-testnet', family: 'bitcoin' }
    const chain = { chainIdentifier: 'btc-testnet', family: 'bitcoin' }
    mockOpenUtxoWallet.mockResolvedValue({ chain, wallet })
    try {
      const context = await createNativeTransferContext('btc-testnet')
      expect(context.chain).toBe(chain)
      const binding = await context.captureWallet()
      expect(binding.wallet).toBe(wallet)
      expect(mockOpenUtxoWallet).toHaveBeenCalledWith('btc-testnet')
    } finally {
      mockRegistryOverride.mockImplementation(() => undefined)
    }
  })
})
