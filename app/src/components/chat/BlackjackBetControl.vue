<template>
  <form
    class="blackjack-bet-control q-pa-sm"
    style="min-width: 220px"
    :aria-busy="pending ? 'true' : 'false'"
    novalidate
    @submit.prevent="placeBet"
  >
    <div class="text-subtitle2">
      {{ title || $t('blackjackBet.title') }}
    </div>
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
    <div
      v-if="lowBalance"
      class="text-caption q-mt-xs"
      data-testid="blackjack-bet-faucet-hint"
    >
      {{ $t('blackjackBet.faucetHint') }}
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

import { BlackjackMoveItem, MessageItem } from '@frank/cashweb/types/messages'
import { activeChain } from '@frank/wallet/chain'

import { useBalance } from '../../composables/useBalance'
import { useUnsentWagersStore } from '../../stores/unsent-wagers'
import { getOwnCanonicalAddress } from '../../utils/own-address'
import {
  awaitPayment,
  BetErrorCode,
  BlackjackTable,
  betFundsRequired,
  betMessageCostWei,
  checkWagerStatus,
  DEFAULT_BLACKJACK_TABLE,
  WagerBroadcastError,
  betLimitsDisplay,
  defaultBetDisplay,
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

/**
 * The inline bet control shown inside the dealer's bubbles (#395): the welcome (a new player's first
 * bet) and a resolved hand ("Play again"). It is the ONLY place a blackjack wager is paid from, so
 * every bet gets the same safety:
 *
 * - an explicit confirmation naming the recipient and the amount, and a balance check of
 *   bet + stamp + fee reserve (an unknown balance blocks);
 * - the wager record is persisted BEFORE any byte is broadcast (the wallet's `onSigned` hook), then
 *   a bounded wait for the receipt, then the bet message; the record stays until the dealer's reply
 *   proves it (the chat's unsent-wager banner retries the SAME wager/gameId, never a new transfer);
 * - `pending` is set synchronously before anything is awaited, so a double click, Enter-then-click
 *   or a second submit while the transfer or the message is in flight is a no-op: one submit creates
 *   exactly one transfer and one `bet` item. The parent's `submit` is awaited (not an emitted
 *   event) so the bet message is still delivered if this component unmounts while the transfer is
 *   confirming.
 *
 * It sends the wager as a plain, separately verified value transfer (`sendBlackjackWager`) followed
 * by a `bet` move that names it; the dealer bot and `reduceBlackjackState` are unchanged. The table
 * limits come from the dealer's latest `welcome` (`table` prop), or the documented fallback.
 */
export default defineComponent({
  name: 'BlackjackBetControl',
  props: {
    address: { type: String, required: true },
    /** Heading; defaults to "Start a blackjack hand". */
    title: { type: String, default: '' },
    /** The table limits and fee hint the bet is validated against (the dealer's latest welcome). */
    table: {
      type: Object as PropType<BlackjackTable>,
      default: () => DEFAULT_BLACKJACK_TABLE,
    },
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
    /** How long to wait for the wager's receipt before handing the record to the chat banner. */
    paymentTimeoutMs: { type: Number, default: undefined },
    paymentPollMs: { type: Number, default: undefined },
  },
  emits: ['placed', 'pendingChange'],
  setup() {
    const { balance } = useBalance()
    return { balance }
  },
  data() {
    return {
      amountDisplay: defaultBetDisplay(this.table),
      pending: false,
      phase: '' as '' | 'confirming',
      sent: false,
      confirmed: false,
      walletAddress: '',
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
      return useUnsentWagersStore().forDealer(this.address, this.walletAddress)
        .length
        ? this.$t('blackjackBet.errorUnsent')
        : ''
    },
    limitsHint(): string {
      return this.$t('blackjackBet.limits', betLimitsDisplay(this.table))
    },
    /** The balance is known and does not cover the bet plus the message costs. */
    lowBalance(): boolean {
      const parsed = parseBetInput(
        display => activeChain.fromDisplayAmount(display),
        this.amountDisplay,
        this.table,
      )
      if (!parsed.ok || this.balance === null) return false
      const stampWei = this.stampWei ?? activeChain.defaultStampValue
      return (
        betFundsRequired(parsed.wei, stampWei, this.table.feeHintWei) >
        this.balance
      )
    },
    betError(): string {
      const parsed = parseBetInput(
        display => activeChain.fromDisplayAmount(display),
        this.amountDisplay,
        this.table,
      )
      if (!parsed.ok) {
        return this.$t(ERROR_KEYS[parsed.code], betLimitsDisplay(this.table))
      }
      // The wager is only half the cost: the bet MESSAGE needs its stamp and fees too, and a
      // wager paid with no funds left to send the message is stranded. An unknown balance blocks
      // (fail closed) rather than guessing.
      if (this.balance === null)
        return this.$t('blackjackBet.errorBalanceUnknown')
      const stampWei = this.stampWei ?? activeChain.defaultStampValue
      const needed = betFundsRequired(
        parsed.wei,
        stampWei,
        this.table.feeHintWei,
      )
      if (needed > this.balance) {
        return this.$t('blackjackBet.errorBalance', {
          needed: activeChain.toDisplayAmount(needed),
          rest: activeChain.toDisplayAmount(
            betMessageCostWei(stampWei, this.table.feeHintWei),
          ),
          balance: activeChain.toDisplayAmount(this.balance),
        })
      }
      return ''
    },
    statusText(): string {
      if (this.actionError) return this.actionError
      if (this.phase === 'confirming') return this.$t('blackjackBet.confirming')
      if (this.pending) return this.$t('blackjackBet.sending')
      return this.sent ? this.$t('blackjackBet.sent') : ''
    },
  },
  async created() {
    this.walletAddress = (await getOwnCanonicalAddress()) ?? ''
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
        this.table,
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
      const fail = (err: unknown, key: string) => {
        const error = err instanceof Error ? err : new Error(String(err))
        this.actionError = this.$t(
          /insufficient/i.test(error.message) ? 'blackjackBet.errorFunds' : key,
          { message: error.message },
        )
        errorNotify(error)
      }

      // 1. Pay. The record is persisted BEFORE any byte is broadcast (onSigned), so a lost
      // broadcast response or a killed app can never leave a paid wager without a record.
      let hash = ''
      let betItem: BlackjackMoveItem | undefined
      // Set only after THIS attempt's record exists, so a pre-broadcast failure drops that
      // record and never some other chat's in-flight wager (#422 F2).
      let attemptHash: string | undefined
      try {
        betItem = await sendBlackjackWager(address, parsed.wei, {
          onSigned: async info => {
            await unsent.restored
            unsent.add({
              gameId: info.gameId,
              walletAddress: info.walletAddress,
              wagerTxHash: info.txHash,
              dealerAddress: address,
              amountWei: parsed.wei.toString(),
              createdAt: Date.now(),
              state: 'signed',
            })
            unsent.setInFlight(info.txHash, true)
            attemptHash = info.txHash
            // A failed flush rejects here, which aborts the broadcast: nothing is paid.
            await unsent.flushPersistence()
          },
        })
        hash = betItem.wagerTxHash as string
      } catch (err) {
        if (err instanceof WagerBroadcastError) {
          // Signed and recorded, but the broadcast outcome is unknown: reconcile with the node
          // below. NEVER claim nothing was paid from here on.
          hash = err.txHash
        } else {
          // Nothing was broadcast (signing, funds, or the record could not be saved first).
          if (attemptHash) unsent.remove(attemptHash)
          fail(err, 'blackjackBet.errorSend')
          this.focusInput()
          this.pending = false
          return
        }
      }

      // 2. Wait (bounded) for the receipt: the dealer drops a bet whose payment it cannot verify
      // yet, so the bet message must not go out before the wager is mined.
      this.phase = 'confirming'
      const status = await awaitPayment(() => checkWagerStatus(hash), {
        timeoutMs: this.paymentTimeoutMs,
        pollMs: this.paymentPollMs,
      })
      this.phase = ''
      if (status === 'failed') {
        unsent.remove(hash)
        this.actionError = this.$t('blackjackBet.errorPaymentFailed')
        this.pending = false
        return
      }
      if (status !== 'confirmed') {
        // Still pending, or the node does not know it (yet): keep the record for the chat banner
        // to reconcile; say exactly that, never "nothing was paid".
        unsent.setInFlight(hash, false)
        this.actionError = this.$t(
          status === 'pending'
            ? 'blackjackBet.paymentPending'
            : 'blackjackBet.paymentUnknown',
        )
        this.pending = false
        return
      }
      unsent.setState(hash, 'paid')

      // 3. Deliver the bet for THIS wager. The record stays until the dealer's reply proves it.
      const item = betItem ?? {
        type: 'blackjack-move' as const,
        gameId: unsent.wagers.find(w => w.wagerTxHash === hash)?.gameId ?? '',
        action: 'bet' as const,
        wagerTxHash: hash,
      }
      try {
        await submit({ items: [item], address })
        unsent.setState(hash, 'sent', Date.now())
        unsent.setInFlight(hash, false)
        this.sent = true
        this.$emit('placed')
      } catch (err) {
        unsent.setInFlight(hash, false)
        fail(err, 'blackjackBet.notDelivered')
      } finally {
        this.pending = false
      }
    },
  },
})
</script>
