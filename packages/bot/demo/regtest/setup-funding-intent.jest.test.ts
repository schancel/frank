import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

jest.mock('../real-stack', () => ({ openRealWallet: jest.fn() }))
jest.mock('../funds', () => ({ findWallets: jest.fn(), TRANSFER_GAS: 21000n }))
jest.mock('../../../contracts/scripts/deploy', () => ({}))

import { fundWithPublicIntent, returnToFaucet } from './monad-wallets'
import { findWallets } from '../funds'
import * as keys from './solonet-keys'
import type { RegtestStack } from './regtest-stack'

const recipient = '0x' + '11'.repeat(20)
const faucet = '0x' + '22'.repeat(20)
const hash = '0x' + '33'.repeat(32)
let root: string
let intent: string
let stack: RegtestStack
let fund: jest.Mock
let count: jest.Mock
let blocks: jest.Mock
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'public-setup-intent-'))
  const state = join(root, 'original-run')
  mkdirSync(join(state, 'wallets', 'alice'), { recursive: true })
  // Synthetic non-key bytes. The helper may stat this original file, never read/copy it.
  writeFileSync(join(state, 'wallets', 'alice', 'account-root.hex'), 'not-private-key-material')
  intent = join(root, 'funding-intent.json')
  fund = jest.fn(async () => hash)
  count = jest.fn(async () => 7)
  blocks = jest.fn(async (which: string | number) => ({ number: which === 'latest' ? 100 : which, hash }))
  stack = { stateDir: state, chains: { 'monad-regtest': {
    chainIdentifier: 'monad-regtest', rpcUrl: 'http://127.0.0.1:48090',
    checkpoint: { height: 84, hash }, faucetAddress: faucet, fund,
    provider: { send: async () => '0x4eaf', getBlock: blocks, getTransactionCount: count },
  } } } as unknown as RegtestStack
})
afterEach(() => { jest.restoreAllMocks(); rmSync(root, { recursive: true, force: true }) })
const wallet = { label: 'alice', mainAccount: recipient }
it('persists only public intent and original state identity before the single funding call', async () => {
  fund.mockImplementation(async () => {
    expect(JSON.parse(readFileSync(intent, 'utf8'))).toEqual({
      version: 1, phase: 'prepared', chainIdentifier: 'monad-regtest', nativeChainId: '20143',
      rpcUrl: 'http://127.0.0.1:48090', checkpoint: { height: 84, hash }, stateDir: stack.stateDir,
      recipient, amountWei: '5000000000000000000', faucet, faucetNonce: { latest: 7, pending: 7 },
      baselineBlock: { number: 100, hash },
    })
    return hash
  })
  await expect(fundWithPublicIntent(stack, wallet, 5n * 10n ** 18n, intent)).resolves.toBe(hash)
  expect(fund).toHaveBeenCalledTimes(1)
  expect(fund).toHaveBeenCalledWith(recipient, 5n * 10n ** 18n)
  const written = readFileSync(intent, 'utf8')
  expect(written).not.toContain('private')
  expect(written).not.toContain('not-private-key-material')
  expect(JSON.parse(written)).toMatchObject({ phase: 'confirmed', transactionHash: hash })
})
it.each(['', '{"phase":"prepared"}', '{"phase":"confirmed"}'])('never repeats a retained/partial intent (%s)', async retained => {
  writeFileSync(intent, retained)
  await expect(fundWithPublicIntent(stack, wallet, 5n, intent)).rejects.toThrow()
  expect(fund).not.toHaveBeenCalled()
  expect(readFileSync(intent, 'utf8')).toBe(retained)
})
it('keeps an ambiguous original funding intent and blocks another call', async () => {
  fund.mockRejectedValueOnce(new Error('unknown acknowledgement'))
  await expect(fundWithPublicIntent(stack, wallet, 5n, intent)).rejects.toThrow('unknown acknowledgement')
  expect(JSON.parse(readFileSync(intent, 'utf8')).phase).toBe('prepared')
  await expect(fundWithPublicIntent(stack, wallet, 5n, intent)).rejects.toThrow()
  expect(fund).toHaveBeenCalledTimes(1)
})
it('fails closed before funding when durable intent writing fails', async () => {
  jest.spyOn(keys, 'writeDurably').mockImplementation(() => { throw new Error('fixture write failure') })
  await expect(fundWithPublicIntent(stack, wallet, 5n, intent)).rejects.toThrow('fixture write failure')
  expect(fund).not.toHaveBeenCalled()
  expect(existsSync(intent)).toBe(true)
})
it('requires the original persisted key file before funding', async () => {
  rmSync(join(stack.stateDir, 'wallets', 'alice', 'account-root.hex'))
  await expect(fundWithPublicIntent(stack, wallet, 5n, intent)).rejects.toThrow()
  expect(fund).not.toHaveBeenCalled()
  expect(existsSync(intent)).toBe(false)
})
it('refuses an active faucet or changed checkpoint before creating an intent', async () => {
  count.mockImplementation(async (_address: string, tag: string) => tag === 'latest' ? 7 : 8)
  await expect(fundWithPublicIntent(stack, wallet, 5n, intent)).rejects.toThrow('baseline')
  count.mockResolvedValue(7)
  blocks.mockResolvedValue({ number: 100, hash: '0x' + '44'.repeat(32) })
  await expect(fundWithPublicIntent(stack, wallet, 5n, intent)).rejects.toThrow('checkpoint')
  expect(fund).not.toHaveBeenCalled()
  expect(existsSync(intent)).toBe(false)
})

it.each([false, true])('reports actual original-state economic residuals without hiding missing history (missing=%s)', async missing => {
  const monad = stack.chains['monad-regtest'] as any
  monad.mine = jest.fn(async () => undefined)
  monad.startBlock = 0
  monad.provider.getBlockNumber = async () => 0
  monad.provider.getBalance = async () => 1n
  monad.provider.send = async (method: string) => method === 'eth_gasPrice' ? '0x1' : missing ? null : { transactions: [] }
  ;(findWallets as jest.Mock).mockResolvedValue([{ path: stack.stateDir, kind: 'account root', accounts: [{ role: 'change', address: recipient, privateKey: 'synthetic-not-a-key' }] }])
  const result = await returnToFaucet(stack)
  expect(findWallets).toHaveBeenCalledWith(stack.stateDir)
  expect(result).toMatchObject({ returnedWei: 0n, leftWei: 1n, unswept: missing ? 1 : 0,
    left: [{ wallet: stack.stateDir, account: 'change', address: recipient, balanceWei: 1n, reason: 'below economical return fee' }] })
  expect(result.left[0]).not.toHaveProperty('privateKey')
})
