import { mkdtempSync, readFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import { Supervisor } from './supervisor'

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms))

describe('Supervisor', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'supervisor-'))
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('stopAll kills the whole process group, wrappers and grandchildren included', async () => {
    const sup = new Supervisor({ PATH: process.env.PATH }, () => {})
    // sh -> sleep grandchild, like `yarn` -> `tsx` -> bot.
    const child = sup.start({
      name: 'tree',
      command: 'sh',
      args: ['-c', 'sleep 60 & echo $! && wait'],
      cwd: dir,
      env: {},
      logPath: join(dir, 'tree.log'),
    })
    let grandchild = 0
    for (let i = 0; i < 50 && !grandchild; i++) {
      await sleep(50)
      grandchild = Number(child.tail()[0]) || 0
    }
    expect(grandchild).toBeGreaterThan(0)
    expect(alive(grandchild)).toBe(true)

    await sup.stopAll(2000)

    expect(child.hasExited()).toBe(true)
    await sleep(100)
    expect(alive(grandchild)).toBe(false)
  })

  it('escalates to SIGKILL when a child ignores SIGTERM, and stopAll is idempotent', async () => {
    const sup = new Supervisor({ PATH: process.env.PATH }, () => {})
    const child = sup.start({
      name: 'stubborn',
      command: 'sh',
      args: ['-c', "trap '' TERM; echo ready; while true; do sleep 1; done"],
      cwd: dir,
      env: {},
      logPath: join(dir, 's.log'),
    })
    for (let i = 0; i < 50 && child.tail().length === 0; i++) await sleep(50)
    const started = Date.now()
    await sup.stopAll(300)
    expect(child.hasExited()).toBe(true)
    expect(Date.now() - started).toBeLessThan(5000)
    await sup.stopAll(300)
  })

  it('writes output to the log file (0600) and keeps a tail; reports unexpected exits', async () => {
    const printed: string[] = []
    const sup = new Supervisor({ PATH: process.env.PATH }, l => printed.push(l))
    const child = sup.start({
      name: 'quick',
      command: 'sh',
      args: ['-c', 'echo hello; exit 3'],
      cwd: dir,
      env: {},
      logPath: join(dir, 'q.log'),
    })
    expect(await child.exited).toBe('3')
    await sleep(20)
    expect(readFileSync(join(dir, 'q.log'), 'utf8')).toContain('hello')
    expect(child.tail()).toContain('hello')
    expect(printed.join('\n')).toMatch(/quick exited unexpectedly \(3\)/)
  })

  it('does not report the exits it caused itself', async () => {
    const printed: string[] = []
    const sup = new Supervisor({ PATH: process.env.PATH }, l => printed.push(l))
    sup.start({
      name: 'z',
      command: 'sleep',
      args: ['30'],
      cwd: dir,
      env: {},
      logPath: join(dir, 'z.log'),
    })
    await sup.stopAll(1000)
    await sleep(50)
    expect(printed).toEqual([])
  })

  it('reports a startup error observed before shutdown even if shutdown starts in the error handler', async () => {
    const unexpected = jest.fn()
    const sup = new Supervisor({}, () => {}, unexpected)
    const child = sup.start({
      name: 'missing',
      command: join(dir, 'missing-command'),
      args: [],
      cwd: dir,
      env: {},
      logPath: join(dir, 'missing.log'),
    })
    let stopping: Promise<void> | undefined
    child.proc.once('error', () => {
      stopping = sup.stopAll(100)
    })
    expect(await child.exited).toBe('error')
    await stopping
    expect(unexpected).toHaveBeenCalledTimes(1)
    expect(unexpected).toHaveBeenCalledWith(child, 'error')
  })
})
