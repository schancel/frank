/**
 * Cross-tab critical section for setup commitment (#308).
 *
 * In the browser, navigator.locks (Web Locks API) serializes setup commits across all tabs
 * sharing the origin. In non-browser environments (Jest, Node, or older browsers), an in-process
 * queue serializes concurrent calls.
 */

let inProcessLockTail: Promise<unknown> = Promise.resolve()

export interface SetupCommitLockOptions {
  name?: string
}

export async function withSetupCommitLock<T>(
  fn: () => Promise<T>,
  options?: SetupCommitLockOptions,
): Promise<T> {
  const lockName = options?.name ?? 'frank.setup.commit'
  if (typeof navigator !== 'undefined' && navigator?.locks?.request) {
    return await navigator.locks.request(lockName, () => fn())
  }
  const prev = inProcessLockTail
  let release: (() => void) | undefined
  const current = new Promise<void>(resolve => {
    release = resolve
  })
  inProcessLockTail = current
  await prev
  try {
    return await fn()
  } finally {
    if (release) release()
  }
}

export function resetSetupCommitLock(): void {
  inProcessLockTail = Promise.resolve()
}
