import {
  openPreviewVault,
  BIP39_RECOVERY_FORMAT,
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
  captureBip39,
  expected,
  id,
  matches,
  nextRevision,
  parse,
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
import { bip39Descriptor } from './bip39'

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
  StageBip39Account,
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
  let db: IDBDatabase | undefined
  try {
    // Inspect existing public state before any vault capability writes.
    db = await database(namespace)
    if (db) await stateTransaction(db)
    return facade(namespace)
  } catch (error) {
    throw normalized(error)
  } finally {
    db?.close()
  }
}

function facade(namespace: string): AccountCustody {
  let closed = false
  const connections = new Set<IDBDatabase>()
  let vaultOpening: Promise<PreviewVault> | undefined
  let openedVault: PreviewVault | undefined
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
  const vault = async (): Promise<PreviewVault> => {
    check()
    vaultOpening ??= openPreviewVault({ namespace })
      .then(value => {
        if (closed) {
          value.close()
          throw new CustodyError('closed')
        }
        openedVault = value
        return value
      })
      .catch(error => {
        vaultOpening = undefined
        throw error
      })
    const value = await vaultOpening
    check()
    return value
  }
  const access = async (
    change?: (state: CustodySnapshot) => CustodySnapshot,
  ) => {
    check()
    const db = change
      ? await database(namespace, true)
      : await database(namespace)
    try {
      check()
      if (db) connections.add(db)
      const result = db
        ? await stateTransaction(
            db,
            change &&
              (state => {
                check()
                return change(state)
              }),
          )
        : parse(undefined)
      check()
      return result
    } finally {
      db?.close()
      if (db) connections.delete(db)
    }
  }
  const read = () => access()
  const update = (change: (state: CustodySnapshot) => CustodySnapshot) =>
    access(change)
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
  /**
   * A stored account root must be the root of the account its record names. A record with
   * no account root at all was staged before roots were kept and cannot be activated.
   */
  const requireAccountRoot = async (account: PublicAccount): Promise<void> => {
    const stored = await (await vault()).openAccountRoot(account.receipt)
    try {
      if (stored === null) throw new CustodyError('outdated-attempt')
      if (
        !isAccountRootOf(stored, decodeRecoveryDescriptor(account.descriptor))
      )
        throw new CustodyError('conflict')
    } finally {
      stored?.fill(0)
    }
  }
  const historical = (account: PublicAccount) =>
    account.receipt.context.recoveryFormat === BIP39_RECOVERY_FORMAT
  const openBip39Seed = async (account: PublicAccount): Promise<Uint8Array> => {
    const seed = await (await vault()).openBip39Seed(account.receipt)
    try {
      if (!seed || bip39Descriptor(seed).descriptor !== account.descriptor)
        throw new CustodyError('conflict')
      return seed
    } catch (error) {
      seed?.fill(0)
      throw error
    }
  }
  const authenticateAccount = async (account: PublicAccount) => {
    if (historical(account)) {
      const seed = await openBip39Seed(account)
      seed.fill(0)
    } else {
      wipe(await (await vault()).open(account.receipt))
      await requireAccountRoot(account)
    }
    check()
  }
  const authenticated = async (pending: PendingChange): Promise<void> => {
    await authenticateAccount(pending.account)
  }
  const discard = async (pending: PendingChange): Promise<CustodySnapshot> => {
    await (await vault()).discardIntent(writeIntent(pending.account))
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
      const captured = (() => {
        try {
          return 'bip39Seed' in input ? captureBip39(input) : capture(input)
        } catch {
          throw new CustodyError('invalid-input')
        }
      })()
      const secret = 'seed' in captured ? captured.seed : captured.accountRoot
      try {
        return await run(async () => {
          const { account, expectedActive } = captured
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
          const status = await (await vault()).reconcile(account.receipt)
          if (status === 'absent') {
            try {
              await (await vault()).stage(writeIntent(account), secret)
            } catch (error) {
              // Concurrent same-intent writes and lost acknowledgements resolve by exact receipt.
              if (
                (await (await vault()).reconcile(account.receipt)) !==
                'committed'
              )
                throw error
            }
          } else if (status !== 'committed') throw new CustodyError('locked')
          // The record must open, and (below) hold exactly this account's root.
          await authenticateAccount(account)
          const latest = await read()
          if (!same(latest.pending, pending)) throw new CustodyError('conflict')
          return latest
        })
      } finally {
        secret.fill(0)
      }
    },
    reconcile: attemptId =>
      run(async () => {
        const operation = id(attemptId),
          state = await read()
        if (state.active?.receipt.operationId === operation) {
          await authenticateAccount(state.active)
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
        const status = await (await vault()).reconcile(pending.account.receipt)
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
          await authenticateAccount(state.active)
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
        let seed = historical(state.active)
          ? await openBip39Seed(state.active)
          : undefined
        let roots: readonly DomainRoot[] | undefined = seed
          ? undefined
          : await (await vault()).open(state.active.receipt)
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
            takeBip39Seed() {
              check()
              if (!seed) throw new CustodyError('closed')
              const owned = seed
              seed = undefined
              capabilities.delete(capability)
              return owned
            },
            close() {
              if (roots) wipe(roots)
              seed?.fill(0)
              seed = undefined
              roots = undefined
              capabilities.delete(capability)
            },
          })
          capabilities.add(capability)
          return capability
        } catch (error) {
          if (roots) wipe(roots)
          seed?.fill(0)
          throw error
        }
      }),
    async openPending(attemptId) {
      let roots: readonly DomainRoot[] | undefined
      try {
        check()
        const pending = pendingFor(await read(), id(attemptId))
        if (pending.status !== 'staging') throw new CustodyError('conflict')
        roots = await (await vault()).open(pending.account.receipt)
        if (!same((await read()).pending, pending))
          throw new CustodyError('conflict')
        check()
        return roots
      } catch (error) {
        if (roots) wipe(roots)
        throw normalized(error)
      }
    },
    async openPendingBip39Seed(attemptId) {
      let seed: Uint8Array | undefined
      try {
        check()
        const pending = pendingFor(await read(), id(attemptId))
        if (pending.status !== 'staging' || !historical(pending.account))
          throw new CustodyError('conflict')
        seed = await openBip39Seed(pending.account)
        if (!same((await read()).pending, pending))
          throw new CustodyError('conflict')
        check()
        return seed
      } catch (error) {
        seed?.fill(0)
        throw normalized(error)
      }
    },
    async exportAccountRoot() {
      let accountRoot: Uint8Array | null = null
      try {
        check()
        const state = await read()
        if (!state.active) throw new CustodyError('locked')
        accountRoot = await (
          await vault()
        ).openAccountRoot(state.active.receipt)
        const latest = await read()
        if (
          latest.revision !== state.revision ||
          !same(latest.active, state.active)
        )
          throw new CustodyError('conflict')
        // Last step before handing the copy over; any failure from here back wipes it.
        check()
        return { account: state.active, accountRoot }
      } catch (error) {
        accountRoot?.fill(0)
        throw normalized(error)
      }
    },
    close() {
      closed = true
      for (const capability of capabilities) capability.close()
      openedVault?.close()
      for (const db of connections) db.close()
    },
  } satisfies AccountCustody)
}
