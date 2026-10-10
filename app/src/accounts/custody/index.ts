import {
  openPreviewVault,
  VaultError,
  type PreviewVault,
} from '@frank/account-vault'
import {
  decodeRecoveryDescriptor,
  isAccountRootOf,
} from '@frank/account-recovery'
import type { DomainRoot } from '@frank/domain-roots'
import {
  capture,
  expected,
  id,
  matches,
  nextRevision,
  same,
  wipe,
} from './records'
import { database, stateTransaction } from './persistence'
import {
  CustodyError,
  writeIntent,
  type AccountCustody,
  type ActiveCustody,
  type CustodySnapshot,
  type PendingChange,
  type PublicAccount,
} from './types'

export { CustodyError } from './types'
export type {
  AccountCustody,
  ActiveCustody,
  CustodyErrorCode,
  CustodySnapshot,
  ExpectedActive,
  PendingChange,
  PublicAccount,
  StageAccount,
} from './types'

function normalized(error: unknown): CustodyError {
  if (error instanceof CustodyError) return error
  if (error instanceof VaultError) {
    if (
      [
        'invalid-input',
        'unavailable',
        'closed',
        'conflict',
        'capacity',
        'storage-failed',
      ].includes(error.code)
    ) {
      return new CustodyError(error.code as CustodyError['code'])
    }
  }
  return new CustodyError('locked')
}

/** Browser preview only. Opening this facade never activates a staged account. */
export async function openAccountCustody(options: {
  namespace: string
}): Promise<AccountCustody> {
  let namespace: string
  try {
    namespace = options.namespace
    if (
      typeof namespace !== 'string' ||
      !/^[a-zA-Z0-9_-]{1,64}$/.test(namespace)
    )
      throw 0
  } catch {
    throw new CustodyError('invalid-input')
  }
  let db: IDBDatabase | undefined, vault: PreviewVault | undefined
  try {
    // Inspect existing public state before any vault capability writes.
    db = await database(namespace)
    await stateTransaction(db)
    vault = await openPreviewVault({ namespace })
    return facade(db, vault)
  } catch (error) {
    db?.close()
    vault?.close()
    throw normalized(error)
  }
}

