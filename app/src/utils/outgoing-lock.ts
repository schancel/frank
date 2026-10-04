/**
 * One outgoing message is sent by at most one tab at a time. Every send or retry of a message
 * holds a Web Lock named after the message's store key for its whole duration, shared by all
 * tabs of this browser profile. A second tab that finds the lock held leaves the message alone
 * instead of judging it from its own (stale) copy, so it can never pay for it a second time.
 *
 * Where the Web Locks API is missing (node, jest, old browsers) there is no lock and callers
 * keep their in-tab protection only.
 */

/** The parts of `LockManager` used here. */
interface OutgoingLockManager {
  request<T>(
    name: string,
    options: { ifAvailable: true },
    callback: (lock: unknown) => Promise<T>,
  ): Promise<T>
  query(): Promise<{ held?: { name?: string }[] }>
}

export const outgoingLockName = (id: string) => `frank-outgoing:${id}`

function outgoingLocks(): OutgoingLockManager | undefined {
  const nav = (globalThis as { navigator?: { locks?: OutgoingLockManager } })
    .navigator
  return nav?.locks ?? undefined
}

/**
 * Runs `run` while holding the message's lock. `undefined` when another holder (another tab, or
 * another call in this tab) has it; `run` is then not called. Without the Web Locks API `run`
 * is simply called.
 */
export async function withOutgoingLock<T>(
  id: string,
  run: () => Promise<T>,
): Promise<{ result: T } | undefined> {
  const locks = outgoingLocks()
  if (!locks) return { result: await run() }
  return locks.request(
    outgoingLockName(id),
    { ifAvailable: true },
    async lock => (lock ? { result: await run() } : undefined),
  )
}

/** The store keys of outgoing messages some tab is sending right now (empty without the API or
 * when it cannot be asked). */
export async function heldOutgoingLocks(): Promise<Set<string>> {
  const held = new Set<string>()
  const locks = outgoingLocks()
  if (!locks) return held
  const prefix = outgoingLockName('')
  try {
    for (const lock of (await locks.query()).held ?? []) {
      if (lock.name?.startsWith(prefix))
        held.add(lock.name.slice(prefix.length))
    }
  } catch (error) {
    console.warn('could not ask which outgoing messages are being sent', error)
  }
  return held
}
