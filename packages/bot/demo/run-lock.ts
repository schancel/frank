/**
 * Single-launcher lock and informational run record for the demo (#312).
 *
 * NOTHING here ever kills a process. A pid file is data anyone (or a crash, or pid reuse) can make
 * wrong, so it is only ever used to (a) refuse to start a second launcher and (b) tell the
 * operator what to inspect, with the exact commands, after a launcher was killed hard.
 *
 *   demo.lock  {pid, startTime}   created O_EXCL; a live launcher is recognised by pid AND start
 *                                 time, so a reused pid does not block startup
 *   demo.pid   {launcher, children[{name,pid,pgid,startTime,argv}]}   0600, informational only
 */
import { spawnSync } from 'child_process'
import { randomBytes } from 'crypto'
import {
  closeSync,
  fsyncSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from 'fs'
import { join } from 'path'

export class LockError extends Error {}

export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM' // exists, just not ours
  }
}

/** The process start time as `ps` prints it (`lstart`), or undefined if it is not running or ps
 * cannot tell. Together with the pid it identifies one process even across pid reuse. */
export function processStartTime(pid: number): string | undefined {
  const res = spawnSync('ps', ['-o', 'lstart=', '-p', String(pid)], {
    encoding: 'utf8',
    env: { PATH: process.env.PATH, LC_ALL: 'C' },
  })
  const out = (res.stdout ?? '').trim()
  return res.status === 0 && out ? out.replace(/\s+/g, ' ') : undefined
}

export interface LockDeps {
  isAlive: (pid: number) => boolean
  startTime: (pid: number) => string | undefined
  /** Age below which an unreadable lock is assumed to be mid-creation by another launcher. */
  youngMs: number
  /** After taking over a stale lock, wait this long and confirm the lock is still ours: a second
   * launcher that judged the same stale lock may rename over it within that window. */
  settleMs: number
  /** Test hooks that run at fixed points of the stale-replacement protocol. */
  hooks?: {
    afterReadStale?: () => void
    beforeRename?: () => void
    duringSettle?: () => void
  }
}
const REAL: LockDeps = { isAlive, startTime: processStartTime, youngMs: 5000, settleMs: 50 }

export const lockPath = (stateDir: string) => join(stateDir, 'demo.lock')
export const pidFilePath = (stateDir: string) => join(stateDir, 'demo.pid')

export interface HeldLock {
  /** Synchronous, idempotent (also called from the process 'exit' hook). */
  release(): void
}

function removeHint(path: string): string {
  return `if you are sure no demo is running for this state directory, delete ${path} and start again`
}

