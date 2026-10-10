/**
 * Child-process supervision for the demo launcher (#312): every child gets its own process group
 * (so `yarn`/`tsx`/`bash` wrappers and the daemons under them all die together), a log file, and
 * a bounded in-memory tail for error messages. Nothing else is inherited from the launcher's
 * environment except a short allowlist, so a `.env` value or unrelated secret never reaches a
 * child unless it is one of the demo's named variables.
 */
import { ChildProcess, spawn } from 'child_process'
import { createWriteStream, mkdirSync, WriteStream } from 'fs'
import { dirname } from 'path'

const INHERITED = [
  'PATH',
  'HOME',
  'TMPDIR',
  'LANG',
  'LC_ALL',
  'TERM',
  'USER',
  'SHELL',
]
const TAIL_LINES = 40

export interface SupervisedChild {
  name: string
  proc: ChildProcess
  logPath: string
  /** The command line it was started with (no environment). */
  argv: string[]
  /** Last lines of combined stdout/stderr. */
  tail(): string[]
  /** Resolves with the exit code (or signal name) once the child has exited. */
  exited: Promise<string>
  hasExited(): boolean
}

export function childEnv(
  base: Record<string, string | undefined>,
  extra: Record<string, string>,
): Record<string, string> {
  const env: Record<string, string> = {}
  for (const name of INHERITED) {
    const value = base[name]
    if (value !== undefined) env[name] = value
  }
  return { ...env, ...extra }
}

export class Supervisor {
  private readonly children: SupervisedChild[] = []
  private stopping = false

  isStopping(): boolean {
    return this.stopping
  }

  constructor(
    private readonly baseEnv: Record<string, string | undefined>,
    private readonly print: (line: string) => void = line => console.log(line),
    /** Reports exits/errors observed before shutdown, once `exited` resolves (possibly during stopAll). */
    private readonly onUnexpectedExit: (
      child: SupervisedChild,
      status: string,
    ) => void = () => {},
  ) {}

  get(name: string): SupervisedChild | undefined {
    return this.children.find(c => c.name === name)
  }

  /** `{name, pid}` of every child started (the pid is also its process-group id). */
  listPids(): Array<{ name: string; pid: number; argv: string[] }> {
    return this.children.flatMap(c =>
      c.proc.pid === undefined
        ? []
        : [{ name: c.name, pid: c.proc.pid, argv: c.argv }],
    )
  }

  /** Synchronous, best-effort SIGKILL of every child's process group: for `process.on('exit')`,
   * where nothing asynchronous can run. */
  killAllNow(): void {
    for (const c of this.children) {
      if (c.hasExited() || c.proc.pid === undefined) continue
      try {
        process.kill(-c.proc.pid, 'SIGKILL')
      } catch {
        /* already gone */
      }
    }
  }

  start(params: {
    name: string
    command: string
    args: string[]
    cwd: string
    env: Record<string, string>
    logPath: string
    /** Called for every output line (used for ready-line detection). */
    onLine?: (line: string) => void
  }): SupervisedChild {
    mkdirSync(dirname(params.logPath), { recursive: true, mode: 0o700 })
    const log: WriteStream = createWriteStream(params.logPath, {
      flags: 'a',
      mode: 0o600,
    })
    // A log that cannot be written (its directory was removed) must never take the launcher down.
    log.on('error', () => {})
    const proc = spawn(params.command, params.args, {
      cwd: params.cwd,
      env: childEnv(this.baseEnv, params.env),
      detached: true, // own process group: killed as a group in stopAll
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const tailLines: string[] = []
    let exitedFlag = false
    let unexpectedExit: boolean | undefined
    const exited = new Promise<string>(resolve => {
      proc.on('error', err => {
        tailLines.push(`failed to start: ${err.message}`)
        unexpectedExit ??= !this.stopping
        exitedFlag = true
        // A command that never started never emits 'close': end its log here.
        log.end()
        resolve('error')
      })
      // `exited` (the promise) resolves on 'close', when the stdio pipes have ended too. The flag
      // used to guard signalling flips on 'exit': once the group leader is gone its pgid may be
      // reused by an unrelated process, and killing -pgid would hit it.
      proc.on('exit', () => {
        // Descendants can hold the pipes open beyond stopAll. Classify now; draining those
        // pipes must not turn an already-unexpected exit into an intentional shutdown.
        unexpectedExit ??= !this.stopping
        exitedFlag = true
      })
      proc.on('close', (code, signal) => {
        exitedFlag = true
        log.end()
        resolve(signal ?? String(code))
      })
    })
    const feed = (chunk: Buffer, buffer: { text: string }) => {
      log.write(chunk)
      buffer.text += chunk.toString('utf8')
      let idx = buffer.text.indexOf('\n')
      while (idx >= 0) {
        const line = buffer.text.slice(0, idx)
        buffer.text = buffer.text.slice(idx + 1)
        tailLines.push(line)
        if (tailLines.length > TAIL_LINES) tailLines.shift()
        params.onLine?.(line)
        idx = buffer.text.indexOf('\n')
      }
    }
    const out = { text: '' }
    const err = { text: '' }
    proc.stdout?.on('data', c => feed(c, out))
    proc.stderr?.on('data', c => feed(c, err))
    const child: SupervisedChild = {
      name: params.name,
      proc,
      logPath: params.logPath,
      argv: [params.command, ...params.args],
      tail: () => [...tailLines],
      exited,
      hasExited: () => exitedFlag,
    }
    this.children.push(child)
    void exited.then(status => {
      if (unexpectedExit) {
        this.print(
          `[demo] ${params.name} exited unexpectedly (${status}); last output in ${params.logPath}`,
        )
        this.onUnexpectedExit(child, status)
      }
    })
    return child
  }

  /** SIGTERM every process group, wait up to `graceMs`, then SIGKILL what is left. Idempotent. */
  async stopAll(graceMs = 8000): Promise<void> {
    this.stopping = true
    const signalAll = (signal: NodeJS.Signals) => {
      for (const c of this.children) {
        if (c.hasExited() || c.proc.pid === undefined) continue
        try {
          process.kill(-c.proc.pid, signal)
        } catch {
          /* already gone */
        }
      }
    }
    signalAll('SIGTERM')
    const all = Promise.all(this.children.map(c => c.exited))
    const timedOut = await Promise.race([
      all.then(() => false),
      new Promise<boolean>(resolve => setTimeout(() => resolve(true), graceMs)),
    ])
    if (timedOut) {
      signalAll('SIGKILL')
      await all
    }
  }
}
