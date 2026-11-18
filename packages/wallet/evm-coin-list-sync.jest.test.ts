/** Scheduling tests: scripted provider responses exercise the real sync/list, not chain conformance. */
import { Wallet, type Provider } from 'ethers'
import { EvmCoinList } from './evm-coin-list'
import {
  EvmCoinListSync,
  SEED_REWALK_MS,
  SEED_REWALK_RETRY_INITIAL_MS,
  type CoinListSource,
} from './evm-coin-list-sync'
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

it('stops scheduling when a sibling reports429 after an earlier generic rejection, while another read drains', async () => {
  const f = await fixture()
  const firstAccount = f.sources[0]!.account
  f.sync.markDirty(firstAccount)
  let release!: () => void
  const gate = new Promise<void>(resolve => {
    release = resolve
  })
  f.provider.getTransactionCount.mockImplementation(async (account, block) => {
    if (account !== firstAccount) return 0
    if (block === 'latest') throw new Error('unrelated read failure')
    await Promise.resolve()
    throw limited
  })
  f.provider.getBalance.mockImplementation(async account => {
    if (account === firstAccount) await gate
    return 100n
  })
  let finished = false
  const read = f.sync.refresh().finally(() => {
    finished = true
  })
  const rejection = expect(read).rejects.toBe(limited)
  try {
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(finished).toBe(false)
    expect(f.provider.getTransactionCount).toHaveBeenCalledTimes(12)
  } finally {
    release()
    await rejection
  }
  expect(f.sync.isDirty(firstAccount)).toBe(true)
  expect(f.list.latestOf(firstAccount)).toBeUndefined()
  await expect(f.sync.refresh()).rejects.toBe(limited)
  expect(f.provider.getTransactionCount).toHaveBeenCalledTimes(12)
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

it('clears recovered account failures after an accepted pending observation', async () => {
  const f = await fixture()
  const error = new Error('network unavailable')
  await f.sync.refresh()
  expect(() => f.sync.assertFundingObserved()).not.toThrow()
  const account = f.sources[0]!.account
  f.sync.markDirty(account)
  f.provider.getBalance.mockRejectedValueOnce(error)
  const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined)
  await f.sync.refresh()
  expect(() => f.sync.assertFundingObserved()).toThrow(error)
  // A successful observation of a pending nonce is known unavailable funding, not a failed read.
  f.provider.getTransactionCount.mockImplementation(async (_address, block) => block === 'pending' ? 1 : 0)
  await f.sync.refresh()
  expect(f.sync.isDirty(account)).toBe(true)
  expect(() => f.sync.assertFundingObserved()).not.toThrow()
  warn.mockRestore()
  await f.sync.stop()
})

it('a targeted re-read leaves the listed coin selectable while it is out, then lists what it read', async () => {
  const f = await fixture()
  f.sources.splice(1)
  const account = f.sources[0]!.account
  await f.sync.refresh()
  expect(f.list.latestOf(account)).toMatchObject({ state: 'unspent', valueWei: 100n })
  let release!: () => void
  const held = new Promise<void>(resolve => (release = resolve))
  f.provider.getBalance.mockImplementationOnce(async () => {
    await held
    return 250n
  })
  const reread = f.sync.refreshAccounts([account])
  // Asking for a look is not evidence of an outside spend: the coin is not withdrawn.
  expect(f.sync.isDirty(account)).toBe(false)
  release()
  await reread
  expect(f.list.latestOf(account)).toMatchObject({ state: 'unspent', valueWei: 250n })
  // Evidence of an outside spend still withdraws it until the next read.
  f.sync.markDirty(account)
  expect(f.sync.isDirty(account)).toBe(true)
  await f.sync.refresh()
  expect(f.sync.isDirty(account)).toBe(false)
  await f.sync.stop()
})

it.each([429, 'NETWORK_ERROR'])('keeps a failed read observable when invalidated in flight (%s)', async code => {
  const f = await fixture()
  f.sources.splice(1)
  const account = f.sources[0]!.account
  const error = Object.assign(new Error('RPC unavailable'), { code })
  const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined)
  f.provider.getBalance.mockImplementationOnce(async () => {
    f.sync.markDirty(account)
    throw error
  })
  try {
    await f.sync.refresh().catch(failure => expect(failure).toBe(error))
    expect(f.list.all()).toHaveLength(0)
    expect(f.sync.isDirty(account)).toBe(true)
    expect(() => f.sync.assertFundingObserved()).toThrow(error)
    const clock = jest.spyOn(Date, 'now').mockReturnValue(Date.now() + 61000)
    try { await f.sync.refresh() } finally { clock.mockRestore() }
    expect(f.sync.isDirty(account)).toBe(false)
    expect(() => f.sync.assertFundingObserved()).not.toThrow()
  } finally {
    warn.mockRestore()
    await f.sync.stop()
  }
})

