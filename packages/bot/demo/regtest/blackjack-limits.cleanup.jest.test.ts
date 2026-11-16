/** Public owner boundaries only: no wallet, key files, stores, node or relay is opened. */
import { Transaction } from 'ethers'
import type { RealWallet } from '../real-stack'
import type { RegtestStack } from './regtest-stack'
import type { EvmChainConfig } from '@frank/wallet/chain/evm-chain-config'
import type { EvmNativeOperation } from '@frank/wallet/storage/evm-native-operation-journal'

const mockStat = jest.fn()
const mockAdmit = jest.fn()
const mockCreateWallet = jest.fn()
const mockDirectoryClose = jest.fn()
const mockUninstall = jest.fn()
jest.mock('fs', () => ({ ...jest.requireActual('fs'), lstatSync: (...args: unknown[]) => mockStat(...args) }))
jest.mock('../real-stack', () => ({ openRealWallet: jest.fn() }))
jest.mock('../../../contracts/scripts/deploy', () => ({ deployContracts: jest.fn() }))
jest.mock('@frank/bot-framework', () => ({
  admitBotProfile: (...args: unknown[]) => mockAdmit(...args),
  DirectoryManager: { create: () => ({ rawDirectory: {}, close: () => mockDirectoryClose() }) },
}))
jest.mock('@frank/wallet/chain/evm-chain', () => ({ installCanonicalDirectory: () => mockUninstall }))
jest.mock('@frank/wallet/chain/evm-host', () => ({
  createRelayPricedEvmChain: () => ({ chainIdentifier: 'monad-regtest',
    createWallet: (...args: unknown[]) => mockCreateWallet(...args),
    directMessages: { reconcileAttempts: async () => ({}) },
  }),
}))

import { blackjackReturnOperationId, returnBlackjackAvailableFunds } from './monad-wallets'

const faucet = '0x' + '44'.repeat(20)
const address = (part: string) => '0x' + part.repeat(20)
function wallet(label: string, identity: string, main: string) {
  return {
    label, address: identity, mainAccount: main,
    handle: {
      chainIdentifier: 'monad-regtest', identity: { address: { raw: identity } },
      getReceiveAddress: jest.fn(async () => ({ raw: main })),
      getNativeOperations: jest.fn< EvmNativeOperation[], []>(() => []),
      getNativeOperationHistory: jest.fn(async (_input: unknown): Promise<{ operations: EvmNativeOperation[]; next?: string }> => ({ operations: [] })),
      readNativeOperation: jest.fn(async (_id: string): Promise<EvmNativeOperation | undefined> => undefined),
      resumeLegacySend: jest.fn(async (_id: string) => ({ txHash: 'original', totalValueSent: 20n, totalFeePaid: 2n })),
      estimateLegacyMax: jest.fn(async (_input: unknown) => ({ value: 20n, totalFee: 2n })),
      sendLegacy: jest.fn(async (_input: unknown) => ({ txHash: 'new-return', totalValueSent: 20n, totalFeePaid: 2n })),
      getBalance: jest.fn(async () => 3n), close: jest.fn(async () => undefined),
    },
    chain: { chainIdentifier: 'monad-regtest', directMessages: { reconcileAttempts: jest.fn(async () => ({})) } },
  }
}
function fixture() {
  const player = wallet('player', address('11'), address('12'))
  const dealer = wallet('dealer', address('22'), address('23'))
  const operations = { owner: { chainIdentifier: 'monad-regtest', botId: 'blackjack', address: dealer.address },
    listStarted: jest.fn(() => [] as unknown[]), listDeferred: jest.fn(() => [] as unknown[]), close: jest.fn(async () => undefined) }
  const state = { close: jest.fn(async () => undefined) }
  mockStat.mockReturnValue({ isDirectory: () => true, isFile: () => true, size: 64 })
  mockAdmit.mockResolvedValue({ operations, state, roots: { synthetic: true } })
  mockCreateWallet.mockResolvedValue(dealer.handle)
  mockDirectoryClose.mockResolvedValue(undefined)
  const onReturned = jest.fn()
  const params = { stack: { stateDir: '/synthetic-run', relayUrl: 'http://inert',
    chains: { 'monad-regtest': { faucetAddress: faucet } } } as unknown as RegtestStack,
  player: player as unknown as RealWallet,
  dealer: { address: dealer.address, mainAccount: dealer.mainAccount,
    config: { rpcChain: 'monad-regtest', networkId: 'monad-regtest', networkTag: 'MONR', chainId: 20143,
      relayBaseUrl: 'http://inert', walletStorageLocation: '/synthetic-run/bot-host/chain-storage' } as EvmChainConfig }, onReturned }
  return { params, player, dealer, operations, state, onReturned }
}
function original(owner: ReturnType<typeof wallet>, id = 'native:1'): EvmNativeOperation {
  return { version: 1, operationId: id, preparationId: 'evm-transaction-set:' + blackjackReturnOperationId(owner, faucet),
    kind: 'transaction-set', binding: { chainIdentifier: 'monad-regtest', nativeChainId: '20143', publicTuple: JSON.stringify({ mainAddress: owner.mainAccount }) },
    recipient: faucet, intendedValueWei: '20', maximumFeeWei: '2', cancelled: false, reservedBytes: 100,
    members: [{ source: { kind: 'main', address: owner.mainAccount }, dependencies: [],
      unsignedTransaction: Transaction.from({ type: 0, chainId: 20143, to: faucet, value: 20n, gasLimit: 21000n, gasPrice: 1n }).unsignedSerialized,
      signed: { rawTransaction: '0x', transactionHash: 'original' }, exposed: true,
      observation: { state: 'pending' }, account: null, syncApplied: false,
      transactionSet: { role: 'payment', logicalIndex: 0, balanceBeforeWei: '22', balanceAfterWei: '0' } }] }
}
beforeEach(() => { jest.resetAllMocks(); jest.spyOn(console, 'log').mockImplementation(() => undefined) })
afterEach(() => jest.restoreAllMocks())

