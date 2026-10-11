import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { activeChain, type ContactPaymentInfo } from '@frank/wallet/chain'
import { accountStatus } from 'src/accounts/session'
import { useActiveWallet } from './useActiveWallet'

/** Read-only view of the contact-payment owner's journal. Never settles or retries a payment. */
export function useSentContactPayments(enabled: () => boolean) {
  const payments = ref<ContactPaymentInfo[]>([])
  let stopped = false
  let timer: ReturnType<typeof setTimeout> | undefined
  const read = async () => {
    const revision = accountStatus.revision
    const chainIdentifier = activeChain.chainIdentifier
    try {
      if (!enabled()) return
      const wallet = await useActiveWallet()
      if (
        stopped ||
        revision !== accountStatus.revision ||
        chainIdentifier !== activeChain.chainIdentifier ||
        wallet.chainIdentifier !== chainIdentifier
      )
        return
      payments.value = wallet.getContactPayments?.() ?? []
    } catch {
      payments.value = []
      // Missing journal or locked wallet means unknown, never paid.
    } finally {
      if (!stopped && enabled()) {
        timer = setTimeout(() => void read(), 5000)
        ;(timer as { unref?: () => void }).unref?.()
      }
    }
  }
  watch(
    () => [accountStatus.revision, activeChain.chainIdentifier],
    () => {
      payments.value = []
    },
    { flush: 'sync' },
  )
  onMounted(() => void read())
  onBeforeUnmount(() => {
    stopped = true
    clearTimeout(timer)
  })
  return { sentContactPayments: payments }
}