function sleepSync(ms: number): void {
  if (ms > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

function readRaw(path: string): string | undefined {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return undefined
  }
}

function parseLock(
  raw: string | undefined,
): { pid?: unknown; startTime?: unknown; token?: unknown } | undefined {
  try {
    return raw === undefined ? undefined : JSON.parse(raw)
  } catch {
    return undefined
  }
}

export function acquireLock(stateDir: string, deps: LockDeps = REAL): HeldLock {
  const path = lockPath(stateDir)
  const startTime = deps.startTime(process.pid) ?? 'unknown'
  const token = randomBytes(12).toString('hex')
  const mine = JSON.stringify({ pid: process.pid, startTime, token })
  const holds = () => parseLock(readRaw(path))?.token === token
  const held = (): HeldLock => {
    let released = false
    return {
      release() {
        if (released) return
        released = true
        try {
          if (holds()) unlinkSync(path) // never remove someone else's lock
        } catch {
          /* gone */
        }
      },
    }
  }

  for (let attempt = 0; attempt < 3; attempt++) {
    // Fresh lock: exclusive create.
    try {
      const fd = openSync(path, 'wx', 0o600)
      try {
        writeSync(fd, mine)
        fsyncSync(fd)
      } finally {
        closeSync(fd)
      }
      return held()
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
    }

    const deadRaw = readRaw(path)
    if (deadRaw === undefined) continue // vanished between the create and the read: retry
    const rec = parseLock(deadRaw)
    if (!rec || typeof rec.pid !== 'number') {
      // Empty or garbled: another launcher may be between creating and writing the file.
      let young = false
      try {
        young = Date.now() - statSync(path).mtimeMs < deps.youngMs
      } catch {
        /* vanished: retry */
      }
      if (young) {
        throw new LockError(
          `another demo launcher is starting for this state directory (${path}); try again in a moment`,
        )
      }
    } else {
      const alive = deps.isAlive(rec.pid)
      const current = alive ? deps.startTime(rec.pid) : undefined
      if (alive && (current === undefined || rec.startTime === 'unknown')) {
        // Cannot tell a live launcher from a reused pid: fail safe, never replace.
        throw new LockError(
          `${path} names pid ${
            rec.pid
          }, which is running, but its start time cannot be verified, so it may be another demo launcher; ${removeHint(
            path,
          )}`,
        )
      }
      if (alive && current === rec.startTime) {
        throw new LockError(
          `another demo launcher (pid ${rec.pid} started ${String(
            rec.startTime,
          )}) is running for this state directory; stop it first (Ctrl-C), or use another FRANK_DEMO_STATE_DIR`,
        )
      }
      // Not running, or the pid now belongs to a different process: a stale lock.
    }

    // Atomic takeover: write our lock to a temp file, re-read the lock immediately before, and
    // only if it is still byte-for-byte the stale one, rename ours over it (never unlink+create,
    // which lets a second launcher delete a lock the first one just took).
    deps.hooks?.afterReadStale?.()
    const tmp = `${path}.${process.pid}.${token}.tmp`
    writeFileSync(tmp, mine, { mode: 0o600 })
    try {
      if (readRaw(path) !== deadRaw) {
        unlinkSync(tmp)
        continue // someone else changed it: judge again from the top
      }
      deps.hooks?.beforeRename?.()
      renameSync(tmp, path)
    } catch (err) {
      try {
        unlinkSync(tmp)
      } catch {
        /* renamed or gone */
      }
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') continue
      throw err
    }
    // Confirm ownership, wait for a concurrent taker to have its say, confirm again.
    if (!holds()) continue
    deps.hooks?.duringSettle?.()
    sleepSync(deps.settleMs)
    if (holds()) return held()
    // A concurrent launcher took it over after us: it is the holder, back off.
    throw new LockError(`lost the race for ${path} to another demo launcher; try again`)
  }
  throw new LockError(
    `could not take the demo lock ${path} (another launcher won the race); ${removeHint(path)}`,
  )
}

export interface ChildRecord {
  name: string
  pid: number
  pgid: number
  startTime: string
  argv: string[]
}
export interface RunRecord {
  launcher: { pid: number; startTime: string }
  children: ChildRecord[]
}

/** Informational only (0600). */
export function writeRunRecord(
  stateDir: string,
  children: Array<{ name: string; pid: number; argv: string[] }>,
): void {
  const rec: RunRecord = {
    launcher: { pid: process.pid, startTime: processStartTime(process.pid) ?? 'unknown' },
    // Children are spawned detached, so each is its own group leader: pgid == pid.
    children: children.map(c => ({
      name: c.name,
      pid: c.pid,
      pgid: c.pid,
      startTime: processStartTime(c.pid) ?? 'unknown',
      argv: c.argv,
    })),
  }
  writeFileSync(pidFilePath(stateDir), JSON.stringify(rec), { mode: 0o600 })
}

export function removeRunRecord(stateDir: string): void {
  try {
    unlinkSync(pidFilePath(stateDir))
  } catch {
    /* never written or already gone */
  }
}

/** Reads and deletes a run record left by a launcher that did not clean up. Never acts on it. */
export function takeStaleRecord(stateDir: string): RunRecord | undefined {
  const path = pidFilePath(stateDir)
  let rec: RunRecord | undefined
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as RunRecord
    rec = Array.isArray(parsed.children) ? parsed : undefined
  } catch {
    rec = undefined
  }
  removeRunRecord(stateDir)
  return rec
}

const CONTROL = /[\u0000-\u001f\u007f-\u009f]/g
/** Text from a file we did not necessarily write: no control characters (terminal escapes), bounded. */
function clean(value: unknown, max = 120): string {
  return String(value).replace(CONTROL, '').slice(0, max)
}

function ownProcessGroup(): number | undefined {
  const res = spawnSync('ps', ['-o', 'pgid=', '-p', String(process.pid)], { encoding: 'utf8' })
  const n = Number((res.stdout ?? '').trim())
  return Number.isInteger(n) && n > 0 ? n : undefined
}

/** What to tell the operator about a stale record: what it lists and how to inspect it. Entries
 * that are not plausible child processes (non-integer or tiny ids, our own process group, our
 * parent) are skipped, so a forged record can never make us print `kill -TERM -- -1`. */
export function staleAdvice(rec: RunRecord): string[] {
  const lines = [
    'a previous demo run left a run record (it was killed hard); nothing was stopped automatically. It listed:',
  ]
  const ownGroup = ownProcessGroup()
  let skipped = 0
  for (const c of rec.children) {
    const pid = c?.pid
    const pgid = c?.pgid
    const plausible =
      Number.isInteger(pid) &&
      Number.isInteger(pgid) &&
      pid > 1 &&
      pgid > 1 &&
      pid !== process.pid &&
      pid !== process.ppid &&
      pgid !== process.ppid &&
      pgid !== ownGroup &&
      pid !== ownGroup
    if (!plausible) {
      skipped++
      continue
    }
    lines.push(
      `  ${clean(c.name, 40)}  pid ${pid}  pgid ${pgid}  started ${clean(c.startTime, 40)}  ${
        Array.isArray(c.argv) ? c.argv.map(a => clean(a, 80)).join(' ') : ''
      }`.trimEnd(),
    )
    lines.push(`    inspect:  ps -p ${pid} -o pid,pgid,lstart,command`)
    lines.push(`    only if that is really the leftover, stop it:  kill -TERM -- -${pgid}`)
  }
  if (skipped > 0)
    lines.push(
      `  (${skipped} implausible entr${skipped === 1 ? 'y' : 'ies'} in the record ignored)`,
    )
  return lines
}
