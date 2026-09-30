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
      {{ $t('blackjackBet.notice', recipient) }}
    </div>
    <q-checkbox
      v-model="confirmed"
      class="q-mt-sm"
      dense
      data-testid="blackjack-bet-confirm"
      :label="$t('blackjackBet.confirm', { ...recipient, amount: amountText })"
      :disable="locked || !!unsentBlock"
    />
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
      :label="$t('blackjackBet.submit', { ...recipient, amount: amountText })"
      :loading="pending"
      :disable="locked || !!betError || !!unsentBlock || !confirmed"
    />
  </form>
</template>

<script lang="ts">
import { defineComponent, PropType } from 'vue'

import { MessageItem } from '@frank/cashweb/types/messages'
import { activeChain } from '@frank/wallet/chain'

import { useBalance } from '../../composables/useBalance'
import { useUnsentWagersStore } from '../../stores/unsent-wagers'
import {
  BetErrorCode,
  betFundsRequired,
  BET_MESSAGE_FEE_RESERVE_WEI,
  betLimitsDisplay,
  parseBetInput,
  sendBlackjackWager,
  shortAddress,
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
    /** The chat's display name, shown next to the address so the recipient is unmistakable. */
    dealerName: { type: String, default: '' },
    /** The stamp the bet message will pay; defaults to the chain's default stamp. */
    stampWei: {
      type: null as unknown as PropType<bigint | null>,
      default: null,
    },
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
      confirmed: false,
      actionError: '',
    }
  },
  computed: {
    locked(): boolean {
      return this.pending || this.busy
    },
    recipient(): { name: string; address: string } {
      return {
        name: this.dealerName || shortAddress(this.address),
        address: shortAddress(this.address),
      }
    },
    amountText(): string {
      return this.amountDisplay.trim()
    },
    /** A previous wager to this dealer was paid but its bet message is still undelivered. */
    unsentBlock(): string {
      return useUnsentWagersStore().forDealer(this.address).length
        ? this.$t('blackjackBet.errorUnsent')
        : ''
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
      // The wager is only half the cost: the bet MESSAGE needs its stamp and fees too, and a
      // wager paid with no funds left to send the message is stranded. An unknown balance blocks
      // (fail closed) rather than guessing.
      if (this.balance === null)
        return this.$t('blackjackBet.errorBalanceUnknown')
      const stampWei = this.stampWei ?? activeChain.defaultStampValue
      const needed = betFundsRequired(parsed.wei, stampWei)
      if (needed > this.balance) {
        return this.$t('blackjackBet.errorBalance', {
          needed: activeChain.toDisplayAmount(needed),
          rest: activeChain.toDisplayAmount(
            stampWei + BET_MESSAGE_FEE_RESERVE_WEI,
          ),
          balance: activeChain.toDisplayAmount(this.balance),
        })
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
      this.confirmed = false
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
      if (!parsed.ok || this.betError || this.unsentBlock || !this.confirmed) {
        this.focusInput()
        return
      }
      this.pending = true
      this.sent = false
      this.confirmed = false
      this.actionError = ''
      const submit = this.submit
      const address = this.address
      const unsent = useUnsentWagersStore()
      let betItem: Awaited<ReturnType<typeof sendBlackjackWager>>
      try {
        betItem = await sendBlackjackWager(address, parsed.wei)
      } catch (err) {
        // Nothing was paid: a plain failure the player can retry.
        const error = err instanceof Error ? err : new Error(String(err))
        this.actionError = /insufficient/i.test(error.message)
          ? this.$t('blackjackBet.errorFunds', { message: error.message })
          : this.$t('blackjackBet.errorSend', { message: error.message })
        errorNotify(error)
        this.focusInput()
        this.pending = false
        return
      }
      // The wager is PAID. From here every failure must leave a durable, retryable record: the
      // dealer only acts on messages it receives, so an unrecorded wager would be stranded.
      const hash = betItem.wagerTxHash as string
      let saveFailed = false
      try {
        await unsent.restored
        unsent.add({
          gameId: betItem.gameId,
          wagerTxHash: hash,
          dealerAddress: address,
          amountWei: parsed.wei.toString(),
          createdAt: Date.now(),
        })
        unsent.setInFlight(hash, true)
        await unsent.flushPersistence()
      } catch {
        saveFailed = true
      }
      try {
        await submit({ items: [betItem], address })
        unsent.remove(hash)
        this.sent = true
        this.$emit('placed')
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err))
        unsent.setInFlight(hash, false)
        this.actionError = this.$t('blackjackBet.notDelivered', {
          message: `${error.message}${
            saveFailed ? ` (wager transaction ${hash}, not saved locally)` : ''
          }`,
        })
        errorNotify(error)
      } finally {
        this.pending = false
      }
    },
  },
})
</script>
