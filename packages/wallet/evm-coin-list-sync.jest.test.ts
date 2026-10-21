/** Scheduling tests: scripted provider responses exercise the real sync/list, not chain conformance. */
import { Wallet, type Provider } from 'ethers'
import { EvmCoinList } from './evm-coin-list'
import { EvmCoinListSync, type CoinListSource } from './evm-coin-list-sync'
import { EvmBlockWatcher } from './evm-block-watcher'
import { MemoryRecordStore } from './storage/evm-coin-store'

async function fixture(spacing = 0) {
  const sources: CoinListSource[] = Array.from({ length: 20 }, (_, i) => {
    const wallet = new Wallet('0x' + (i + 1).toString(16).padStart(64, '0'))
    return {
      account: wallet.address.toLowerCase(),
      origin: 'stealth',
      privateKey: () => wallet.privateKey,
    }
  })
  const provider = {
    getBlockNumber: jest.fn(async () => 100),
    getBalance: jest.fn(
      async (_address: string, _block?: number | string) => 100n,
    ),
    getTransactionCount: jest.fn(
      async (_address: string, _block?: number | string) => 0,
    ),
  }
  const list = await EvmCoinList.open(new MemoryRecordStore())
  const sync = new EvmCoinListSync({
    list,
    provider: provider as unknown as Provider,
    watcher: new EvmBlockWatcher({ provider }),
    spendSpacingBlocks: spacing,
    sources: () => sources,
  })
  return { sources, provider, list, sync }
}

const limited = {
  code: 'UNKNOWN_ERROR',
  error: { code: 429, message: 'upstream RPC error' },
}

afterEach(() => jest.restoreAllMocks())

it('stops a rate-limited inventory sweep, shares cooldown, and recovers without inventing spendable coins', async () => {
  let now = 10_000
  jest.spyOn(Date, 'now').mockImplementation(() => now)
  const f = await fixture()
  f.sync.markDirty(f.sources[0]!.account)
  f.provider.getTransactionCount.mockRejectedValue(limited)
  const first = f.sync.refresh()
  expect(f.sync.refresh({ all: true })).toBe(first)
  await expect(first).rejects.toBe(limited)
  expect(f.provider.getTransactionCount).toHaveBeenCalledTimes(12) // Six accounts, two nonce reads each.
  expect(f.list.all()).toEqual([])
  expect(f.sync.isDirty(f.sources[0]!.account)).toBe(true)
  await expect(f.sync.refresh()).rejects.toBe(limited)
  expect(f.provider.getTransactionCount).toHaveBeenCalledTimes(12)
  now += 5_000
  await expect(f.sync.refresh()).rejects.toBe(limited)
  now += 5_000 // Second refusal earns a longer cooldown.
  await expect(f.sync.refresh()).rejects.toBe(limited)
  expect(f.provider.getTransactionCount).toHaveBeenCalledTimes(24)
  now += 5_000
  f.provider.getTransactionCount.mockResolvedValue(0)
  await f.sync.refresh()
  expect(f.list.all()).toHaveLength(20)
  expect(f.sync.isDirty(f.sources[0]!.account)).toBe(false)
})

it('observes rate limits in optional spacing reads and drains sibling reads before returning', async () => {
  const f = await fixture(3)
  let release!: () => void
  const gate = new Promise<void>(resolve => {
    release = resolve
  })
  f.provider.getTransactionCount.mockImplementation(async (_account, block) => {
    if (typeof block === 'number') throw limited
    return 0
  })
  f.provider.getBalance.mockImplementation(async () => {
    await gate
    return 100n
  })
  let finished = false
  const read = f.sync.refresh().finally(() => {
    finished = true
  })
  const rejection = expect(read).rejects.toBe(limited)
  await new Promise(resolve => setTimeout(resolve, 20))
  expect(finished).toBe(false)
  expect(f.provider.getTransactionCount).toHaveBeenCalledTimes(18)
  release()
  await rejection
  expect(f.list.all()).toEqual([])
  await expect(f.sync.refresh()).rejects.toBe(limited)
  expect(f.provider.getTransactionCount).toHaveBeenCalledTimes(18)
})

it('recognizes the actual ethers error from sanitized JSON-RPC429 over HTTP without sweeping the remaining inventory', async () => {
  // This is an RPC transport fixture, not a fake relay or a claim of chain integration coverage.
  const { createServer } = await import('http')
  const { MonadJsonRpcProvider } = await import('./evm-provider')
  let nonceReads = 0
  const server = createServer((req, res) => {
    let body = ''
    req.on('data', chunk => {
      body += chunk
    })
    req.on('end', () => {
      const request = JSON.parse(body)
      const answer = (item: { id: number; method: string }) => {
        if (item.method === 'eth_getTransactionCount') {
          nonceReads++
          return {
            jsonrpc: '2.0',
            id: item.id,
            error: { code: 429, message: 'upstream RPC error' },
          }
        }
        return {
          jsonrpc: '2.0',
          id: item.id,
          result: item.method === 'eth_chainId' ? '0x279f' : '0x64',
        }
      }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(
        JSON.stringify(
          Array.isArray(request) ? request.map(answer) : answer(request),
        ),
      )
    })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as import('net').AddressInfo).port
  const provider = new MonadJsonRpcProvider(`http://127.0.0.1:${port}`, 10143n)
  try {
    const f = await fixture()
    const sync = new EvmCoinListSync({
      list: f.list,
      provider,
      watcher: new EvmBlockWatcher({ provider }),
      sources: () => f.sources,
    })
    await expect(sync.refresh()).rejects.toMatchObject({
      code: 'UNKNOWN_ERROR',
      error: { code: 429 },
    })
    expect(nonceReads).toBe(12)
    await expect(sync.refresh({ all: true })).rejects.toMatchObject({
      error: { code: 429 },
    })
    expect(nonceReads).toBe(12)
    expect(f.list.all()).toEqual([])
  } finally {
    provider.destroy()
    await new Promise<void>(resolve => server.close(() => resolve()))
  }
})