describe('the seed walk', () => {
  async function walking(options: { walkedAtMs?: number; found?: string[]; active?: () => boolean; newSeedAt?: () => number | undefined; walk?: (scope: 'all' | 'change') => Promise<void> } = {}) {
    const f = await fixture()
    const walks: ('all' | 'change')[] = []
    const recorded: number[] = []
    let walkedAtMs = options.walkedAtMs
    const sync = new EvmCoinListSync({
      list: f.list,
      provider: f.provider as unknown as Provider,
      watcher: new EvmBlockWatcher({ provider: f.provider }),
      sources: () => f.sources,
      discover: async (_stopped, scope) => {
        walks.push(scope)
        await options.walk?.(scope)
        return scope === 'all' ? options.found ?? [] : []
      },
      lastDiscoveredAtMs: () => walkedAtMs,
      recordDiscovered: async atMs => {
        recorded.push(atMs)
        walkedAtMs = atMs
      },
      ...(options.active ? { hasActivity: options.active } : {}),
      ...(options.newSeedAt ? { newSeedWalkedAtMs: options.newSeedAt } : {}),
    })
    return { ...f, sync, walks, recorded }
  }

  it('runs once for a store never walked, shared by concurrent callers, and not on every full pass', async () => {
    let now = 50_000
    jest.spyOn(Date, 'now').mockImplementation(() => now)
    const f = await walking()
    await Promise.all([f.sync.seedDiscovered(), f.sync.seedDiscovered(), f.sync.refresh({ all: true })])
    expect(f.walks).toEqual(['all'])
    expect(f.recorded).toEqual([50_000])
    expect(f.sync.seedDiscovered()).toBeUndefined()
    // A send or quote the list does not cover reads every account again, never the seed.
    await f.sync.refresh({ all: true })
    await f.sync.refresh({ all: true })
    expect(f.walks).toEqual(['all'])
    // Once the walk is old, a full pass starts the change branch's walk in the background.
    now += SEED_REWALK_MS
    await f.sync.refresh({ all: true })
    await new Promise(resolve => setImmediate(resolve))
    expect(f.walks).toEqual(['all', 'change'])
  })

  it('re-walks the change branch every 10 minutes, and only on a chain with activity', async () => {
    expect(SEED_REWALK_MS).toBe(10 * 60_000)
    let now = 1_000_000
    jest.spyOn(Date, 'now').mockImplementation(() => now)
    let active = false
    // A seed this device generated: counted as walked at creation, no initial walk.
    const f = await walking({ walkedAtMs: now, active: () => active })
    expect(f.sync.seedDiscovered()).toBeUndefined()
    await f.sync.refresh({ all: true })
    now += 60_000
    await f.sync.refresh({ all: true })
    expect(f.walks).toEqual([])
    // Old enough, but nothing here yet: still no walk (the deposit roots are read every pass).
    now += SEED_REWALK_MS
    await f.sync.refresh({ all: true })
    await new Promise(resolve => setImmediate(resolve))
    expect(f.walks).toEqual([])
    // Once the wallet has activity on the chain, another device's change accounts are looked for.
    active = true
    await f.sync.refresh({ all: true })
    await new Promise(resolve => setImmediate(resolve))
    expect(f.walks).toEqual(['change'])
  })

  it('the user reconcile waits out a change walk already in flight, then walks both branches', async () => {
    let now = 1_000_000
    jest.spyOn(Date, 'now').mockImplementation(() => now)
    let finishChange!: () => void
    const f = await walking({
      walkedAtMs: now,
      active: () => true,
      walk: async scope => {
        if (scope === 'change') await new Promise<void>(resolve => (finishChange = resolve))
      },
    })
    const scopes = f.walks
    now += SEED_REWALK_MS
    f.sync.rediscoverIfOlderThan(SEED_REWALK_MS)
    expect(scopes).toEqual(['change'])
    let reconciled = false
    const reconcile = f.sync.walkSeed().then(() => (reconciled = true))
    await new Promise(resolve => setImmediate(resolve))
    // Not satisfied by joining the change-only walk: it waits for it to finish.
    expect(scopes).toEqual(['change'])
    expect(reconciled).toBe(false)
    finishChange()
    await reconcile
    expect(scopes).toEqual(['change', 'all'])
    expect(f.recorded).toEqual([now, now])
  })

  it('a brand-new store of a seed generated here records the walk once instead of walking', async () => {
    jest.spyOn(Date, 'now').mockImplementation(() => 2_000_000)
    let asked = 0
    const f = await walking({ newSeedAt: () => (asked++, 1_990_000) })
    await Promise.all([f.sync.seedDiscovered(), f.sync.seedDiscovered(), f.sync.refresh({ all: true })])
    expect(f.walks).toEqual([])
    // Recorded as a real walk at generation: later opens use the stored fact, not the mark.
    expect(f.recorded).toEqual([1_990_000])
    expect(asked).toBe(1)
    expect(f.sync.seedDiscovered()).toBeUndefined()
  })

  it('walks in full when the store is not brand-new or the mark is not recent', async () => {
    const f = await walking({ newSeedAt: () => undefined })
    await f.sync.refresh({ all: true })
    expect(f.walks).toEqual(['all'])
  })

  it('the user reconcile walks both branches whatever the store recorded', async () => {
    jest.spyOn(Date, 'now').mockImplementation(() => 2_000_000)
    const f = await walking({ newSeedAt: () => 1_990_000 })
    await f.sync.refresh({ all: true })
    expect(f.walks).toEqual([])
    await f.sync.walkSeed()
    expect(f.walks).toEqual(['all'])
    expect(f.recorded).toEqual([1_990_000, 2_000_000])
    const recorded = await walking({ walkedAtMs: 1_999_000 })
    await recorded.sync.walkSeed()
    expect(recorded.walks).toEqual(['all'])
  })

  it('a store the walk was recorded in is not walked before its first read', async () => {
    jest.spyOn(Date, 'now').mockImplementation(() => 60_000)
    const f = await walking({ walkedAtMs: 59_000 })
    expect(f.sync.seedDiscovered()).toBeUndefined()
    await f.sync.refresh({ all: true })
    expect(f.walks).toEqual([])
  })

  it('a failed background re-walk leaves the listed coins spendable and is retried with backoff until it succeeds', async () => {
    let now = 1_000_000
    jest.spyOn(Date, 'now').mockImplementation(() => now)
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined)
    const rateLimited = Object.assign(new Error('429 Too Many Requests'), { code: 429 })
    let failing = true
    const f = await walking({
      walkedAtMs: now - SEED_REWALK_MS,
      active: () => true,
      walk: async scope => {
        if (scope === 'change' && failing) throw rateLimited
      },
    })
    const settle = () => new Promise(resolve => setImmediate(resolve))
    // The session's first full pass: the stored walk is old, so the change branch is walked
    // again in the background, and that walk fails.
    await f.sync.refresh({ all: true })
    await settle()
    expect(f.walks).toEqual(['change'])
    expect(f.list.all()).toHaveLength(20)
    // The coins it read stand: the balance is not blocked by the walk.
    expect(() => f.sync.assertFundingObserved()).not.toThrow()
    expect(f.sync.seedRewalkFailure()).toMatchObject({
      error: rateLimited,
      retryAtMs: now + SEED_REWALK_RETRY_INITIAL_MS,
    })
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('background seed re-walk failed'), rateLimited)
    // Ordinary (not full) passes retry it, but not before the backoff.
    await f.sync.refresh()
    await settle()
    expect(f.walks).toEqual(['change'])
    now += SEED_REWALK_RETRY_INITIAL_MS
    await f.sync.refresh()
    await settle()
    expect(f.walks).toEqual(['change', 'change'])
    // Failed again: the wait doubles.
    expect(f.sync.seedRewalkFailure()?.retryAtMs).toBe(now + 2 * SEED_REWALK_RETRY_INITIAL_MS)
    now += SEED_REWALK_RETRY_INITIAL_MS
    await f.sync.refresh()
    await settle()
    expect(f.walks).toEqual(['change', 'change'])
    now += SEED_REWALK_RETRY_INITIAL_MS
    failing = false
    await f.sync.refresh()
    await settle()
    expect(f.walks).toEqual(['change', 'change', 'change'])
    expect(f.sync.seedRewalkFailure()).toBeUndefined()
    expect(f.recorded).toEqual([now])
    // Succeeded: no further walk until the ordinary period has passed.
    now += SEED_REWALK_RETRY_INITIAL_MS * 4
    await f.sync.refresh({ all: true })
    await settle()
    expect(f.walks).toHaveLength(3)
    expect(() => f.sync.assertFundingObserved()).not.toThrow()
  })

  it('while a re-walk is failing, a listed coin that could not be observed still blocks', async () => {
    let now = 1_000_000
    jest.spyOn(Date, 'now').mockImplementation(() => now)
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined)
    const f = await walking({
      walkedAtMs: now - SEED_REWALK_MS,
      active: () => true,
      walk: async () => {
        throw new Error('walk failed')
      },
    })
    await f.sync.refresh({ all: true })
    await new Promise(resolve => setImmediate(resolve))
    expect(() => f.sync.assertFundingObserved()).not.toThrow()
    const account = f.sources[0]!.account
    const unread = new Error('node unreachable')
    f.sync.markDirty(account)
    f.provider.getBalance.mockRejectedValue(unread)
    await f.sync.refresh()
    await f.sync.refresh()
    expect(() => f.sync.assertFundingObserved()).toThrow(unread)
    // The same read failure on every pass is logged once.
    expect(warn.mock.calls.filter(([text]) => String(text).includes(`could not read ${account}`))).toHaveLength(1)
    f.provider.getBalance.mockResolvedValue(100n)
    await f.sync.refresh()
    expect(() => f.sync.assertFundingObserved()).not.toThrow()
    expect(f.sync.seedRewalkFailure()).toBeDefined()
  })

  it('a store never walked whose first walk fails stays incomplete until a walk succeeds', async () => {
    jest.spyOn(console, 'warn').mockImplementation(() => undefined)
    const error = new Error('walk failed')
    let failing = true
    const f = await walking({
      walk: async () => {
        if (failing) throw error
      },
    })
    await f.sync.refresh({ all: true })
    expect(() => f.sync.assertFundingObserved()).toThrow(error)
    failing = false
    await f.sync.refresh({ all: true })
    expect(() => f.sync.assertFundingObserved()).not.toThrow()
    expect(f.walks).toEqual(['all', 'all'])
  })

  it('records the walk only once the accounts it found are coins of the list', async () => {
    // The fixture's first source: an account the walk found holding money.
    const account = new Wallet('0x' + '01'.padStart(64, '0')).address.toLowerCase()
    const f = await walking({ found: [account] })
    f.provider.getBalance.mockRejectedValueOnce(new Error('node unreachable'))
    await f.sync.seedDiscovered()
    expect(f.walks).toEqual(['all'])
    expect(f.recorded).toEqual([])
    // Not recorded: the next session walks again. This one reads the account on its next pass.
    await f.sync.refresh()
    expect(f.list.latestOf(account)).toBeDefined()
  })
})
