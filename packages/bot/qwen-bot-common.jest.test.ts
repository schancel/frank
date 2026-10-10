import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import { JsonRpcProvider, Wallet } from 'ethers'

import { MonadTxSubmitter } from '@frank/wallet/monad-account-tx'

describe('#703/#778 canonical Qwen composition on the open directory', () => {
  const NETWORK = 'monad-testnet'
  const RELAY = 'https://a.example'
  let root: string
  let server: Server
  let requests: string[]
  let logs: string[]
  let cleanup: Array<() => Promise<void>>
  let relay: FakeRelay

  function roots(index: number): MonadRootBundle {
    const outputs = domainVectors.vectors[index].outputs
    const one = <
      P extends
        | 'evm-wallet'
        | 'identity-authentication'
        | 'messaging-encryption',
    >(
      purpose: P,
    ) => ({
      registry: 'frank-domain-roots-v1' as const,
      purpose,
      bytes: getBytes(`0x${outputs[purpose]}`),
    })
    return {
      evm: one('evm-wallet'),
      authentication: one('identity-authentication'),
      messaging: one('messaging-encryption'),
    }
  }

  function chain(): EvmChainConfig {
    return {
      networkId: 'monad-testnet',
      rpcChain: 'monad-testnet',
      chainId: 10143,
      relayBaseUrl: `http://127.0.0.1:${
        (server.address() as AddressInfo).port
      }`,
      networkTag: 'MONT',
      stampBurnAddress: '0x000000000000000000000000000000000000dEaD',
      defaultStampValueWei: 32n,
      defaultTopicVoteValueWei: 1n,
      subAccountPoolSize: 2,
      walletStorageLocation: join(root, 'wallet'),
    }
  }

  /** One account: its own typed wallet and its own directory root. Nothing is published. */
  async function account(index: number, name: string) {
    const wallet = await openQwenCanonicalWallet({
      chain: {
        ...chain(),
        walletStorageLocation: join(root, `${name}-wallet`),
      },
      roots: roots(index),
    })
    const directory = openQwenDirectory({
      wallet,
      networkTag: 'MONT',
      relayBaseUrl: RELAY,
      location: join(root, `${name}-directory`),
      fetch: relay.fetch,
    })
    let closed = false
    const close = async () => {
      if (closed) return
      closed = true
      await directory.close()
      await wallet.close()
    }
    cleanup.push(close)
    return { wallet, directory, close }
  }
  type Account = Awaited<ReturnType<typeof account>>
  const openBot = () => account(0, 'bot')
  /** A second, unrelated typed account. All it ever does is publish its own entry. */
  async function openSender() {
    const sender = await account(1, 'sender')
    await sender.directory.publish()
    return sender
  }

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'qwen-canonical-setup-'))
    requests = []
    logs = []
    cleanup = []
    relay = createFakeRelay({ endpoint: RELAY })
    server = createServer((request, response) => {
      requests.push(`${request.method} ${request.url}`)
      response.statusCode = 500
      response.end()
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    for (const method of ['log', 'warn'] as const)
      jest.spyOn(console, method).mockImplementation((...args) => {
        logs.push(JSON.stringify(args))
      })
  })

  afterEach(async () => {
    jest.restoreAllMocks()
    for (const close of cleanup.reverse()) await close()
    await new Promise(resolve => server.close(resolve))
    rmSync(root, { recursive: true, force: true })
  })

  const directoryRequests = () =>
    relay.requests.map(
      request =>
        `${request.method} ${request.path.replace(/[0-9a-f]{66}/, 'P')}`,
    )

  it('publishes its own self-signed entry at startup with nothing else configured, and adopts it on restart', async () => {
    const bot = await openBot()
    // Opening contacts nobody and there is nothing to read yet.
    expect(relay.requests).toEqual([])
    await expect(bot.directory.selfCurrent()).rejects.toThrow(
      'not been published',
    )
    await publishQwenDirectoryEntry({ directory: bot.directory, label: 'test' })
    expect(directoryRequests()).toEqual([
      'GET /relay/v1/info',
      `GET /directory/v1/${NETWORK}/P/head`,
      `PUT /directory/v1/${NETWORK}/P/head`,
    ])
    // The relay holds exactly one entry: the bot's own key, signed by the bot, naming this relay.
    expect([...relay.subjects()]).toEqual([bot.wallet.subject])
    expect(relay.chain(bot.wallet.subject)).toHaveLength(1)
    expect(bot.directory.selfSubject).toBe(bot.wallet.subject)
    expect(bot.directory.network).toBe(NETWORK)
    expect(bot.directory.homeEndpoint).toBe(RELAY + '/')
    const self = await bot.directory.selfCurrent()
    expect(self.revision).toBe(0n)
    expect(toHex(self.evidence.attestation)).toBe(
      toHex(relay.chain(bot.wallet.subject)[0]),
    )
    expect(logs.join()).toContain('directory entry published')
    // A key that never published is simply not usable; that is not an error.
    expect(
      await bot.directory.peerCurrent('02' + '11'.repeat(32)),
    ).toBeUndefined()
    expect(await bot.directory.peerCurrent('not a key')).toBeUndefined()

    // Restart: the entry the relay already holds is adopted, nothing new is signed or stored.
    await bot.close()
    relay.requests.length = 0
    const again = await openBot()
    await publishQwenDirectoryEntry({
      directory: again.directory,
      label: 'test',
    })
    expect(directoryRequests()).toEqual([
      'GET /relay/v1/info',
      `GET /directory/v1/${NETWORK}/P/head`,
    ])
    expect(relay.chain(bot.wallet.subject)).toHaveLength(1)
    expect((await again.directory.selfCurrent()).evidence.hash).toEqual(
      self.evidence.hash,
    )
    // No roots, no RPC, no message route.
    for (const secret of Object.values(domainVectors.vectors[0].outputs))
      expect(logs.join()).not.toContain(secret)
    expect(requests).toEqual([])
  }, 60000)

  it('is not started while its relay is down, retries with backoff, and publishes when the relay comes back', async () => {
    const bot = await openBot()
    relay.down = true
    const delays: number[] = []
    let published = false
    const starting = publishQwenDirectoryEntry({
      directory: bot.directory,
      label: 'test',
      maxDelayMs: 3000,
      sleep: async ms => {
        delays.push(ms)
        // Still nothing published, and the bot has no entry to read mail or answer with.
        expect([...relay.subjects()]).toEqual([])
        await expect(bot.directory.selfCurrent()).rejects.toThrow(
          'not been published',
        )
        expect(published).toBe(false)
        if (delays.length === 4) relay.down = false
      },
    }).then(() => {
      published = true
    })
    await starting
    expect(delays).toEqual([1000, 2000, 3000, 3000])
    expect([...relay.subjects()]).toEqual([bot.wallet.subject])
    expect(await bot.directory.selfCurrent()).toBeDefined()
    const output = logs.join('\n')
    expect(
      output.split('the relay could not be reached (unreachable)'),
    ).toHaveLength(5)
    expect(output).toContain('retrying in 1000 ms')
    expect(output.indexOf('directory entry published')).toBeGreaterThan(
      output.lastIndexOf('not published'),
    )
    for (const secret of Object.values(domainVectors.vectors[0].outputs))
      expect(output).not.toContain(secret)

    // A failure that is not a directory failure is not retried.
    await expect(
      publishQwenDirectoryEntry({
        directory: {
          publish: async () => {
            throw new Error('custody')
          },
        },
        label: 'test',
        sleep: async () => {
          throw new Error('must not wait')
        },
      }),
    ).rejects.toThrow('custody')
    expect(requests).toEqual([])
  }, 60000)

  it('satisfies a forced peer read only with an entry the relay served just now', async () => {
    const bot = await openBot()
    await bot.directory.publish()
    const sender = await openSender()
    const subject = sender.wallet.subject
    const reads = () =>
      relay.requests.filter(request => request.path.endsWith(`${subject}/head`))
        .length
    const start = reads()
    expect(await bot.directory.peerCurrent(subject)).toBeDefined()
    expect(await bot.directory.peerCurrent(subject, true)).toBeDefined()
    expect(reads()).toBe(start + 1)
    const real = Date.now()
    const clock = jest.spyOn(Date, 'now')
    // The shared directory still reuses its recent entry: that is not a fresh read.
    clock.mockImplementation(() => real + 10_000)
    expect(await bot.directory.peerCurrent(subject)).toBeDefined()
    expect(await bot.directory.peerCurrent(subject, true)).toBeUndefined()
    expect(reads()).toBe(start + 1)
    // Once it asks the relay again, the forced read is satisfied.
    clock.mockImplementation(() => real + 31_000)
    expect(await bot.directory.peerCurrent(subject, true)).toBeDefined()
    expect(reads()).toBe(start + 2)
  }, 60000)

  it('refuses a non-Monad tag or ephemeral wallet storage before opening anything', async () => {
    await expect(
      openQwenCanonicalWallet({
        chain: { ...chain(), networkTag: 'fixture' },
        roots: roots(0),
      }),
    ).rejects.toThrow('network-not-monad')
    await expect(
      openQwenCanonicalWallet({
        chain: { ...chain(), walletStorageLocation: false },
        roots: roots(0),
      }),
    ).rejects.toThrow('wallet-storage-not-durable')
    expect(existsSync(join(root, 'wallet'))).toBe(false)
  })

  it('creates a 0600 roots file once when the path is missing, reuses it on the next start, and never echoes it', () => {
    const path = join(root, 'secrets', 'roots.json')
    const created = loadQwenCanonicalRoots(path)
    expect(statSync(path).mode & 0o777).toBe(0o600)
    const file = JSON.parse(readFileSync(path, 'utf8'))
    expect(file.registry).toBe('frank-domain-roots-v1')
    expect(Object.keys(file.roots).sort()).toEqual([
      'evm-wallet',
      'identity-authentication',
      'messaging-encryption',
    ])
    const values = Object.values(file.roots) as string[]
    for (const value of values) expect(value).toMatch(/^[0-9a-f]{64}$/)
    expect(new Set(values).size).toBe(3)
    expect(toHex(created.evm.bytes)).toBe(file.roots['evm-wallet'])
    expect(created.authentication.purpose).toBe('identity-authentication')
    // Only the fact and the path are logged.
    expect(logs).toEqual([
      JSON.stringify([`[bot] created canonical roots file at ${path}`]),
    ])
    for (const value of values) expect(logs.join()).not.toContain(value)

    // Next start: the same file, byte for byte, and nothing is logged or rewritten.
    const before = readFileSync(path, 'utf8')
    const reused = loadQwenCanonicalRoots(path)
    expect(readFileSync(path, 'utf8')).toBe(before)
    expect(logs).toHaveLength(1)
    for (const purpose of ['evm', 'authentication', 'messaging'] as const)
      expect(toHex(reused[purpose].bytes)).toBe(toHex(created[purpose].bytes))
  })

  it('refuses an existing roots file with loose permissions or bad contents and never replaces it', () => {
    const path = join(root, 'roots.json')
    const outputs = domainVectors.vectors[0].outputs
    const good = JSON.stringify({
      registry: 'frank-domain-roots-v1',
      roots: outputs,
    })
    writeFileSync(path, good, { mode: 0o600 })
    // Secret material readable by group or others is refused, with a fixed reason.
    chmodSync(path, 0o644)
    expect(() => loadQwenCanonicalRoots(path)).toThrow('roots-file-permissions')
    expect(readFileSync(path, 'utf8')).toBe(good)
    chmodSync(path, 0o600)
    const loaded = loadQwenCanonicalRoots(path)
    expect(Buffer.from(loaded.evm.bytes).toString('hex')).toBe(
      outputs['evm-wallet'],
    )
    expect(loaded.messaging.purpose).toBe('messaging-encryption')
    const bad = JSON.stringify({
      registry: 'frank-domain-roots-v1',
      roots: { ...outputs, 'evm-wallet': 'ROOT_SECRET_SENTINEL' },
    })
    writeFileSync(path, bad)
    let message = ''
    try {
      loadQwenCanonicalRoots(path)
    } catch (error) {
      message = String((error as Error).message)
    }
    expect(message).toContain('not a frank-domain-roots-v1 bundle')
    expect(message).toContain(path)
    expect(message).not.toContain('SENTINEL')
    expect(readFileSync(path, 'utf8')).toBe(bad)
    expect(logs).toEqual([])
  })
})
