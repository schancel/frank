import { onBeforeUnmount, onMounted, ref, watch, type Ref } from 'vue'
import type { ReceivedPayment } from '@frank/wallet/chain/chain-wallet'
import { accountSession } from '../accounts/session'
import { receivedValueRevision } from '../utils/message-receipts'
import { peekActiveWallet } from './useActiveWallet'

/** Payments (by one-time address) the user has been told did not arrive, this session. */
const notified = new Set<string>()

/** How often a payment the chain has not shown yet is looked at again. */
export const RECEIVED_PAYMENT_RECHECK_MS = 8_000

type ReadyWallet = NonNullable<ReturnType<typeof peekActiveWallet>>

// Synchronous card watchers share one indexed public read for this invalidation turn.
// Mount/key/session changes and pending recovery still read the current owner directly.
// Release the derived index after the turn; it never becomes a lasting balance cache.
const revisionReads = new WeakMap<
  ReadyWallet,
  {
    revision: number
    sessionRevision: number
    account: typeof accountSession.state.account
    status: typeof accountSession.state.status
    byKey: Map<string, ReceivedPayment>
  }
>()

function paymentAtRevision(wallet: ReadyWallet, key: string) {
  const state = accountSession.state
  const revision = receivedValueRevision.value
  let read = revisionReads.get(wallet)
  if (
    !read ||
    read.revision !== revision ||
    read.sessionRevision !== state.revision ||
    read.account !== state.account ||
    read.status !== state.status
  ) {
    const byKey = new Map<string, ReceivedPayment>()
    for (const payment of wallet.getReceivedPayments?.() ?? []) {
      if (
        payment.origin === 'stealth' &&
        payment.ephemeralPubKey &&
        !byKey.has(payment.ephemeralPubKey)
      )
        byKey.set(payment.ephemeralPubKey, payment)
    }
    read = {
      revision,
      sessionRevision: state.revision,
      account: state.account,
      status: state.status,
      byKey,
    }
    revisionReads.set(wallet, read)
    const snapshot = read
    queueMicrotask(() => {
      if (revisionReads.get(wallet) === snapshot) revisionReads.delete(wallet)
    })
  }
  return read.byKey.get(key)
}

/** Historical arrival and last observed current funds come from the public wallet projection.
 * Shared receipt invalidation rereads memory even after arrival; only the existing pending
 * payment loop asks for recovery. A render read never opens custody or starts a chain read. */
export function useReceivedPayment(
  ephemeralPubKey: () => string | undefined,
  recheckMs: number = RECEIVED_PAYMENT_RECHECK_MS,
  onNotReceived?: (payment: ReceivedPayment) => void,
): {
  payment: Ref<ReceivedPayment | undefined>
} {
  const payment = ref<ReceivedPayment | undefined>()
  let timer: ReturnType<typeof setTimeout> | undefined
  let mounted = false
  let stopped = false
  let generation = 0
  let viewRead = 0
  const wanted = () =>
    (ephemeralPubKey() ?? '').replace(/^0x/, '').toLowerCase()
  const pick = (all: readonly ReceivedPayment[], key: string) =>
    all.find(p => p.origin === 'stealth' && p.ephemeralPubKey === key)
  const clearTimer = () => {
    if (timer !== undefined) clearTimeout(timer)
    timer = undefined
  }

  const tell = () => {
    const known = payment.value
    if (
      known === undefined ||
      (known.status !== 'not-received' && known.status !== 'failed') ||
      notified.has(known.address)
    )
      return
    notified.add(known.address)
    onNotReceived?.(known)
  }

  const look = async () => {
    clearTimer()
    const key = wanted()
    const wallet = key ? peekActiveWallet() : undefined
    if (stopped || !wallet) return
    const token = generation
    const read = ++viewRead
    const current = () =>
      !stopped &&
      token === generation &&
      key === wanted() &&
      wallet === peekActiveWallet()
    let retry = true
    try {
      const known = pick(wallet.getReceivedPayments?.() ?? [], key)
      payment.value = known
      tell()
      if (known === undefined || known.status === 'received') {
        retry = false
        return
      }
      const refreshed = await wallet.refreshReceivedPayments?.()
      // A newer memory read (including a confirmed empty account) beats an older pending read.
      if (!current() || read !== viewRead) return
      payment.value = pick(refreshed ?? [], key) ?? known
      tell()
    } catch {
      // Unknown is not a spend: retain this context's last successful projection.
    } finally {
      if (retry && current() && payment.value?.status !== 'received') {
        timer = setTimeout(() => void look(), recheckMs)
        ;(timer as { unref?: () => void }).unref?.()
      }
    }
  }

  const reread = () => {
    if (!mounted || stopped) return
    ++viewRead
    const key = wanted()
    const wallet = key ? peekActiveWallet() : undefined
    if (!wallet) return
    try {
      payment.value = paymentAtRevision(wallet, key)
      tell()
      if (payment.value?.status === 'received') clearTimer()
    } catch {
      // A display invalidation never starts recovery or replaces known funds with zero.
    }
  }
  const restart = () => {
    ++generation
    clearTimer()
    payment.value = undefined
    if (mounted && !stopped) void look()
  }
  const stopContext = watch(
    [
      wanted,
      () => accountSession.state.revision,
      () => accountSession.state.status,
      () => accountSession.state.account,
    ],
    restart,
    { flush: 'sync' },
  )
  const stopReceipt = watch(receivedValueRevision, reread, { flush: 'sync' })
  onMounted(() => {
    mounted = true
    void look()
  })
  onBeforeUnmount(() => {
    stopped = true
    ++generation
    clearTimer()
    stopContext()
    stopReceipt()
  })
  return { payment }
}