it('validates both owners before one public Max/send each, with stable path-independent identities and honest residuals', async () => {
  const { params, player, dealer, onReturned } = fixture()
  await returnBlackjackAvailableFunds(params)
  for (const owner of [player, dealer]) {
    expect(owner.handle.sendLegacy).toHaveBeenCalledWith({ operationId: blackjackReturnOperationId(owner, faucet),
      recipient: { raw: faucet }, value: 20n, maxFee: 2n })
    expect(owner.handle.sendLegacy).toHaveBeenCalledTimes(1)
  }
  expect(player.handle.estimateLegacyMax.mock.invocationCallOrder[0]).toBeGreaterThan(dealer.handle.getNativeOperationHistory.mock.invocationCallOrder[0]!)
  expect(mockAdmit).toHaveBeenCalledWith({ stateDir: '/synthetic-run/bot-host', botId: 'blackjack',
    identityPath: '/synthetic-run/bot-host/blackjack.json', network: 'monad-regtest' })
  expect(onReturned).toHaveBeenCalledTimes(2)
  expect(console.log).toHaveBeenCalledWith(expect.stringContaining('3 wei remain'))
  const renamed = { ...player, label: '/renamed-copy' }
  expect(blackjackReturnOperationId(renamed, faucet)).toBe(blackjackReturnOperationId(player, faucet))
})

it('finds an archived original through all history pages, reads its native ID and resumes without quoting or sending again', async () => {
  const { params, player } = fixture()
  const row = original(player)
  player.handle.getNativeOperationHistory.mockResolvedValueOnce({ operations: [], next: 'page-two' }).mockResolvedValueOnce({ operations: [row] })
  player.handle.readNativeOperation.mockResolvedValue(row)
  await returnBlackjackAvailableFunds(params)
  expect(player.handle.readNativeOperation).toHaveBeenCalledWith('native:1')
  expect(player.handle.resumeLegacySend).toHaveBeenCalledWith('native:1')
  expect(player.handle.estimateLegacyMax).not.toHaveBeenCalled()
  expect(player.handle.sendLegacy).not.toHaveBeenCalled()
})

it.each(['cursor', 'page-cap', 'duplicate', 'read', 'destination', 'payment', 'owner', 'chain', 'cancelled', 'pending'] as const)('holds %s original evidence without a new quote or send', async problem => {
  const { params, player, dealer, state } = fixture()
  const row = original(player)
  player.handle.getNativeOperationHistory.mockResolvedValue({ operations: [row] })
  player.handle.readNativeOperation.mockResolvedValue(row)
  if (problem === 'cursor') player.handle.getNativeOperationHistory.mockResolvedValue({ operations: [], next: 'same' })
  if (problem === 'page-cap') {
    let page = 0
    player.handle.getNativeOperationHistory.mockImplementation(async () => ({ operations: [], next: `page-${page++}` }))
  }
  if (problem === 'duplicate') player.handle.getNativeOperationHistory.mockResolvedValue({ operations: [row, original(player, 'native:2')] })
  if (problem === 'read') player.handle.readNativeOperation.mockRejectedValue(new Error('unavailable'))
  if (problem === 'destination') row.recipient = address('55')
  if (problem === 'payment') row.members[0]!.unsignedTransaction = Transaction.from({ type: 0, chainId: 20143,
    to: address('55'), value: 20n, gasLimit: 21000n, gasPrice: 1n }).unsignedSerialized
  if (problem === 'owner') row.binding = { ...row.binding, publicTuple: JSON.stringify({ mainAddress: address('55') }) }
  if (problem === 'chain') row.binding = { ...row.binding, chainIdentifier: 'monad-testnet' }
  if (problem === 'cancelled') row.cancelled = true
  if (problem === 'pending') player.handle.resumeLegacySend.mockRejectedValue(new Error('original outcome uncertain'))
  await expect(returnBlackjackAvailableFunds(params)).rejects.toThrow('HOLD')
  for (const owner of [player, dealer]) {
    expect(owner.handle.estimateLegacyMax).not.toHaveBeenCalled()
    expect(owner.handle.sendLegacy).not.toHaveBeenCalled()
  }
  expect(dealer.handle.close).toHaveBeenCalledTimes(1)
  expect(state.close).toHaveBeenCalledTimes(1)
})

