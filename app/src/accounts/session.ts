import { reactive, readonly } from 'vue'
import {
  activeChain,
  type NativeWalletHandle,
  type WalletHandle,
} from '@frank/wallet/chain'
import type { MonadRootBundle } from '@frank/wallet/chain/active-chain'
import { Platform } from 'quasar'
import type { DomainRoot } from '@frank/domain-roots'
import {
  openAccountCustody,
  CustodyError,
  type AccountCustody,
  type CustodySnapshot,
  type PublicAccount,
  type StageAccount,
  type ExpectedActive,
} from './custody'

export type RuntimeWallet = NativeWalletHandle &
  WalletHandle & { close(): Promise<void> }
export type SessionStatus =
  | 'loading'
  | 'fresh'
  | 'pending'
  | 'locked'
  | 'unavailable'
  | 'ready'
export interface AccountSessionState {
  status: SessionStatus
  revision: number
  account: PublicAccount | null
  pending: CustodySnapshot['pending']
  pendingReady: boolean
  pendingError: string | null
  error: string | null
}

/** The only runtime owner. Its reactive projection contains public data only. */
export function createAccountSession(deps: {
  open: () => Promise<AccountCustody>
  createWallet: (roots: MonadRootBundle) => Promise<RuntimeWallet>
  listen?: (invalidate: () => void, foreground: () => void) => () => void
  notify?: () => void
}) {
  const state = reactive<AccountSessionState>({
    status: 'loading',
    revision: 0,
    account: null,
    pending: null,
    pendingReady: false,
    pendingError: null,
    error: null,
  })
  let custody: AccountCustody | undefined
  let wallet: RuntimeWallet | undefined
  let generation = 0
  let tail = Promise.resolve()
  let initialized: Promise<void> | undefined
  let unlisten: (() => void) | undefined
  let closed = false
  const publish = (snapshot: CustodySnapshot) => {
    // Custody returns a new object for every snapshot. Consumers hold `state.account` across
    // `getWallet()` (which revalidates) and compare it by identity to detect an account change, so
    // an unchanged account at an unchanged revision must keep its published object.
    const unchanged =
      state.account !== null &&
      snapshot.active !== null &&
      state.revision === snapshot.revision &&
      state.account.receipt.context.accountId ===
        snapshot.active.receipt.context.accountId
    state.revision = snapshot.revision
    if (!unchanged) state.account = snapshot.active
    state.pending = snapshot.pending
  }
  const fail = (error: unknown) => {
    const code = error instanceof CustodyError ? error.code : 'unavailable'
    state.error = code
    state.status = code === 'unavailable' ? 'unavailable' : 'locked'
  }
  const exclusive = <T>(run: () => Promise<T>): Promise<T> => {
    const next = tail.then(run)
    tail = next.then(
      () => undefined,
      () => undefined,
    )
    return next
  }
  const release = async () => {
    const previous = wallet
    wallet = undefined
    if (previous) await previous.close()
  }
  const check = (token: number) => {
    if (closed || token !== generation) throw new CustodyError('closed')
  }
  async function refresh(token: number) {
    check(token)
    custody ??= await deps.open()
    check(token)
    let snapshot = await custody.snapshot()
    check(token)
    if (
      wallet &&
      (walletAccount !== snapshot.active?.receipt.context.accountId ||
        walletRevision !== snapshot.revision)
    ) {
      state.status = 'loading'
      await release()
      check(token)
    }
    publish(snapshot)
    state.pendingReady = false
    state.pendingError = null
    if (snapshot.pending) {
      try {
        const result = await custody.reconcile(
          snapshot.pending.account.receipt.operationId,
        )
        state.pendingReady = result === 'ready'
      } catch (error) {
        state.pendingError =
          error instanceof CustodyError ? error.code : 'unavailable'
      }
      check(token)
      snapshot = await custody.snapshot()
      check(token)
      publish(snapshot)
    }
    if (!snapshot.active) {
      await release()
      check(token)
      state.status = snapshot.pending ? 'pending' : 'fresh'
      state.error = null
      return
    }
    if (
      wallet &&
      walletAccount === snapshot.active.receipt.context.accountId &&
      walletRevision === snapshot.revision
    ) {
      if (state.pendingError) {
        // Failed pending cleanup is not evidence that the separate active record is locked.
        const active = await custody.openActive()
        active.close()
        check(token)
        if (active.account.receipt.context.accountId !== walletAccount)
          throw new CustodyError('conflict')
      }
      state.status = 'ready'
      state.error = null
      return
    }
    await release()
    check(token)
    const capability = await custody.openActive()
    let roots: readonly DomainRoot[] = []
    let candidate: RuntimeWallet | undefined
    try {
      check(token)
      roots = capability.takeRoots()
      const find = <P extends DomainRoot['purpose']>(
        purpose: P,
      ): DomainRoot<P> => {
        const root = roots.find(value => value.purpose === purpose)
        if (!root) throw new CustodyError('locked')
        return root as DomainRoot<P>
      }
      candidate = await deps.createWallet({
        evm: find('evm-wallet'),
        authentication: find('identity-authentication'),
        messaging: find('messaging-encryption'),
      })
      check(token)
      const latest = await custody.snapshot()
      check(token)
      if (
        latest.revision !== snapshot.revision ||
        latest.active?.receipt.context.accountId !==
          capability.account.receipt.context.accountId
      )
        throw new CustodyError('conflict')
      wallet = candidate
      candidate = undefined
      walletAccount = capability.account.receipt.context.accountId
      walletRevision = latest.revision
      publish(latest)
      state.status = 'ready'
      state.error = null
    } finally {
      roots.forEach(root => root.bytes.fill(0))
      capability.close()
      if (candidate) await candidate.close()
    }
  }
  let walletAccount: string | undefined
  let walletRevision = -1
  async function runRefresh() {
    const token = generation
    try {
      await refresh(token)
    } catch (error) {
      if (!closed && token === generation) {
        try {
          await release()
        } finally {
          fail(error)
        }
      }
    }
  }
  function revalidate() {
    if (initialized) return initialized
    initialized = exclusive(runRefresh).finally(() => {
      initialized = undefined
    })
    return initialized
  }
  function invalidate() {
    if (closed) return
    ++generation
    // close() revokes the native handle synchronously, before its teardown awaits.
    const releasing = release()
    // Observe teardown failure immediately even when an earlier operation still owns the queue.
    void releasing.catch(() => undefined)
    void exclusive(async () => {
      try {
        await releasing
        await runRefresh()
      } catch (error) {
        if (!closed) fail(error)
      }
    })
    // Schedule teardown before reactive consumers can enqueue another acquisition.
    state.status = 'loading'
  }
  const session = {
    state: readonly(state),
    initialize() {
      if (closed) return Promise.resolve()
      unlisten ??= deps.listen?.(invalidate, () => {
        void revalidate().catch(() => undefined)
      })
      return revalidate()
    },
    retry() {
      return exclusive(runRefresh)
    },
    async getWallet(): Promise<RuntimeWallet> {
      await session.initialize()
      if (state.status !== 'ready' || !wallet) throw new CustodyError('locked')
      return wallet
    },
    async snapshot() {
      await this.initialize()
      if (!custody || closed) throw new CustodyError('unavailable')
      return custody.snapshot()
    },
    async stage(input: StageAccount) {
      return exclusive(async () => {
        if (!custody || closed) throw new CustodyError('unavailable')
        const token = generation
        // The caller retains roots until this promise settles; custody owns persistence.
        try {
          const snapshot = await custody.stage(input)
          check(token)
          publish(snapshot)
        } finally {
          deps.notify?.()
          await runRefresh()
        }
      })
    },
    async activatePending(attemptId: string, expectedActive: ExpectedActive) {
      const wanted = { ...expectedActive }
      return exclusive(async () => {
        if (!custody || closed) throw new CustodyError('unavailable')
        const snapshot = await custody.snapshot()
        const pending = snapshot.pending
        if (
          !pending ||
          pending.status !== 'staging' ||
          pending.account.receipt.operationId !== attemptId ||
          pending.expectedActive.revision !== wanted.revision ||
          pending.expectedActive.accountId !== wanted.accountId
        )
          throw new CustodyError('conflict')
        // Explicit user action is required even when staged material survived a restart.
        const token = ++generation
        state.status = 'loading'
        try {
          await release()
          check(token)
          const activated = await custody.activate(attemptId, wanted)
          check(token)
          publish(activated)
        } finally {
          deps.notify?.()
          await runRefresh()
        }
      })
    },
    async cancelPending(attemptId: string) {
      return exclusive(async () => {
        if (!custody || closed) throw new CustodyError('unavailable')
        try {
          await custody.cancel(attemptId)
        } finally {
          await runRefresh()
        }
      })
    },
    async close() {
      closed = true
      unlisten?.()
      unlisten = undefined
      ++generation
      state.status = 'locked'
      await exclusive(async () => {
        try {
          await release()
        } finally {
          custody?.close()
          custody = undefined
        }
      })
    },
  }
  return session
}

let accountChannel: BroadcastChannel | undefined
export const accountSession = createAccountSession({
  listen(invalidate, foreground) {
    const channel =
      typeof window.BroadcastChannel === 'function'
        ? new window.BroadcastChannel('frank-account-changed-v1')
        : undefined
    accountChannel = channel
    if (channel) channel.onmessage = invalidate
    const visible = () => {
      if (!document.hidden) foreground()
    }
    window.addEventListener('focus', foreground)
    document.addEventListener('visibilitychange', visible)
    return () => {
      channel?.close()
      if (accountChannel === channel) accountChannel = undefined
      window.removeEventListener('focus', foreground)
      document.removeEventListener('visibilitychange', visible)
    }
  },
  notify() {
    accountChannel?.postMessage('changed')
  },
  open: () => {
    // Preview capability evidence is browser-only; native webviews do not inherit it.
    if (
      Platform.is.electron ||
      Platform.is.capacitor ||
      Platform.is.cordova
    )
      return Promise.reject(new CustodyError('unavailable'))
    return openAccountCustody({ namespace: 'local-account-v1' })
  },
  createWallet: roots => activeChain.createWallet(roots),
})
export const accountStatus = accountSession.state
