import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import {
  activeChain,
  onActiveChainChange,
  type ContactPaymentInfo,
} from '@frank/wallet/chain'
import { accountStatus } from 'src/accounts/session'
import { useActiveWallet } from './useActiveWallet'

/** Read-only view of the contact-payment owner's journal. Never settles or retries a payment. */
export function useSentContactPayments(enabled: () => boolean) {
  const payments = ref<ContactPaymentInfo[]>([])
  let stopped = false
  let mounted = false
  let generation = 0
  let timer: ReturnType<typeof setTimeout> | undefined
  let stopChain: (() => void) | undefined
  const invalidate = () => {
    generation++
    clearTimeout(timer)
    payments.value = []
  }
  const read = async () => {
    const admitted = generation
    const revision = accountStatus.revision
    const chainIdentifier = activeChain.chainIdentifier
    try {
      if (!enabled()) return
      const wallet = await useActiveWallet()
      if (
        stopped ||
        admitted !== generation ||
        revision !== accountStatus.revision ||
        chainIdentifier !== activeChain.chainIdentifier ||
        wallet.chainIdentifier !== chainIdentifier
      )
        return
      payments.value = wallet.getContactPayments?.() ?? []
    } catch {
      if (admitted === generation) payments.value = []
      // Missing journal or locked wallet means unknown, never paid.
    } finally {
      if (!stopped && enabled() && admitted === generation) {
        timer = setTimeout(() => void read(), 5000)
        ;(timer as { unref?: () => void }).unref?.()
      }
    }
  }
  const restart = () => {
    invalidate()
    if (mounted && enabled()) void read()
  }
  const activate = () => {
    stopChain?.()
    stopChain = undefined
    invalidate()
    if (!mounted || !enabled()) return
    // activeChain is a plain object; its owner supplies change notifications, including A→B→A.
    stopChain = onActiveChainChange(restart)
    void read()
  }
  watch(() => accountStatus.revision, restart, { flush: 'sync' })
  watch(enabled, activate, { flush: 'sync' })
  onMounted(() => {
    mounted = true
    activate()
  })
  onBeforeUnmount(() => {
    stopped = true
    stopChain?.()
    invalidate()
  })
  return { sentContactPayments: payments }
}
