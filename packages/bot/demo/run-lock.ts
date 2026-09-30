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
import {
  closeSync,
  fsyncSync,
  openSync,
  readFileSync,
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
}
const REAL: LockDeps = { isAlive, startTime: processStartTime, youngMs: 5000 }

export const lockPath = (stateDir: string) => join(stateDir, 'demo.lock')
export const pidFilePath = (stateDir: string) => join(stateDir, 'demo.pid')

export interface HeldLock {
  /** Synchronous, idempotent (also called from the process 'exit' hook). */
  release(): void
}

function removeHint(path: string): string {
  return `if you are sure no demo is running for this state directory, delete ${path} and start again`
}

export function acquireLock(stateDir: string, deps: LockDeps = REAL): HeldLock {
  const path = lockPath(stateDir)
  const me = { pid: process.pid, startTime: deps.startTime(process.pid) ?? 'unknown' }
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(path, 'wx', 0o600)
      try {
        writeSync(fd, JSON.stringify(me))
        fsyncSync(fd)
      } finally {
        closeSync(fd)
      }
      let released = false
      return {
        release() {
          if (released) return
          released = true
          try {
            const rec = JSON.parse(readFileSync(path, 'utf8')) as { pid?: number }
            if (rec.pid === me.pid) unlinkSync(path) // never remove someone else's lock
          } catch {
            /* gone or unreadable: nothing of ours to remove */
          }
        },
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
    }

    let rec: { pid?: unknown; startTime?: unknown } | undefined
    try {
      rec = JSON.parse(readFileSync(path, 'utf8'))
    } catch {
      rec = undefined
    }
    if (!rec || typeof rec.pid !== 'number') {
      // Empty or garbled: either another launcher is between creating and writing the file, or
      // it is junk. Only a young file is trusted to be the former.
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
      if (alive && current === undefined) {
        throw new LockError(
          `${path} names pid ${
            rec.pid
          }, which is running, but its start time cannot be checked, so it may be another demo launcher; ${removeHint(
            path,
          )}`,
        )
      }
      if (alive && current === rec.startTime) {
        throw new LockError(
          `another demo launcher (pid ${rec.pid} started ${rec.startTime}) is running for this state directory; stop it first (Ctrl-C), or use another FRANK_DEMO_STATE_DIR`,
        )
      }
      // Not running, or the pid now belongs to a different process: a stale lock.
    }
    try {
      unlinkSync(path)
    } catch {
      /* someone else removed it */
    }
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

/** What to tell the operator about a stale record: what it lists and how to inspect it. */
export function staleAdvice(rec: RunRecord): string[] {
  const lines = [
    'a previous demo run left a run record (it was killed hard); nothing was stopped automatically. It listed:',
  ]
  for (const c of rec.children) {
    const pid = Number.isInteger(c.pid) ? c.pid : '?'
    const pgid = Number.isInteger(c.pgid) ? c.pgid : pid
    lines.push(
      `  ${String(c.name)}  pid ${pid}  pgid ${pgid}  started ${String(c.startTime)}  ${
        Array.isArray(c.argv) ? c.argv.map(String).join(' ') : ''
      }`.trimEnd(),
    )
    lines.push(`    inspect:  ps -p ${pid} -o pid,pgid,lstart,command`)
    lines.push(`    only if that is really the leftover, stop it:  kill -TERM -- -${pgid}`)
  }
  return lines
}
