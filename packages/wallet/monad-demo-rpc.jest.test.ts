import { discoverFakeDemoRpc } from './monad-demo-rpc'
import { loadMonadChainConfigFromEnv } from './chain/monad-chain'
import { createServer } from 'http'
import type { AddressInfo } from 'net'

const config = {
  rpcChain: 'monad-testnet',
  networkId: 'monad-testnet',
  networkTag: 'MONT',
  chainId: 10143,
  fakeDemo: { enabled: true, controlUrl: 'http://127.0.0.1:8545' },
}
const capability = {
  kind: 'frank-simulated-ledger-v1',
  amountWei: '1000000000000000000',
  token: 'ab'.repeat(32),
}
let fetcher: jest.SpyInstance
beforeEach(() => {
  fetcher = jest.spyOn(globalThis, 'fetch')
})
afterEach(() => {
  jest.restoreAllMocks()
  jest.useRealTimers()
})

test.each([undefined, false, 'true', 1])(
  'opt-in must be literal true (%s)',
  async enabled => {
    expect(
      await discoverFakeDemoRpc({
        ...config,
        fakeDemo: { ...config.fakeDemo, enabled: enabled as boolean },
      }),
    ).toBeUndefined()
    expect(fetcher).not.toHaveBeenCalled()
  },
)
test.each([
  '',
  'https://127.0.0.1:8545',
  'http://localhost:8545',
  'http://[::1]:8545',
  'http://127.0.0.2:8545',
  'http://2130706433:8545',
  'http://127.0.0.1',
  'http://127.0.0.1:0',
  'http://127.0.0.1:65536',
  'http://127.0.0.1:08545',
  'http://127.0.0.1:8545/',
  'http://127.0.0.1:8545/rpc',
  'http://user@127.0.0.1:8545',
  'http://127.0.0.1:8545?x',
  'http://127.0.0.1:8545#x',
  'http://example.com:8545',
  ' http://127.0.0.1:8545',
  'http://127.0.0.1:8545\n',
])('rejects unapproved URL before network: %s', async controlUrl => {
  await expect(
    discoverFakeDemoRpc({ ...config, fakeDemo: { enabled: true, controlUrl } }),
  ).rejects.toThrow('loopback')
  expect(fetcher).not.toHaveBeenCalled()
})
test.each([
  { rpcChain: 'monad-mainnet' },
  { rpcChain: 'unknown' },
  { chainId: 143 },
  { networkTag: 'MON1' },
  { networkId: 'monad-mainnet' },
])('rejects contradictory configuration before network: %j', async override => {
  await expect(discoverFakeDemoRpc({ ...config, ...override })).rejects.toThrow(
    'testnet',
  )
  expect(fetcher).not.toHaveBeenCalled()
})
test.each([
  null,
  [],
  {},
  { ...capability, kind: 'real-ledger' },
  { ...capability, amountWei: '1' },
  { ...capability, token: 'ab' },
  { ...capability, token: 1 },
  { ...capability, token: 'ab'.repeat(32) + '\n' },
  { ...capability, extra: true },
])('rejects invalid discovery: %j', async body => {
  fetcher.mockResolvedValue({ ok: true, json: async () => body })
  await expect(discoverFakeDemoRpc(config)).rejects.toThrow('capability')
  expect(fetcher).toHaveBeenCalledTimes(1)
})
test('valid discovery returns only URL and clears timeout, without funding', async () => {
  jest.useFakeTimers({
    doNotFake: ['nextTick', 'queueMicrotask', 'setImmediate'],
  })
  fetcher.mockResolvedValue({ ok: true, json: async () => capability })
  expect(await discoverFakeDemoRpc(config)).toBe(config.fakeDemo.controlUrl)
  expect(fetcher).toHaveBeenCalledTimes(1)
  expect(fetcher).toHaveBeenCalledWith(
    `${config.fakeDemo.controlUrl}/_ctl/demo-funding`,
    { redirect: 'error', signal: expect.any(AbortSignal) },
  )
  expect(jest.getTimerCount()).toBe(0)
})
test.each([{ ok: false }, { ok: true, redirected: true }])(
  'fails closed on rejected/redirected discovery: %j',
  async response => {
    fetcher.mockResolvedValue(response)
    await expect(discoverFakeDemoRpc(config)).rejects.toThrow('capability')
  },
)
test('aborts a stalled discovery after five seconds and releases timeout', async () => {
  jest.useFakeTimers({
    doNotFake: ['nextTick', 'queueMicrotask', 'setImmediate'],
  })
  fetcher.mockImplementation(
    (_url, init) =>
      new Promise((_resolve, reject) => {
        init.signal.addEventListener('abort', () =>
          reject(new Error('aborted')),
        )
      }),
  )
  const pending = expect(discoverFakeDemoRpc(config)).rejects.toThrow(
    'capability',
  )
  await jest.advanceTimersByTimeAsync(5000)
  await pending
  expect(jest.getTimerCount()).toBe(0)
})

test('actual redirected discovery never contacts the target', async () => {
  const paths: string[] = []
  const server = createServer((req, res) => {
    paths.push(req.url!)
    res.writeHead(302, { location: '/unapproved-target' })
    res.end()
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const controlUrl = `http://127.0.0.1:${
    (server.address() as AddressInfo).port
  }`
  try {
    await expect(
      discoverFakeDemoRpc({
        ...config,
        fakeDemo: { enabled: true, controlUrl },
      }),
    ).rejects.toThrow()
    expect(paths).toEqual(['/_ctl/demo-funding'])
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()))
  }
})

test('discovery errors never expose capability response text', async () => {
  fetcher.mockResolvedValue({
    ok: true,
    json: async () => {
      throw new Error(capability.token)
    },
  })
  await expect(discoverFakeDemoRpc(config)).rejects.toEqual(
    new Error('Fake demo RPC capability unavailable'),
  )
})

describe('environment selection', () => {
  const saved = process.env
  beforeEach(() => {
    process.env = {}
  })
  afterEach(() => {
    process.env = saved
  })
  test.each([undefined, 'false', '1', 'TRUE'])(
    'production remains default with flag %s',
    flag => {
      if (flag !== undefined) process.env.FRANK_FAKE_DEMO = flag
      process.env.FRANK_DEMO_CONTROL_URL = config.fakeDemo.controlUrl
      expect(loadMonadChainConfigFromEnv().fakeDemo).toBeUndefined()
      expect(fetcher).not.toHaveBeenCalled()
    },
  )
  test('loads only explicit flag plus URL', () => {
    process.env.FRANK_FAKE_DEMO = 'true'
    process.env.FRANK_DEMO_CONTROL_URL = config.fakeDemo.controlUrl
    expect(loadMonadChainConfigFromEnv().fakeDemo).toEqual(config.fakeDemo)
  })
  test.each([
    { MONAD_CHAIN_ID: '143' },
    { MONAD_CHAIN_ID: 'invalid' },
    { FRANK_NETWORK_TAG: 'MON1' },
    { MONAD_RPC_CHAIN: 'monad-mainnet' },
  ])(
    'does not normalize away contradictory real config: %j',
    async override => {
      process.env = {
        FRANK_FAKE_DEMO: 'true',
        FRANK_DEMO_CONTROL_URL: config.fakeDemo.controlUrl,
        ...override,
      }
      await expect(
        discoverFakeDemoRpc(loadMonadChainConfigFromEnv()),
      ).rejects.toThrow('testnet')
      expect(fetcher).not.toHaveBeenCalled()
    },
  )
})
