import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { createServer, connect } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import {
  checkNode,
  disposeBundle,
  initBundle,
  reopenBundle,
  startFixture,
  type TrustBundle,
} from './index'

const now = 1000000000000000001n
const p = '0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798'
let root: string
let bundle: TrustBundle
const children = new Set<ChildProcess>()
const stops: Array<() => Promise<void>> = []
async function freePort() {
  const server = createServer()
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as { port: number }).port
  await new Promise<void>(resolve => server.close(() => resolve()))
  return port
}
beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'directory-trust-life-tests-'))
  bundle = initBundle({
    mode: 'synthetic-demo',
    runDir: join(root, 'directory-trust-run'),
    nowNs: now,
    trustInputs: {
      network: 'monad-testnet',
      subject: p,
      rev0T1:
        '21729c888b5da6caeaf90dde5eb2c37e9c2da392e609908d75afba75b72f3a3e',
      relayId: '00'.repeat(16),
      relayIdentity: { keyType: 1, point: p },
      endpoint: `https://127.0.0.1:${await freePort()}`,
      bindingExpiryNs: now + 1000n,
    },
  })
})
afterEach(async () => {
  for (const child of children)
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL')
      await new Promise<void>(resolve => child.once('close', () => resolve()))
    }
  children.clear()
  for (const stop of stops.splice(0)) await stop()
  rmSync(root, { recursive: true, force: true })
})
test('real stop/reopen preserves exact bytes and endpoint; idle owned sockets close; stop is idempotent', async () => {
  const bytes = readFileSync(join(bundle.runDir, 'manifest.json'))
  const fixture = await startFixture(bundle, now)
  stops.push(fixture.stop)
  const socket = connect(
    Number(new URL(bundle.trustInputs.endpoint).port),
    '127.0.0.1',
  )
  await new Promise<void>(resolve => socket.once('connect', resolve))
  const closed = new Promise<void>(resolve =>
    socket.once('close', () => resolve()),
  )
  await expect(checkNode(bundle, now)).resolves.toMatchObject({
    kind: 'synthetic-node-transport-proof',
  })
  expect(() => disposeBundle(bundle, now)).toThrow('Stop the owned listener')
  await fixture.stop()
  await fixture.stop()
  await closed
  expect(readFileSync(join(bundle.runDir, 'manifest.json'))).toEqual(bytes)
  expect(reopenBundle(bundle, now)).toEqual(bundle)
  const again = await startFixture(bundle, now)
  stops.push(again.stop)
  await expect(checkNode(bundle, now)).resolves.toMatchObject({
    kind: 'synthetic-node-transport-proof',
  })
  await again.stop()
  disposeBundle(bundle, now)
})
test('port conflict fails without altering endpoint, trust or unrelated listener', async () => {
  const unrelated = createServer(socket => socket.end('sentinel'))
  await new Promise<void>(resolve =>
    unrelated.listen(
      Number(new URL(bundle.trustInputs.endpoint).port),
      '127.0.0.1',
      resolve,
    ),
  )
  stops.push(
    () => new Promise<void>(resolve => unrelated.close(() => resolve())),
  )
  await expect(startFixture(bundle, now)).rejects.toMatchObject({
    code: 'EADDRINUSE',
  })
  expect(unrelated.listening).toBe(true)
  expect(existsSync(join(bundle.runDir, '.listener'))).toBe(false)
  expect(reopenBundle(bundle, now)).toEqual(bundle)
})
test('exclusive operation and listener leases prevent concurrent ownership', async () => {
  writeFileSync(join(bundle.runDir, '.operation'), '', { mode: 0o600 })
  expect(() => reopenBundle(bundle, now)).toThrow()
  rmSync(join(bundle.runDir, '.operation'))
  stops.push((await startFixture(bundle, now)).stop)
  await expect(startFixture(bundle, now)).rejects.toMatchObject({
    code: 'EEXIST',
  })
  await expect(checkNode(bundle, now)).resolves.toBeDefined()
})
test('dispose preserves neighbors and refuses symlinks, normal state, unrelated files and broad roots', () => {
  const sentinel = join(root, 'sentinel')
  writeFileSync(sentinel, 'keep')
  const link = join(root, 'directory-trust-link')
  symlinkSync(bundle.runDir, link)
  expect(() => disposeBundle({ ...bundle, runDir: link }, now)).toThrow(
    'Unsafe',
  )
  expect(lstatSync(link).isSymbolicLink()).toBe(true)
  for (const runDir of ['/', root, '/Users/shammah', join(root, '.frank-demo')])
    expect(() => disposeBundle({ ...bundle, runDir }, now)).toThrow()
  writeFileSync(join(bundle.runDir, 'unrelated'), 'keep')
  expect(() => disposeBundle(bundle, now)).toThrow('Unrelated')
  rmSync(join(bundle.runDir, 'unrelated'))
  disposeBundle(bundle, now)
  expect(readFileSync(sentinel, 'utf8')).toBe('keep')
  expect(existsSync(bundle.runDir)).toBe(false)
})
test('missing bundle and interrupted clock update cannot auto-bootstrap', () => {
  expect(() =>
    reopenBundle(
      { ...bundle, runDir: join(root, 'directory-trust-missing') },
      now,
    ),
  ).toThrow()
  writeFileSync(join(bundle.runDir, 'clock.next'), 'partial', { mode: 0o600 })
  expect(() => reopenBundle(bundle, now)).toThrow('incomplete')
})
test('a TLS file symlink cannot escape disposal into neighboring state', () => {
  const sentinel = join(root, 'neighbor-key')
  writeFileSync(sentinel, 'unrelated state', { mode: 0o600 })
  rmSync(join(bundle.runDir, 'leaf.key'))
  symlinkSync(sentinel, join(bundle.runDir, 'leaf.key'))
  expect(() => disposeBundle(bundle, now)).toThrow('Unsafe fixture file')
  expect(readFileSync(sentinel, 'utf8')).toBe('unrelated state')
  expect(existsSync(join(bundle.runDir, 'manifest.json'))).toBe(true)
})
const cli = resolve(__dirname, 'cli.ts')
const cwd = resolve(__dirname, '../../../..')
function cliInput(command: string, extra: Record<string, unknown> = {}) {
  const file = join(root, `input-${command}.json`)
  writeFileSync(
    file,
    JSON.stringify({
      runDir: bundle.runDir,
      manifestIdentity: bundle.manifestIdentity,
      nowNs: now.toString(),
      ...extra,
    }),
    { mode: 0o600 },
  )
  return file
}
test.each(['serve', 'dispose'] as const)(
  'cross-process %s ownership excludes the competing operation before artifacts change',
  async owner => {
    const release = join(root, 'release-operation')
    const artifacts = Object.fromEntries(
      readdirSync(bundle.runDir).map(name => [
        name,
        readFileSync(join(bundle.runDir, name)),
      ]),
    )
    // Pause the real CLI at the filesystem boundary, without adding production
    // hooks. Both contenders are separate processes using the public facade.
    const barrier = `
      const fs = require('node:fs');
      const listener = ${JSON.stringify(join(bundle.runDir, '.listener'))};
      const release = ${JSON.stringify(release)};
      const exists = fs.existsSync;
      function pause() {
        fs.writeSync(1, 'ownership-barrier\\n');
        const wait = new Int32Array(new SharedArrayBuffer(4));
        for (let n = 0; n < 500 && !exists(release); n++) Atomics.wait(wait, 0, 0, 20);
        if (!exists(release)) throw Error('Test ownership barrier timed out');
      }
      if (${JSON.stringify(owner)} === 'serve') {
        const open = fs.openSync;
        fs.openSync = function(path, ...args) {
          if (path === listener && args[0] === 'wx') pause();
          return open.call(fs, path, ...args);
        };
      } else {
        fs.existsSync = function(path) {
          if (path === listener) pause();
          return exists(path);
        };
      }
      require(${JSON.stringify(cli)});
    `
    const env = {
      ...process.env,
      TSX_TSCONFIG_PATH: join(cwd, 'packages/bot/tsconfig.json'),
    }
    const child = spawn(
      process.execPath,
      ['--import', 'tsx', '-e', barrier, cli, owner, cliInput(owner)],
      { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] },
    )
    children.add(child)
    const exited = new Promise<number | null>(resolve =>
      child.once('close', resolve),
    )
    let output = ''
    child.stdout!.on('data', chunk => {
      output += String(chunk)
    })
    const waitFor = (marker: string) =>
      new Promise<void>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error(`CLI did not reach ${marker}`)),
          5000,
        )
        const check = () => {
          if (output.includes(marker)) {
            clearTimeout(timer)
            child.stdout!.off('data', check)
            resolve()
          }
        }
        child.stdout!.on('data', check)
        check()
        child.once('close', () => {
          clearTimeout(timer)
          if (!output.includes(marker))
            reject(new Error(`CLI exited before ${marker}`))
        })
      })
    try {
      await waitFor('ownership-barrier')
      const competitor = owner === 'serve' ? 'dispose' : 'serve'
      const result = spawnSync(
        process.execPath,
        ['--import', 'tsx', cli, competitor, cliInput(competitor)],
        { cwd, env, encoding: 'utf8', timeout: 5000 },
      )
      expect(result.status).toBe(1)
      expect(result.stderr).toContain('EEXIST')
      for (const [name, bytes] of Object.entries(artifacts))
        expect(readFileSync(join(bundle.runDir, name))).toEqual(bytes)
      writeFileSync(release, '', { mode: 0o600 })
      if (owner === 'serve') {
        await waitFor('synthetic-fixture-listening')
        await expect(checkNode(bundle, now)).resolves.toBeDefined()
        child.kill('SIGTERM')
        expect(await exited).toBe(130)
        expect(reopenBundle(bundle, now)).toEqual(bundle)
      } else {
        expect(await exited).toBe(0)
        expect(existsSync(bundle.runDir)).toBe(false)
        await expect(startFixture(bundle, now)).rejects.toThrow()
      }
    } finally {
      writeFileSync(release, '', { mode: 0o600 })
    }
  },
  15000,
)
test.each(['SIGINT', 'SIGTERM'] as const)(
  'CLI handles %s and reaps only its owned listener, leaving trust and unrelated process',
  async signal => {
    const unrelated = spawn(
      process.execPath,
      ['-e', 'setInterval(()=>{},1000)'],
      { stdio: 'ignore' },
    )
    children.add(unrelated)
    const child = spawn(
      process.execPath,
      ['--import', 'tsx', cli, 'serve', cliInput('serve')],
      {
        cwd,
        env: {
          ...process.env,
          TSX_TSCONFIG_PATH: join(cwd, 'packages/bot/tsconfig.json'),
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    )
    children.add(child)
    const exited = new Promise<number | null>(resolve =>
      child.once('close', resolve),
    )
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error('CLI did not become ready')),
        5000,
      )
      child.once('error', reject)
      child.stdout!.on('data', chunk => {
        if (String(chunk).includes('synthetic-fixture-listening')) {
          clearTimeout(timer)
          resolve()
        }
      })
      child.stderr!.on('data', chunk => {
        clearTimeout(timer)
        reject(new Error(String(chunk)))
      })
    })
    await expect(checkNode(bundle, now)).resolves.toBeDefined()
    child.kill(signal)
    expect(await exited).toBe(130)
    expect(unrelated.exitCode).toBeNull()
    process.kill(unrelated.pid!, 0)
    expect(existsSync(join(bundle.runDir, '.listener'))).toBe(false)
    expect(reopenBundle(bundle, now)).toEqual(bundle)
    const restarted = await startFixture(bundle, now)
    stops.push(restarted.stop)
  },
  15000,
)
test('partial OpenSSL startup fails cleanly with no ready state or leaked run directory', () => {
  const bin = join(root, 'bin')
  mkdirSync(bin)
  writeFileSync(
    join(bin, 'openssl'),
    '#!/bin/sh\nif [ "$1" = version ]; then echo test; exit 0; fi\nexit 1\n',
    { mode: 0o700 },
  )
  const runDir = join(root, 'directory-trust-failed')
  const input = cliInput('init', {
    mode: 'synthetic-demo',
    runDir,
    trustInputs: {
      ...bundle.trustInputs,
      bindingExpiryNs: bundle.trustInputs.bindingExpiryNs.toString(),
    },
  })
  const result = spawnSync(
    process.execPath,
    ['--import', 'tsx', cli, 'init', input],
    {
      cwd,
      env: {
        ...process.env,
        PATH: bin,
        TSX_TSCONFIG_PATH: join(cwd, 'packages/bot/tsconfig.json'),
      },
      encoding: 'utf8',
      timeout: 10000,
    },
  )
  expect(result.status).toBe(1)
  expect(result.stdout).toBe('')
  expect(result.stderr).toContain('OpenSSL failed')
  expect(existsSync(runDir)).toBe(false)
  expect(readdirSync(bundle.runDir).sort()).toEqual([
    'ca.key',
    'ca.pem',
    'clock',
    'leaf.key',
    'leaf.pem',
    'manifest.json',
  ])
  rmSync(join(bin, 'openssl'))
  const missing = spawnSync(
    process.execPath,
    ['--import', 'tsx', cli, 'init', input],
    {
      cwd,
      env: {
        ...process.env,
        PATH: bin,
        TSX_TSCONFIG_PATH: join(cwd, 'packages/bot/tsconfig.json'),
      },
      encoding: 'utf8',
      timeout: 10000,
    },
  )
  expect(missing.status).toBe(1)
  expect(missing.stderr).toContain('OpenSSL failed')
  expect(existsSync(runDir)).toBe(false)
})
