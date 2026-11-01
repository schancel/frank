import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
const mockStart = jest.fn()
const mockFund = jest.fn()
const mockOpen = jest.fn()
const mockReturn = jest.fn()
const mockReturned = jest.fn()
const mockDestroy = jest.fn()
const mockClose = jest.fn(async () => undefined)
let amount = 0n
let interceptedExit: boolean | undefined
const publicAddress = '0x' + '11'.repeat(20)
const publicHash = '0x' + '22'.repeat(32)
jest.mock('./monad-regtest', () => ({ startMonadRegtest: (...args: unknown[]) => mockStart(...args) }))
jest.mock('./monad-wallets', () => ({
  fundWithPublicIntent: (...args: unknown[]) => mockFund(...args),
  openMonadWallet: (...args: unknown[]) => mockOpen(...args),
  returnToFaucet: (...args: unknown[]) => mockReturn(...args),
}))
jest.mock('@frank/wallet/chain/payment-floor', () => ({ evmPaymentFloorWei: () => 1n }))
import { main } from './monad-exact-payment.livecheck'
const names = ['FRANK_EXACT_RELAY', 'FRANK_EXACT_DIR', 'FRANK_SOLONET_RPC_URL', 'FRANK_EXACT_FUND', 'FRANK_SOLONET_KEY_DIR'] as const
const original = Object.fromEntries(names.map(name => [name, process.env[name]]))
let root: string
let outside: string
beforeEach(() => {
  jest.clearAllMocks()
  interceptedExit = undefined
  jest.spyOn(process, 'exit').mockImplementation(code => {
    interceptedExit = Number(code ?? 0) === 0
    return undefined as never
  })
  jest.spyOn(console, 'log').mockImplementation(() => undefined)
  jest.spyOn(console, 'error').mockImplementation(() => undefined)
  root = mkdtempSync(join(tmpdir(), 'exact-preflight-'))
  outside = mkdtempSync(join(tmpdir(), 'synthetic-historical-root-'))
  mkdirSync(join(root, 'faucet-journal'))
  process.env.FRANK_EXACT_RELAY = 'http://127.0.0.1:49001'
  process.env.FRANK_SOLONET_RPC_URL = 'http://127.0.0.1:48090'
  process.env.FRANK_EXACT_DIR = root
  process.env.FRANK_SOLONET_KEY_DIR = join(root, 'faucet-journal')
  delete process.env.FRANK_EXACT_FUND
  mockStart.mockResolvedValue({ chainIdentifier: 'monad-regtest', provider: {
    send: async () => '0x1', destroy: mockDestroy,
    waitForTransaction: async () => ({ status: 1 }), getTransaction: async () => ({ value: amount }),
  } })
  mockOpen.mockImplementation(async (_stack, label) => ({
    label, address: publicAddress, mainAccount: publicAddress, close: mockClose,
    send: async (_to: string, _items: unknown, value: bigint) => { amount = value; return publicHash },
    receive: async () => ({ stampPayments: [{ txHash: publicHash }], stampValueWei: amount }),
  }))
  mockFund.mockImplementation(async (_stack, _wallet, _amount, intentPath) => {
    writeFileSync(intentPath, JSON.stringify({ phase: 'confirmed', transactionHash: publicHash }))
    return publicHash
  })
  mockReturn.mockImplementation(async stack => {
    stack.fundsReturned = mockReturned
    return { returnedWei: 5n, leftWei: 0n, unswept: 0, left: [] }
  })
})
afterEach(() => {
  jest.restoreAllMocks()
  for (const name of names) { if (original[name] === undefined) delete process.env[name]; else process.env[name] = original[name] }
  rmSync(root, { recursive: true, force: true }); rmSync(outside, { recursive: true, force: true })
})
it.each(['FRANK_EXACT_RELAY', 'FRANK_EXACT_DIR', 'FRANK_SOLONET_RPC_URL', 'FRANK_SOLONET_KEY_DIR'] as const)('missing %s causes no chain setup or funding', async name => {
  delete process.env[name]
  await expect(main()).rejects.toThrow()
  expect(mockStart).not.toHaveBeenCalled(); expect(mockFund).not.toHaveBeenCalled()
})
it.each([['FRANK_EXACT_DIR', 'relative-state'], ['FRANK_EXACT_RELAY', 'file:///synthetic'], ['FRANK_SOLONET_RPC_URL', 'invalid-endpoint'], ['FRANK_EXACT_FUND', '0'], ['FRANK_SOLONET_KEY_DIR', 'relative-keys']] as const)('invalid %s causes no chain setup or funding', async (name, value) => {
  process.env[name] = value
  await expect(main()).rejects.toThrow()
  expect(mockStart).not.toHaveBeenCalled(); expect(mockFund).not.toHaveBeenCalled()
})
it.each(['', '{"phase":"prepared"}', '{"phase":"confirmed"}'])('retained setup intent prevents startup even when its state is %s', async content => {
  writeFileSync(join(root, 'funding-intent.json'), content)
  await expect(main()).rejects.toThrow('reconcile the original run')
  expect(mockStart).not.toHaveBeenCalled(); expect(mockFund).not.toHaveBeenCalled()
})
it.each(['outside', 'same-root', 'symlink', 'nested-symlink', 'historical', 'nonfresh-run'])('refuses %s scanner roots before startup or funding', async mode => {
  if (mode === 'outside') process.env.FRANK_SOLONET_KEY_DIR = outside
  if (mode === 'same-root') process.env.FRANK_SOLONET_KEY_DIR = root
  if (mode === 'symlink') {
    rmSync(join(root, 'faucet-journal'), { recursive: true })
    symlinkSync(outside, join(root, 'faucet-journal'))
  }
  if (mode === 'nested-symlink') {
    rmSync(join(root, 'faucet-journal'), { recursive: true })
    symlinkSync(outside, join(root, 'faucet-journal'))
    process.env.FRANK_SOLONET_KEY_DIR = join(root, 'faucet-journal', 'child')
  }
  if (mode === 'historical') mkdirSync(join(root, 'faucet-journal', 'run-synthetic-old'))
  if (mode === 'nonfresh-run') mkdirSync(join(root, 'frank-exact-synthetic-previous'))
  await expect(main()).rejects.toThrow()
  expect(mockStart).not.toHaveBeenCalled(); expect(mockFund).not.toHaveBeenCalled()
})
it('passes only the validated fresh process key root to actual startup and succeeds on full return', async () => {
  mockStart.mockImplementationOnce(async () => {
    expect(process.env.FRANK_SOLONET_KEY_DIR).toBe(realpathSync(join(root, 'faucet-journal')))
    return { chainIdentifier: 'monad-regtest', provider: {
      send: async () => '0x1', destroy: mockDestroy, waitForTransaction: async () => ({ status: 1 }),
      getTransaction: async () => ({ value: amount }),
    } }
  })
  await expect(main()).resolves.toBe(true)
  expect(mockFund).toHaveBeenCalledTimes(1)
  expect(mockReturned).toHaveBeenCalledTimes(1)
  expect(mockDestroy).toHaveBeenCalledTimes(1)
})
it.each(['residual', 'unswept', 'rejected'])('actual finalization fails %s return without losing original state or provider cleanup', async mode => {
  mockReturn.mockImplementationOnce(async stack => {
    stack.fundsReturned = mockReturned
    if (mode === 'rejected') throw new Error('synthetic original return rejection')
    return { returnedWei: 0n, leftWei: mode === 'residual' ? 1n : 0n, unswept: mode === 'unswept' ? 1 : 0, left: [] }
  })
  const verdict = await main()
  // Interpret the old executable's intercepted exit status too, so fail-before exercises
  // its actual success/failure verdict rather than killing the Jest worker.
  expect(interceptedExit ?? verdict).toBe(false)
  expect(mockReturned).not.toHaveBeenCalled()
  expect(mockDestroy).toHaveBeenCalledTimes(1)
  expect(existsSync(join(root, 'funding-intent.json'))).toBe(true)
  expect(readdirSync(root).some(name => name.startsWith('frank-exact-'))).toBe(true)
})

it('does not bless unknown setup funding as returned merely because immediate return checks are empty', async () => {
  mockFund.mockImplementationOnce(async (_stack, _wallet, _value, intentPath) => {
    writeFileSync(intentPath, '{"phase":"prepared"}')
    throw new Error('synthetic unknown setup acknowledgement')
  })
  await expect(main()).resolves.toBe(false)
  expect(mockFund).toHaveBeenCalledTimes(1)
  expect(mockReturned).not.toHaveBeenCalled()
  expect(mockDestroy).toHaveBeenCalledTimes(1)
  expect(existsSync(join(root, 'funding-intent.json'))).toBe(true)
})
