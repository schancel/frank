import { spawnSync } from 'child_process'
import { once } from 'events'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'fs'
import { tmpdir } from 'os'
import { dirname, join } from 'path'

import { startDemo, DemoHandle } from './demo'
import { resolveDemoConfig } from './demo-config'
import { runSmoke } from './smoke'
import { runSmokeChecks } from './smoke-checks'
import { Supervisor } from './supervisor'
import { startFakeRpc } from './fake-rpc'
import { ensureDemoBalance } from './demo-funding'
import { createEvmChain } from "../../wallet/chain/monad-chain";
import type { EvmChainConfig } from "../../wallet/chain/evm-chain-config";
import type { EvmChainWalletHandle } from "../../wallet/evm-wallet-handle";
import type { MonadRootBundle } from '../../wallet/chain/active-chain'
import { InMemoryNativeTransactionAttemptStore } from '../../wallet/chain/chain-wallet'
import * as providerModule from '../../wallet/monad-provider'
import * as botCommon from '../qwen-bot-common'

test('real typed wallets discover the built-in fake transport and fund/send only EVM roles', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'typed-demo-transport-'))
  const fake = await startFakeRpc({
    port: 0,
    stateFile: join(dir, 'ledger.json'),
    demoFunding: true,
  })
  const roots = (n: number): MonadRootBundle => ({
    evm: {
      registry: 'frank-domain-roots-v1',
      purpose: 'evm-wallet',
      bytes: new Uint8Array(32).fill(n),
    },
    authentication: {
      registry: 'frank-domain-roots-v1',
      purpose: 'identity-authentication',
      bytes: new Uint8Array(32).fill(n + 1),
    },
    messaging: {
      registry: 'frank-domain-roots-v1',
      purpose: 'messaging-encryption',
      bytes: new Uint8Array(32).fill(n + 2),
    },
  })
  const config = {
    networkId: 'monad-testnet',
    rpcChain: 'monad-testnet',
    chainId: 10143,
    networkTag: 'MONT',
    relayBaseUrl: fake.url,
    stampBurnAddress: '0x000000000000000000000000000000000000dEaD',
    defaultStampValueWei: 1n,
    defaultTopicVoteValueWei: 1n,
    subAccountPoolSize: 1,
    walletStorageLocation: false,
    nativeAttemptStore: new InMemoryNativeTransactionAttemptStore(),
    fakeDemo: { enabled: true, controlUrl: fake.url },
  } satisfies EvmChainConfig & {
    fakeDemo: { enabled: boolean; controlUrl: string }
  }
  const chain = createEvmChain(config)
  const wallets: EvmChainWalletHandle[] = []
  try {
    const sender = (await chain.createWallet(
      roots(11),
    )) as EvmChainWalletHandle
    wallets.push(sender)
    const recipient = (await chain.createWallet(
      roots(21),
    )) as EvmChainWalletHandle
    wallets.push(recipient)
    const from = (await sender.getReceiveAddress()).raw
    const to = (await recipient.getReceiveAddress()).raw
    expect(await sender.getBalance()).toBe(0n)
    expect(await recipient.getBalance()).toBe(0n)
    await ensureDemoBalance({ fakeChain: true, rpcUrl: fake.url }, from)
    // The wallet's primary balance cache (multi-second TTL) still holds the
    // zero read; out-of-band funding does not clear it, so clear it explicitly.
    expect(sender.invalidateBalanceCache).toEqual(expect.any(Function))
    sender.invalidateBalanceCache?.()
    // Kept conservatively for the provider-level read below; the provider's
    // own short read cache is separate from the wallet balance cache.
    await new Promise(resolve => setTimeout(resolve, 300))
    expect(await sender.getBalance()).toBe(10n ** 18n)
    expect(await sender.provider.getBalance(sender.identity.address.raw)).toBe(
      0n,
    )
    const sent = await sender.sendNative({
      recipient: { raw: to },
      value: 10n ** 17n,
    })
    expect(fake.transactions()).toEqual([
      expect.objectContaining({
        hash: sent.txHash,
        from,
        to,
        valueWei: (10n ** 17n).toString(),
      }),
    ])
    // The recipient's zero read above is still cached; the incoming transfer
    // was not initiated by this wallet, so it never cleared that cache.
    expect(recipient.invalidateBalanceCache).toEqual(expect.any(Function))
    recipient.invalidateBalanceCache?.()
    expect(await recipient.getBalance()).toBe(10n ** 17n)
    expect(
      await recipient.provider.getBalance(recipient.identity.address.raw),
    ).toBe(0n)
    await expect(
      chain.directMessages.fetchSince({ wallet: sender, sinceMs: 0 }),
    ).rejects.toThrow(
      // Still fail-closed with no legacy fallback; the app cutover (#778) reworded it.
      'Canonical direct messages require persistent typed wallet storage',
    )
    await sender.close()
    expect(sender.provider.destroyed).toBe(true)
    await expect(sender.getBalance()).rejects.toThrow('closed')
  } finally {
    await Promise.all(wallets.map(wallet => wallet.close()))
    await fake.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

jest.mock('./demo', () => ({
  startDemo: jest.fn(),
  redact: jest.requireActual('./demo').redact,
}))
jest.mock('./smoke-checks', () => ({ runSmokeChecks: jest.fn() }))
jest.mock('./demo-config', () => ({
  ...jest.requireActual('./demo-config'),
  resolveDemoConfig: jest.fn(
    jest.requireActual('./demo-config').resolveDemoConfig,
  ),
}))

const passing = [{ name: 'reply', ok: true, detail: 'received' }]

describe('smoke outcome and diagnostic retention', () => {
  let dir: string
  let logPath: string
  let unhealthy: string[]
  let handle: DemoHandle
  let output: string[]
  let supervisor: Supervisor | undefined

  beforeEach(() => {
    dir = ''
    unhealthy = []
    output = []
    supervisor = undefined
    jest.spyOn(botCommon, 'registerAndLog').mockResolvedValue()
    jest.spyOn(providerModule, 'createMonadJsonRpcProvider').mockReturnValue({
      getBalance: jest.fn().mockResolvedValue(0n),
      destroy: jest.fn(),
    } as unknown as ReturnType<typeof providerModule.createMonadJsonRpcProvider>)
    jest
      .spyOn(console, 'log')
      .mockImplementation(line => output.push(String(line)))
    jest
      .spyOn(console, 'error')
      .mockImplementation(line => output.push(String(line)))
    jest.mocked(startDemo).mockImplementation(async config => {
      dir = dirname(config.stateDir)
      logPath = join(config.stateDir, 'logs', 'qwen.log')
      mkdirSync(dirname(logPath), { recursive: true })
      writeFileSync(logPath, 'child diagnostic\n')
      handle = {
        config,
        relayUrl: config.relayUrl,
        addresses: {},
        logDir: dirname(logPath),
        done: Promise.resolve(0),
        stop: jest.fn(async () => {}),
        unhealthy: () => [...unhealthy],
      }
      return handle
    })
    jest.mocked(runSmokeChecks).mockResolvedValue(passing)
  })

  afterEach(async () => {
    await supervisor?.stopAll(100)
    if (dir) rmSync(dir, { recursive: true, force: true })
    jest.restoreAllMocks()
    jest.clearAllMocks()
  })

  function expectRetained(): void {
    expect(existsSync(dir)).toBe(true)
    expect(readFileSync(logPath, 'utf8')).toContain('child diagnostic')
    expect(output).toContain(`\nstate and logs kept in ${dir}`)
    expect(output).toContain('\nSMOKE FAILED')
    expect(output).not.toContain('\nSMOKE OK')
  }

  it('keeps an explicit compiler override in the smoke relay toolchain', async () => {
    await expect(
      runSmoke({
        PROTOC: '/tools with spaces/protoc',
        UNLISTED_TOOL: 'hidden',
      }),
    ).resolves.toBe(true)
    expect(jest.mocked(startDemo).mock.calls[0][0].toolchainEnv).toEqual({
      PROTOC: '/tools with spaces/protoc',
    })
  })

  it('checks authenticated relay RPC even when the demo uses a fake chain', async () => {
    await expect(runSmoke({})).resolves.toBe(true)
    expect(providerModule.createMonadJsonRpcProvider).toHaveBeenCalledWith(
      expect.objectContaining({
        rpcUrl: `${handle.relayUrl}/chain-rpc/monad-testnet/rpc`,
        relayAuth: expect.objectContaining({
          chain: 'monad-testnet',
          signDigest: expect.any(Function),
        }),
      }),
    )
    expect(
      output.some(line => line.startsWith('PASS  protected-relay-rpc:')),
    ).toBe(true)
  })

  it('retains diagnostics when protected relay authentication fails', async () => {
    jest.mocked(providerModule.createMonadJsonRpcProvider).mockReturnValue({
      getBalance: jest.fn().mockRejectedValue(new Error('401 rpc_auth_failed')),
      destroy: jest.fn(),
    } as unknown as ReturnType<typeof providerModule.createMonadJsonRpcProvider>)
    await expect(runSmoke({})).resolves.toBe(false)
    expectRetained()
  })

  it('fails after every feature passes if a supervised child exits unexpectedly', async () => {
    jest.mocked(runSmokeChecks).mockImplementation(async () => {
      supervisor = new Supervisor(
        {},
        () => {},
        child => unhealthy.push(child.name),
      )
      const child = supervisor.start({
        name: 'qwen',
        command: process.execPath,
        args: ['-e', 'process.exit(1)'],
        cwd: dir,
        env: {},
        logPath,
      })
      handle.stop = () => supervisor!.stopAll(100)
      await child.exited
      return passing
    })
    await expect(runSmoke({})).resolves.toBe(false)
    expectRetained()
    expect(
      output.some(line => line.includes('qwen') && line.includes('FAIL')),
    ).toBe(true)
  })

  it('detects a child becoming unhealthy after checks and before shutdown', async () => {
    jest.mocked(console.log).mockImplementation(line => {
      output.push(String(line))
      if (String(line).startsWith('PASS')) unhealthy.push('qwen')
    })
    await expect(runSmoke({})).resolves.toBe(false)
    expectRetained()
  })

  it('retains failure when a child exits before shutdown but its pipes close afterward', async () => {
    let beforeStop: unknown
    let tail: string[] = []
    jest.mocked(runSmokeChecks).mockImplementation(async () => {
      supervisor = new Supervisor(
        {},
        () => {},
        child => unhealthy.push(child.name),
      )
      const release = join(dir, 'release-descendant')
      // The descendant keeps the leader's stdout/stderr open until stopAll has begun.
      // Its watchdog bounds cleanup even if an assertion fails before releasing it.
      const descendant = `
        const fs = require('fs')
        setInterval(() => {
          if (fs.existsSync(${JSON.stringify(release)})) {
            console.log('late child diagnostic')
            process.exit(0)
          }
        }, 10)
        setTimeout(() => process.exit(0), 5000)
      `
      const child = supervisor.start({
        name: 'qwen',
        command: process.execPath,
        args: [
          '-e',
          `
          require('child_process').spawn(process.execPath, ['-e', ${JSON.stringify(
            descendant,
          )}], {
            stdio: ['ignore', 1, 2],
          })
          process.exit(7)
        `,
        ],
        cwd: dir,
        env: {},
        logPath,
      })
      let closed = false
      child.proc.once('close', () => {
        closed = true
      })
      handle.stop = async () => {
        const stopping = supervisor!.stopAll(1000)
        writeFileSync(release, '')
        await stopping
        tail = child.tail()
      }
      const [code] = await once(child.proc, 'exit')
      beforeStop = {
        code,
        exited: child.hasExited(),
        closed,
        stopping: supervisor.isStopping(),
        unhealthy: [...unhealthy],
      }
      return passing
    })
    await expect(runSmoke({})).resolves.toBe(false)
    expect(beforeStop).toEqual({
      code: 7,
      exited: true,
      closed: false,
      stopping: false,
      unhealthy: [],
    }) // Notification still waits for drained pipes.
    expect(tail).toContain('late child diagnostic')
    expect(unhealthy).toEqual(['qwen'])
    expectRetained()
  })

  it('rechecks health after teardown before deleting state', async () => {
    jest.mocked(runSmokeChecks).mockImplementation(async () => {
      handle.stop = jest.fn(async () => {
        unhealthy.push('qwen')
      })
      return passing
    })
    await expect(runSmoke({})).resolves.toBe(false)
    expectRetained()
  })

  it('cleans successful state after intentional supervised shutdown', async () => {
    jest.mocked(runSmokeChecks).mockImplementation(async () => {
      supervisor = new Supervisor(
        {},
        () => {},
        child => unhealthy.push(child.name),
      )
      supervisor.start({
        name: 'qwen',
        command: process.execPath,
        args: ['-e', 'setInterval(() => {}, 1000)'],
        cwd: dir,
        env: {},
        logPath,
      })
      handle.stop = () => supervisor!.stopAll(100)
      return passing
    })
    await expect(runSmoke({})).resolves.toBe(true)
    expect(unhealthy).toEqual([])
    expect(existsSync(dir)).toBe(false)
    expect(output).toContain('\nSMOKE OK')
  })

  it('retains diagnostics for an ordinary failed feature check', async () => {
    jest
      .mocked(runSmokeChecks)
      .mockResolvedValue([{ name: 'reply', ok: false, detail: 'missing' }])
    await expect(runSmoke({})).resolves.toBe(false)
    expectRetained()
    expect(handle.stop).toHaveBeenCalledTimes(1)
  })

  it.each(['startup', 'checks', 'shutdown'])(
    'retains diagnostics on a %s exception',
    async phase => {
      if (phase === 'startup') {
        const start = jest.mocked(startDemo).getMockImplementation()!
        jest.mocked(startDemo).mockImplementation(async (...args) => {
          await start(...args)
          throw new Error('startup failed')
        })
      } else {
        jest.mocked(runSmokeChecks).mockImplementation(async () => {
          if (phase === 'checks') throw new Error('checks failed')
          handle.stop = jest.fn(async () => {
            throw new Error('shutdown failed')
          })
          return passing
        })
      }
      await expect(runSmoke({})).resolves.toBe(false)
      expectRetained()
    },
  )

  it('reports the owned directory even when configuration fails before startup', async () => {
    jest.mocked(resolveDemoConfig).mockImplementationOnce(options => {
      dir = options!.cwd!
      throw new Error('configuration failed')
    })
    await expect(runSmoke({})).resolves.toBe(false)
    expect(existsSync(join(dir, 'dummy.env'))).toBe(true)
    expect(output).toContain(`\nstate and logs kept in ${dir}`)
    expect(startDemo).not.toHaveBeenCalled()
  })
})

describe('smoke CLI', () => {
  it.each([
    'healthy',
    'unhealthy',
    'late',
    'check-failure',
    'startup',
    'checks',
    'shutdown',
  ])(
    '%s sets the process outcome and preserves diagnostics only on failure',
    scenario => {
      const fixtureDir = mkdtempSync(join(tmpdir(), 'smoke-cli-test-'))
      const capture = join(fixtureDir, 'state-path')
      const preload = join(fixtureDir, 'preload.cjs')
      let smokeDir: string | undefined
      try {
        // Replace external stack/check dependencies, but execute the actual CLI and real FS.
        writeFileSync(
          preload,
          `
const Module = require('module')
const fs = require('fs')
const path = require('path')
const load = Module._load
const scenario = ${JSON.stringify(scenario)}
let unhealthy = []
Module._load = function(request, parent, isMain) {
  if (parent?.filename.endsWith('/demo/smoke.ts')) {
    if (request === '../qwen-bot-common') return { registerAndLog: async () => {} }
    if (request === '../../wallet/monad-provider') return { createMonadJsonRpcProvider: () => ({ getBalance: async () => 0n, destroy() {} }) }
    if (request === './demo') return { redact: text => text, startDemo: async config => {
      fs.writeFileSync(${JSON.stringify(
        capture,
      )}, path.dirname(config.stateDir))
      fs.mkdirSync(path.join(config.stateDir, 'logs'), { recursive: true })
      fs.writeFileSync(path.join(config.stateDir, 'logs/qwen.log'), 'child diagnostic')
      if (scenario === 'startup') throw new Error('startup failed')
      return { unhealthy: () => unhealthy, stop: async () => {
        if (scenario === 'late') unhealthy.push('qwen')
        if (scenario === 'shutdown') throw new Error('shutdown failed')
      } }
    } }
    if (request === './smoke-checks') return { runSmokeChecks: async () => {
      if (scenario === 'checks') throw new Error('checks failed')
      if (scenario === 'unhealthy') unhealthy.push('qwen')
      return [{ name: 'reply', ok: scenario !== 'check-failure', detail: 'fixture' }]
    } }
  }
  return load.apply(this, arguments)
}
`,
        )
        const child = spawnSync(
          process.execPath,
          [
            '--require',
            require.resolve('tsx/cjs'),
            '--require',
            preload,
            join(__dirname, 'smoke.ts'),
          ],
          {
            encoding: 'utf8',
            timeout: 15000,
            env: {
              PATH: process.env.PATH,
              TSX_TSCONFIG_PATH: join(__dirname, '..', 'tsconfig.json'),
            },
          },
        )
        smokeDir = readFileSync(capture, 'utf8')
        const healthy = scenario === 'healthy'
        expect(child.error).toBeUndefined()
        expect(child.status).toBe(healthy ? 0 : 1)
        expect(child.stdout).toContain(healthy ? 'SMOKE OK' : 'SMOKE FAILED')
        expect(existsSync(smokeDir)).toBe(!healthy)
        if (!healthy) {
          expect(child.stdout).toContain(`state and logs kept in ${smokeDir}`)
          expect(
            readFileSync(join(smokeDir, 'state/logs/qwen.log'), 'utf8'),
          ).toBe('child diagnostic')
        }
      } finally {
        if (smokeDir) rmSync(smokeDir, { recursive: true, force: true })
        rmSync(fixtureDir, { recursive: true, force: true })
      }
    },
  )
})