it('checks dealer held game obligations before returning player value', async () => {
  const { params, player, dealer } = fixture()
  const held = original(dealer)
  held.preparationId = 'other-original'
  held.members[0]!.signed = null
  dealer.handle.getNativeOperations.mockReturnValue([held])
  await expect(returnBlackjackAvailableFunds(params)).rejects.toThrow('HOLD')
  expect(player.handle.sendLegacy).not.toHaveBeenCalled()
  expect(player.handle.estimateLegacyMax).not.toHaveBeenCalled()
})

it('retains a confirmed first return report when the second return remains pending, and attempts every close', async () => {
  const { params, player, dealer, operations, state, onReturned } = fixture()
  const row = original(dealer)
  dealer.handle.getNativeOperationHistory.mockResolvedValue({ operations: [row] })
  dealer.handle.readNativeOperation.mockResolvedValue(row)
  dealer.handle.resumeLegacySend.mockRejectedValue(new Error('pending owned change'))
  mockUninstall.mockImplementation(() => { throw new Error('uninstall failed') })
  mockDirectoryClose.mockRejectedValue(new Error('directory close failed'))
  await expect(returnBlackjackAvailableFunds(params)).rejects.toThrow('HOLD')
  expect(onReturned).toHaveBeenCalledTimes(1)
  expect(onReturned).toHaveBeenCalledWith(expect.objectContaining({ label: player.label, returnedWei: 20n }))
  for (const close of [operations.close, state.close, dealer.handle.close, mockDirectoryClose, mockUninstall])
    expect(close).toHaveBeenCalledTimes(1)
  expect(dealer.handle.sendLegacy).not.toHaveBeenCalled()
})

it('refuses absent original metadata without admitting or creating a wallet', async () => {
  const { params, player } = fixture()
  mockStat.mockImplementation(() => { throw new Error('original directory absent') })
  await expect(returnBlackjackAvailableFunds(params)).rejects.toThrow('absent')
  expect(mockAdmit).not.toHaveBeenCalled()
  expect(mockCreateWallet).not.toHaveBeenCalled()
  expect(player.handle.sendLegacy).not.toHaveBeenCalled()
})

it.each(['profile-owner', 'wallet-owner', 'chain', 'messages'] as const)('holds mismatched or unfinished %s before either owner can return', async problem => {
  const { params, player, dealer, operations, state } = fixture()
  if (problem === 'profile-owner') operations.owner.address = address('55')
  if (problem === 'wallet-owner') dealer.handle.getReceiveAddress.mockResolvedValue({ raw: address('55') })
  if (problem === 'chain') params.dealer.config.rpcChain = 'monad-testnet'
  if (problem === 'messages') operations.listStarted.mockReturnValue([{ synthetic: 'held original' }])
  await expect(returnBlackjackAvailableFunds(params)).rejects.toThrow()
  for (const owner of [player, dealer]) {
    expect(owner.handle.estimateLegacyMax).not.toHaveBeenCalled()
    expect(owner.handle.sendLegacy).not.toHaveBeenCalled()
  }
  if (problem !== 'chain') expect(state.close).toHaveBeenCalledTimes(1)
})

it('reports confirmed value before a failed residual read and constructs no replacement', async () => {
  const { params, player, dealer, onReturned } = fixture()
  player.handle.getBalance.mockRejectedValue(new Error('balance observation unavailable'))
  await expect(returnBlackjackAvailableFunds(params)).rejects.toThrow('HOLD')
  expect(onReturned).toHaveBeenCalledWith(expect.objectContaining({ label: player.label, returnedWei: 20n }))
  expect(player.handle.sendLegacy).toHaveBeenCalledTimes(1)
  expect(dealer.handle.sendLegacy).not.toHaveBeenCalled()
})
