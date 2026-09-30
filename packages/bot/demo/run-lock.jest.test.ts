import { spawn } from 'child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import {
  acquireLock,
  isAlive,
  LockDeps,
  lockPath,
  LockError,
  processStartTime,
  staleAdvice,
  takeStaleRecord,
  writeRunRecord,
} from './run-lock'

describe('run lock', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'run-lock-'))
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  const writeLock = (rec: object) => writeFileSync(lockPath(dir), JSON.stringify(rec))

  it('holds the lock until released; a second launcher is refused with pid and start time', () => {
    const held = acquireLock(dir)
    expect(() => acquireLock(dir)).toThrow(LockError)
    expect(() => acquireLock(dir)).toThrow(
      /another demo launcher \(pid \d+ started .+\) is running/,
    )
    held.release()
    expect(existsSync(lockPath(dir))).toBe(false)
    acquireLock(dir).release()
  })

  it("release is idempotent and never removes somebody else's lock", () => {
    const held = acquireLock(dir)
    writeLock({ pid: 1, startTime: 'someone else' })
    held.release()
    held.release()
    expect(JSON.parse(readFileSync(lockPath(dir), 'utf8')).pid).toBe(1)
  })

  it('a lock whose launcher is dead is stale and replaced', () => {
    writeLock({ pid: 2147483000, startTime: 'Mon Jan  1 00:00:00 2001' })
    acquireLock(dir).release()
  })

  it('a REUSED launcher pid (alive, different start time) does not block startup', () => {
    expect(isAlive(process.ppid)).toBe(true)
    writeLock({ pid: process.ppid, startTime: 'Thu Jan  1 00:00:00 1970' })
    acquireLock(dir).release()
  })

  it('a live launcher with a matching start time is refused', () => {
    const start = processStartTime(process.ppid)
    expect(start).toBeTruthy()
    writeLock({ pid: process.ppid, startTime: start })
    expect(() => acquireLock(dir)).toThrow(/another demo launcher/)
  })

  it('a live pid whose start time cannot be checked is refused, with how to remove the lock', () => {
    const deps: LockDeps = { isAlive: () => true, startTime: () => undefined, youngMs: 5000 }
    writeLock({ pid: 4242, startTime: 'x' })
    expect(() => acquireLock(dir, deps)).toThrow(
      new RegExp(`delete ${lockPath(dir).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`),
    )
  })

  it('an empty or garbled lock is trusted to be mid-creation only while young', () => {
    writeFileSync(lockPath(dir), '')
    expect(() => acquireLock(dir)).toThrow(/is starting/)
    const old = new Date(Date.now() - 60_000)
    utimesSync(lockPath(dir), old, old)
    acquireLock(dir).release()
  })

  it('two launchers racing for one state dir: exactly one wins', async () => {
    const script = join(dir, 'racer.ts')
    writeFileSync(
      script,
      `import { acquireLock } from ${JSON.stringify(join(__dirname, 'run-lock'))}
try { acquireLock(${JSON.stringify(
        dir,
      )}); console.log('WON'); setTimeout(() => process.exit(0), 1500) }
catch (e) { console.log('LOST'); process.exit(0) }
`,
    )
    const runs = Array.from(
      { length: 8 },
      () =>
        new Promise<string>(resolve => {
          const c = spawn(process.execPath, ['--import', 'tsx', script], {
            stdio: ['ignore', 'pipe', 'ignore'],
            cwd: join(__dirname, '..'),
          })
          let out = ''
          c.stdout.on('data', d => (out += d))
          c.on('close', () => resolve(out.trim()))
        }),
    )
    const results = await Promise.all(runs)
    expect(results.filter(r => r === 'WON')).toHaveLength(1)
    expect(results.filter(r => r === 'LOST')).toHaveLength(7)
  }, 60000)
})

describe('run record', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'run-rec-'))
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('records launcher and children with pgid, start time and argv (0600), informationally', () => {
    writeRunRecord(dir, [{ name: 'relay', pid: process.pid, argv: ['bash', 'run-local-monad.sh'] }])
    const rec = JSON.parse(readFileSync(join(dir, 'demo.pid'), 'utf8'))
    expect(rec.launcher.pid).toBe(process.pid)
    expect(rec.children[0]).toMatchObject({
      name: 'relay',
      pid: process.pid,
      pgid: process.pid,
      argv: ['bash', 'run-local-monad.sh'],
    })
    expect(rec.children[0].startTime).toBeTruthy()
    expect(require('fs').statSync(join(dir, 'demo.pid')).mode & 0o777).toBe(0o600)
  })

  it('takeStaleRecord returns and removes it, and tolerates garbage; advice never says to kill automatically', () => {
    writeRunRecord(dir, [{ name: 'raffle', pid: 4321, argv: ['node', 'x'] }])
    const rec = takeStaleRecord(dir)!
    expect(existsSync(join(dir, 'demo.pid'))).toBe(false)
    const advice = staleAdvice(rec).join('\n')
    expect(advice).toContain('nothing was stopped automatically')
    expect(advice).toContain('ps -p 4321 -o pid,pgid,lstart,command')
    expect(advice).toContain('kill -TERM -- -4321')
    writeFileSync(join(dir, 'demo.pid'), 'garbage')
    expect(takeStaleRecord(dir)).toBeUndefined()
    expect(takeStaleRecord(dir)).toBeUndefined()
  })
})
