import { ref, watch, type Ref } from 'vue'
import { activeChain } from '@frank/wallet/chain'
import { accountStatus } from '../accounts/session'
import { useActiveWallet } from './useActiveWallet'
import { errorNotify } from '../utils/notifications'

/**
 * The address to fund: the active wallet's native receive account, the one the shared balance
 * (`useBalance`) reports and that pays for messages. It is NOT the identity address. The Wallet
 * and Receive pages both read it from here so they can never show different accounts (#834).
 *
 * Empty until loaded, and cleared synchronously whenever the account session changes so a copy
 * button can never hand out the previous account's address.
 */
export function useReceiveAddress(failedLoadKey: string): Ref<string> {
  const displayAddress = ref('')
  watch(
    () => [accountStatus.status, accountStatus.revision],
    async ([status], _previous, onCleanup) => {
      displayAddress.value = ''
      if (status !== 'ready') return
      let current = true
      onCleanup(() => {
        current = false
      })
      try {
        const wallet = await useActiveWallet()
        if (!current) return
        const address = await wallet.getReceiveAddress()
        if (current) displayAddress.value = activeChain.addressToString(address)
      } catch (err) {
        if (current) errorNotify(err, { fallbackKey: failedLoadKey })
      }
    },
    { immediate: true, flush: 'sync' },
  )
  return displayAddress
}