function facade(db: IDBDatabase, vault: PreviewVault): AccountCustody {
  let closed = false
  const capabilities = new Set<ActiveCustody>()
  const check = () => {
    if (closed) throw new CustodyError('closed')
  }
  const run = async <T>(work: () => Promise<T>): Promise<T> => {
    try {
      check()
      const result = await work()
      check()
      return result
    } catch (error) {
      throw normalized(error)
    }
  }
  const read = () => {
    check()
    return stateTransaction(db)
  }
  const update = (change: (state: CustodySnapshot) => CustodySnapshot) => {
    check()
    return stateTransaction(db, state => {
      check()
      return change(state)
    })
  }
  const pendingFor = (
    state: CustodySnapshot,
    attemptId: string,
  ): PendingChange => {
    if (
      !state.pending ||
      state.pending.account.receipt.operationId !== attemptId
    )
      throw new CustodyError('conflict')
    return state.pending
  }
  /** A stored account root must be the root of the account its record names. */
  const accountRootIntact = async (
    account: PublicAccount,
  ): Promise<boolean> => {
    const stored = await vault.openAccountRoot(account.receipt)
    try {
      return (
        stored !== null &&
        isAccountRootOf(stored, decodeRecoveryDescriptor(account.descriptor))
      )
    } finally {
      stored?.fill(0)
    }
  }
  const authenticated = async (pending: PendingChange): Promise<void> => {
    const roots = await vault.open(pending.account.receipt)
    try {
      check()
    } finally {
      wipe(roots)
    }
    // Staged material that cannot reproduce its account is never ready to activate.
    if (!(await accountRootIntact(pending.account)))
      throw new CustodyError('conflict')
  }
  const discard = async (pending: PendingChange): Promise<CustodySnapshot> => {
    await vault.discardIntent(writeIntent(pending.account))
    return update(state => {
      // A delayed duplicate cleanup must not clear a newer pending attempt.
      if (!state.pending || !same(state.pending, pending)) return state
      return {
        schema: 1,
        revision: state.revision,
        active: state.active,
        pending: null,
      }
    })
  }

  return Object.freeze({
    snapshot: () => run(read),
    async stage(input) {
      // capture is synchronous even if the caller mutates inputs as soon as stage returns.
      check()
      const captured = capture(input)
      try {
        return await run(async () => {
          const { account, expectedActive, roots, accountRoot } = captured
          const state = await update(current => {
            if (!matches(current, expectedActive))
              throw new CustodyError('conflict')
            if (current.pending) {
              if (
                current.pending.status !== 'staging' ||
                !same(current.pending.account, account) ||
                !same(current.pending.expectedActive, expectedActive)
              )
                throw new CustodyError('conflict')
              return current
            }
            if (
              current.active?.receipt.context.creationId ===
              account.receipt.context.creationId
            )
              throw new CustodyError('conflict')
            return {
              schema: 1,
              revision: current.revision,
              active: current.active,
              pending: { status: 'staging', account, expectedActive },
            }
          })
          const pending = pendingFor(state, account.receipt.operationId)
          const status = await vault.reconcile(account.receipt)
          if (status === 'absent') {
            try {
              await vault.stage(writeIntent(account), roots, accountRoot)
            } catch (error) {
              // Concurrent same-intent writes and lost acknowledgements resolve by exact receipt.
              if ((await vault.reconcile(account.receipt)) !== 'committed')
                throw error
            }
          } else if (status !== 'committed') throw new CustodyError('locked')
          const opened = await vault.open(account.receipt)
          try {
            if (
              opened.length !== roots.length ||
              opened.some((root, i) =>
                root.bytes.some((byte, j) => byte !== roots[i].bytes[j]),
              )
            ) {
              throw new CustodyError('conflict')
            }
          } finally {
            wipe(opened)
          }
          // Read the account root back as well: a record that cannot reproduce this
          // account must surface now, not at the first backup.
          if (!(await accountRootIntact(account)))
            throw new CustodyError('conflict')
          const latest = await read()
          if (!same(latest.pending, pending)) throw new CustodyError('conflict')
          return latest
        })
      } finally {
        wipe(captured.roots)
        captured.accountRoot.fill(0)
      }
    },
    reconcile: attemptId =>
      run(async () => {
        const operation = id(attemptId),
          state = await read()
        if (state.active?.receipt.operationId === operation) {
          const roots = await vault.open(state.active.receipt)
          wipe(roots)
          const latest = await read()
          if (!same(latest.active, state.active))
            throw new CustodyError('conflict')
          return 'active'
        }
        const pending = pendingFor(state, operation)
        if (pending.status === 'discarding') {
          await discard(pending)
          return 'discarded'
        }
        const status = await vault.reconcile(pending.account.receipt)
        if (status !== 'absent' && status !== 'committed')
          throw new CustodyError('locked')
        if (status === 'committed') await authenticated(pending)
        if (!same((await read()).pending, pending))
          throw new CustodyError('conflict')
        return status === 'absent' ? 'incomplete' : 'ready'
      }),
    activate: (attemptId, precondition) =>
      run(async () => {
        const operation = id(attemptId),
          wanted = expected(precondition)
        const state = await read()
        if (state.active?.receipt.operationId === operation) {
          // Lost activation acknowledgement: the active pointer is the authoritative receipt.
          const roots = await vault.open(state.active.receipt)
          wipe(roots)
          const latest = await read()
          if (!same(latest.active, state.active))
            throw new CustodyError('conflict')
          return latest
        }
        const pending = pendingFor(state, operation)
        if (
          pending.status !== 'staging' ||
          !same(pending.expectedActive, wanted) ||
          !matches(state, wanted)
        )
          throw new CustodyError('conflict')
        await authenticated(pending)
        return update(current => {
          if (!matches(current, wanted) || !same(current.pending, pending))
            throw new CustodyError('conflict')
          return {
            schema: 1,
            revision: nextRevision(current),
            active: pending.account,
            // After pointer commit only, the former active receipt becomes exact owned cleanup.
            pending: current.active
              ? {
                  status: 'discarding',
                  account: current.active,
                  expectedActive: wanted,
                }
              : null,
          }
        })
      }),
    cancel: attemptId =>
      run(async () => {
        const operation = id(attemptId)
        const state = await update(current => {
          const pending = pendingFor(current, operation)
          return {
            schema: 1,
            revision: current.revision,
            active: current.active,
            pending: {
              status: 'discarding',
              account: pending.account,
              expectedActive: pending.expectedActive,
            },
          }
        })
        return discard(state.pending!)
      }),
    openActive: () =>
      run(async () => {
        const state = await read()
        if (!state.active) throw new CustodyError('locked')
        let roots: readonly DomainRoot[] | undefined = await vault.open(
          state.active.receipt,
        )
        try {
          const latest = await read()
          if (
            latest.revision !== state.revision ||
            !same(latest.active, state.active)
          )
            throw new CustodyError('conflict')
          check()
          const capability: ActiveCustody = Object.freeze({
            account: state.active,
            takeRoots() {
              check()
              if (!roots) throw new CustodyError('closed')
              const owned = roots
              roots = undefined
              capabilities.delete(capability)
              return owned
            },
            close() {
              if (roots) wipe(roots)
              roots = undefined
              capabilities.delete(capability)
            },
          })
          capabilities.add(capability)
          return capability
        } catch (error) {
          if (roots) wipe(roots)
          throw error
        }
      }),
    exportAccountRoot: () =>
      run(async () => {
        const state = await read()
        if (!state.active) throw new CustodyError('locked')
        const accountRoot = await vault.openAccountRoot(state.active.receipt)
        try {
          const latest = await read()
          if (
            latest.revision !== state.revision ||
            !same(latest.active, state.active)
          )
            throw new CustodyError('conflict')
          check()
          return { account: state.active, accountRoot }
        } catch (error) {
          accountRoot?.fill(0)
          throw error
        }
      }),
    close() {
      closed = true
      for (const capability of capabilities) capability.close()
      vault.close()
      db.close()
    },
  } satisfies AccountCustody)
}
