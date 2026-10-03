import { spawnSync } from 'child_process'
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
