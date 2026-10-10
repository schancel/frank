<template>
  <!-- Payments to contacts that are not finished: signed, their funds held for them. -->
  <q-list
    v-if="payments.length > 0"
    bordered
    separator
    class="q-mt-md rounded-borders"
    data-testid="held-contact-payments"
  >
    <q-item-label header>{{ $t('heldContactPayments.title') }}</q-item-label>
    <q-item
      v-for="payment in payments"
      :key="payment.ephemeralPubKey"
      data-testid="held-contact-payment"
    >
      <q-item-section>
        <q-item-label data-testid="held-contact-payment-amount">
          {{ amountOf(payment) }}
        </q-item-label>
        <q-item-label caption data-testid="held-contact-payment-state">
          {{ $t(`heldContactPayments.state.${payment.state}`) }}
        </q-item-label>
      </q-item-section>
      <q-item-section side>
        <q-btn
          flat
          no-caps
          color="primary"
          :loading="busy === payment.ephemeralPubKey"
          :disable="busy !== ''"
          :label="$t('heldContactPayments.finish')"
          data-testid="held-contact-payment-finish"
          @click="finish(payment)"
        />
      </q-item-section>
    </q-item>
  </q-list>
</template>

<script lang="ts">
import { defineComponent, onBeforeUnmount, onMounted, ref } from 'vue'
import { activeChain } from '@frank/wallet/chain'
import type { ContactPaymentInfo } from '@frank/wallet/chain'
import { useActiveWallet } from 'src/composables/useActiveWallet'
import { errorNotify } from 'src/utils/notifications'

/** How often the list is read again from the wallet (no request is made by reading it). */
export const HELD_PAYMENTS_REFRESH_MS = 5_000

/**
 * A payment to a contact that is not finished holds the account it is paid from. This lists
 * those payments with the wallet's own state for each, and lets the user have the wallet bring
 * one to an end: released if nothing of it was ever sent, delivered and paid otherwise. The
 * component decides nothing: `settleContactPayment` does.
 */
export default defineComponent({
  name: 'HeldContactPayments',
  props: {
    refreshMs: { type: Number, default: HELD_PAYMENTS_REFRESH_MS },
  },
  setup(props) {
    const payments = ref<ContactPaymentInfo[]>([])
    const busy = ref('')
    let timer: ReturnType<typeof setInterval> | undefined
    let stopped = false

    const read = async () => {
      try {
        const wallet = await useActiveWallet()
        if (stopped) return
        payments.value = (wallet.getContactPayments?.() ?? []).filter(
          payment =>
            payment.state === 'prepared' ||
            payment.state === 'delivered' ||
            payment.state === 'failed',
        )
      } catch {
        // No wallet yet: nothing to list.
      }
    }
    const finish = async (payment: ContactPaymentInfo) => {
      busy.value = payment.ephemeralPubKey
      try {
        const wallet = await useActiveWallet()
        await wallet.settleContactPayment?.(payment.ephemeralPubKey)
      } catch (error) {
        errorNotify(error)
      } finally {
        busy.value = ''
        await read()
      }
    }
    const amountOf = (payment: ContactPaymentInfo) =>
      `${activeChain.toDisplayAmount(payment.valueWei)} ${activeChain.unit}`

    onMounted(() => {
      void read()
      timer = setInterval(() => void read(), props.refreshMs)
      // Under Node (tests) a forgotten mount must not keep the process alive.
      ;(timer as { unref?: () => void }).unref?.()
    })
    onBeforeUnmount(() => {
      stopped = true
      if (timer !== undefined) clearInterval(timer)
    })
    return { payments, busy, finish, amountOf }
  },
})
</script>
