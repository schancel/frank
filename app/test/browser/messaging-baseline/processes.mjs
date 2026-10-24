import { spawn, execFileSync } from 'node:child_process'
import { setTimeout as delay } from 'node:timers/promises'

// Detached process groups remain owned even when their original parent exits.
export class OwnedProcesses {
  groups = new Set()
  spawn(program, args, options = {}) {
    const child = spawn(program, args, { ...options, detached: true })
    if (child.pid) this.groups.add(child.pid)
    return child
  }
  members(group) {
    return execFileSync('ps', ['-axo', 'pid=,pgid='], { encoding: 'utf8' })
      .trim()
      .split('\n')
      .map(line => line.trim().split(/\s+/).map(Number))
      .filter(([, pgid]) => pgid === group)
      .map(([pid]) => pid)
  }
  alive(group) {
    return this.members(group).length > 0
  }
  signal(group, signal) {
    // macOS may reject signalling an orphaned group. Enumerate only members of
    // our detached group and signal each; never depend on the parent's lifetime.
    for (const pid of this.members(group)) {
      try {
        process.kill(pid, signal)
      } catch (error) {
        if (error.code !== 'ESRCH') throw error
      }
    }
  }
  async stopAll(graceMs = 1000) {
    const groups = [...this.groups]
    for (const pid of groups) this.signal(pid, 'SIGTERM')
    const deadline = Date.now() + graceMs
    while (groups.some(pid => this.alive(pid)) && Date.now() < deadline)
      await delay(25)
    for (const pid of groups) if (this.alive(pid)) this.signal(pid, 'SIGKILL')
    const killedDeadline = Date.now() + 5000
    while (groups.some(pid => this.alive(pid)) && Date.now() < killedDeadline)
      await delay(25)
    const survivors = groups.filter(pid => this.alive(pid))
    if (survivors.length)
      throw Error(
        `Owned process groups survived termination: ${survivors.join(',')}`,
      )
    this.groups.clear()
  }
}
