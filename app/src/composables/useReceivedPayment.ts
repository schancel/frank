import { onBeforeUnmount, onMounted, ref, type Ref } from 'vue'
import type { ReceivedPayment } from '@frank/wallet/chain/chain-wallet'
import { useActiveWallet } from './useActiveWallet'

/** Payments (by one-time address) the user has been told did not arrive, this session. */
const notified = new Set<string>()

/** How often a payment the chain has not shown yet is looked at again. */
export const RECEIVED_PAYMENT_RECHECK_MS = 8_000

/**
 * What the wallet knows about the stealth payment a message item describes: `undefined` when the
 * wallet holds no coin for it (not addressed to this wallet, another chain, or no wallet). The
 * status and the amount are the wallet's, read from the chain; nothing here trusts the item.
 * While the chain has not shown the payment, the wallet is asked to read the chain again.
 */
export function useReceivedPayment(
  ephemeralPubKey: () => string | undefined,
  recheckMs: number = RECEIVED_PAYMENT_RECHECK_MS,
  onNotReceived?: (payment: ReceivedPayment) => void,
): {
  payment: Ref<ReceivedPayment | undefined>
} {
  const payment = ref<ReceivedPayment | undefined>()
  let timer: ReturnType<typeof setTimeout> | undefined
  let stopped = false
  const wanted = () =>
    (ephemeralPubKey() ?? '').replace(/^0x/, '').toLowerCase()
  const pick = (all: readonly ReceivedPayment[]) =>
    all.find(p => p.origin === 'stealth' && p.ephemeralPubKey === wanted())

  // Said once per payment and session: a payment a sender claimed did not arrive.
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
    if (stopped || wanted() === '') return
    try {
      const wallet = await useActiveWallet()
      if (stopped) return
      const known = pick(wallet.getReceivedPayments?.() ?? [])
      payment.value = known
      tell()
      // Nothing to wait for: the wallet has no coin for it, or the chain has shown the money.
      if (known === undefined || known.status === 'received') return
      const read = await wallet.refreshReceivedPayments?.()
      if (stopped) return
      payment.value = pick(read ?? []) ?? known
      tell()
    } catch {
      // The wallet or the node is not available: what is shown stays as it was.
    }
    if (!stopped && payment.value?.status !== 'received') {
      timer = setTimeout(() => void look(), recheckMs)
      // Under Node (tests) a forgotten mount must not keep the process alive.
      ;(timer as { unref?: () => void }).unref?.()
    }
  }

  onMounted(() => void look())
  onBeforeUnmount(() => {
    stopped = true
    if (timer !== undefined) clearTimeout(timer)
  })
  return { payment }
}
