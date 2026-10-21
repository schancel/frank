import { watch } from 'vue'
import type { Router } from 'vue-router'
import {
  FRANK_DAPP_APPROVALS_CHANGED,
  FRANK_DAPP_BRIDGE_CHANNEL,
  isBrowserExtensionRuntime,
  onRuntimeMessage,
  sendRuntimeMessage,
} from '../../src-bex/runtime-adapter'
import { accountStatus } from '../accounts/session'

export const DAPP_APPROVAL_ROUTE = '/dapp-bridge'

export function isDappApprovalsChangedMessage(message: unknown): boolean {
  const m = message as { channel?: unknown; type?: unknown } | null
  return (
    m?.channel === FRANK_DAPP_BRIDGE_CHANNEL &&
    m?.type === FRANK_DAPP_APPROVALS_CHANGED
  )
}

export async function fetchPendingDappApprovalCount(
  globalScope?: Record<string, any>,
): Promise<number> {
  const res = await sendRuntimeMessage<
    unknown,
    { result?: { pendingApprovals?: unknown[] } }
  >(
    { channel: FRANK_DAPP_BRIDGE_CHANNEL, type: 'get-bridge-state' },
    globalScope,
  )
  const pending = res?.result?.pendingApprovals
  return Array.isArray(pending) ? pending.length : 0
}

/**
 * In an extension view (popup, side panel, window), show the dApp approval
 * screen whenever the background holds a pending dApp request: when the view
 * opens, when it regains focus, and when the background reports a new request.
 * A dApp's eth_requestAccounts otherwise waits forever behind a view that is
 * open on another route. Returns a disposer; a no-op outside an extension.
 */
export function installDappApprovalSurfacing(
  router: Pick<Router, 'currentRoute' | 'push'>,
  globalScope?: Record<string, any>,
): () => void {
  if (!isBrowserExtensionRuntime(globalScope)) {
    return () => undefined
  }

  let checking = false
  let recheck = false
  const check = async () => {
    if (checking) {
      recheck = true
      return
    }
    checking = true
    try {
      do {
        recheck = false
        // Onboarding and setup keep the screen until the account is ready.
        if (accountStatus.status !== 'ready') continue
        if ((await fetchPendingDappApprovalCount(globalScope)) === 0) continue
        if (router.currentRoute.value.path !== DAPP_APPROVAL_ROUTE) {
          await router.push(DAPP_APPROVAL_ROUTE)
        }
      } while (recheck)
    } catch {
      // Background unavailable; the next change notification retries.
    } finally {
      checking = false
    }
  }

  const offMessage = onRuntimeMessage(message => {
    if (isDappApprovalsChangedMessage(message)) void check()
    // Never answer: other extension pages' requests belong to the background.
    return undefined
  }, globalScope)

  const onVisible = () => {
    if (
      typeof document === 'undefined' ||
      document.visibilityState === 'visible'
    ) {
      void check()
    }
  }
  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', onVisible)
  }
  if (typeof window !== 'undefined') {
    window.addEventListener('focus', onVisible)
  }
  // A request that arrived during setup surfaces once the account is ready.
  const stopReadyWatch = watch(
    () => accountStatus.status,
    status => {
      if (status === 'ready') void check()
    },
  )
  void check()

  return () => {
    stopReadyWatch()
    offMessage()
    if (typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', onVisible)
    }
    if (typeof window !== 'undefined') {
      window.removeEventListener('focus', onVisible)
    }
  }
}
