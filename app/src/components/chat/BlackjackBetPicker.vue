<template>
  <form
    class="blackjack-bet-picker q-pa-md"
    style="min-width: 280px"
    :aria-busy="pending ? 'true' : 'false'"
    novalidate
    @submit.prevent="placeBet"
  >
    <div class="text-subtitle2">{{ $t('blackjackBet.title') }}</div>
    <q-input
      ref="betInput"
      v-model="amountDisplay"
      class="q-mt-sm"
      dense
      outlined
      autofocus
      type="text"
      inputmode="decimal"
      autocomplete="off"
      suffix="MON"
      :label="$t('blackjackBet.amountLabel')"
      :input-attrs="{ 'aria-label': $t('blackjackBet.amountAria') }"
      :hint="limitsHint"
      :error="!!betError"
      :error-message="betError"
      :disable="locked"
    />
    <div class="text-caption text-grey-7 q-mt-sm">
      {{ $t('blackjackBet.notice') }}
    </div>
    <!-- Always present so screen readers hear the pending / sent / failed transitions. -->
    <div
      role="status"
      aria-live="polite"
      class="text-caption q-mt-sm"
      :class="actionError ? 'text-negative' : ''"
      data-testid="blackjack-bet-status"
    >
      {{ statusText }}
    </div>
    <q-btn
      class="q-mt-sm"
      type="submit"
      dense
      color="primary"
      data-testid="blackjack-bet-submit"
      :label="$t('blackjackBet.submit', { amount: amountDisplay.trim() })"
      :loading="pending"
      :disable="locked || !!betError"
    />
  </form>
</template>

<script lang="ts">
import { defineComponent, PropType } from 'vue'

import { MessageItem } from '@frank/cashweb/types/messages'
import { activeChain } from '@frank/wallet/chain'

import { useBalance } from '../../composables/useBalance'
import {
  BetErrorCode,
  betLimitsDisplay,
  parseBetInput,
  sendBlackjackWager,
} from '../../utils/blackjack-bet'
import { errorNotify } from '../../utils/notifications'

const ERROR_KEYS: Record<BetErrorCode, string> = {
  format: 'blackjackBet.errorFormat',
  invalid: 'blackjackBet.errorInvalid',
  zero: 'blackjackBet.errorZero',
  min: 'blackjackBet.errorMin',
  max: 'blackjackBet.errorMax',
}

// Comfortably above the relay's stamp minimum and the table minimum, so a first-try default is
// never rejected as "below the table minimum".
const DEFAULT_BET_AMOUNT_DISPLAY = '0.1'

/**
 * The first-bet entry point: lets a player with no hand in progress (a new player) pick a wager
 * and start a blackjack game with the dealer of this chat.
 *
 * It sends the wager as the same plain, separately verified value transfer the in-bubble bet form
 * uses (`sendBlackjackWager`) followed by a `bet` move that names that transfer; the dealer bot and
 * `reduceBlackjackState` are unchanged. The table limits are the shared documented defaults (the
 * dealer advertises none, see `game.ts`).
 *
 * Money safety: `pending` is set synchronously before anything is awaited, so a double click,
 * Enter-then-click or a second submit while the transfer or the message is in flight is a no-op;
 * one submit creates exactly one transfer and one `bet` item. The parent's `submit` is awaited
 * (not an emitted event) so the bet message is still delivered if this component unmounts while
 * the transfer is confirming.
 */
export default defineComponent({
  name: 'BlackjackBetPicker',
  props: {
    address: { type: String, required: true },
    /** Sends the follow-up items through the chat's own send pipeline. */
    submit: {
      type: Function as PropType<
        (payload: { items: MessageItem[]; address: string }) => Promise<void>
      >,
      required: true,
    },
    /** The chat is already sending something; hold off starting a new transfer. */
    busy: { type: Boolean, default: false },
  },
  emits: ['placed', 'pendingChange'],
  setup() {
    const { balance } = useBalance()
    return { balance }
  },
  data() {
    return {
      amountDisplay: DEFAULT_BET_AMOUNT_DISPLAY,
      pending: false,
      sent: false,
      actionError: '',
    }
  },
  computed: {
    locked(): boolean {
      return this.pending || this.busy
    },
    limitsHint(): string {
      return this.$t('blackjackBet.limits', betLimitsDisplay())
    },
    betError(): string {
      const parsed = parseBetInput(
        display => activeChain.fromDisplayAmount(display),
        this.amountDisplay,
      )
      if (!parsed.ok) {
        return this.$t(ERROR_KEYS[parsed.code], betLimitsDisplay())
      }
      // An unknown (not yet loaded) balance never blocks: the transfer itself refuses when the
      // wallet cannot cover the bet plus fees.
      if (this.balance !== null && parsed.wei > this.balance) {
        return this.$t('blackjackBet.errorBalance')
      }
      return ''
    },
    statusText(): string {
      if (this.actionError) return this.actionError
      if (this.pending) return this.$t('blackjackBet.sending')
      return this.sent ? this.$t('blackjackBet.sent') : ''
    },
  },
  watch: {
    pending(value: boolean) {
      this.$emit('pendingChange', value)
    },
    // Editing the amount after a send or failure starts over.
    amountDisplay() {
      this.sent = false
      this.actionError = ''
    },
  },
  methods: {
    focusInput() {
      const input = this.$refs.betInput as { focus?: () => void } | undefined
      void this.$nextTick(() => input?.focus?.())
    },
    async placeBet() {
      if (this.locked) return
      const parsed = parseBetInput(
        display => activeChain.fromDisplayAmount(display),
        this.amountDisplay,
      )
      if (!parsed.ok || this.betError) {
        this.focusInput()
        return
      }
      this.pending = true
      this.sent = false
      this.actionError = ''
      const submit = this.submit
      const address = this.address
      try {
        const betItem = await sendBlackjackWager(this.address, parsed.wei)
        await submit({ items: [betItem], address })
        this.sent = true
        this.$emit('placed')
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err))
        this.actionError = /insufficient/i.test(error.message)
          ? this.$t('blackjackBet.errorFunds', { message: error.message })
          : this.$t('blackjackBet.errorSend', { message: error.message })
        errorNotify(error)
        this.focusInput()
      } finally {
        this.pending = false
      }
    },
  },
})
</script>
