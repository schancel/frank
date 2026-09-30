<template>
  <div v-if="wagers.length" class="q-px-md q-pt-sm">
    <div
      v-for="wager in wagers"
      :key="wager.wagerTxHash"
      class="blackjack-unsent bg-warning text-black q-pa-sm q-mb-xs rounded-borders"
      data-testid="blackjack-unsent"
      role="group"
      :aria-label="$t('blackjackBet.unsentTitle')"
    >
      <div class="text-weight-bold">{{ $t('blackjackBet.unsentTitle') }}</div>
      <div class="text-caption">
        {{
          $t('blackjackBet.unsentBody', {
            amount: displayAmount(wager),
            name: name || shortAddress(address),
            address: shortAddress(address),
          })
        }}
      </div>
      <div class="text-caption" style="overflow-wrap: anywhere">
        {{ $t('blackjackBet.unsentTx', { hash: wager.wagerTxHash }) }}
      </div>
      <div
        role="status"
        aria-live="polite"
        class="text-caption text-negative"
        data-testid="blackjack-unsent-status"
      >
        {{ statusText(wager) }}
      </div>
      <q-btn
        dense
        color="primary"
        data-testid="blackjack-unsent-retry"
        :label="$t('blackjackBet.unsentRetry')"
        :loading="retrying.includes(wager.wagerTxHash)"
        :disable="retrying.includes(wager.wagerTxHash)"
        @click="retry(wager)"
      />
    </div>
  </div>
</template>

<script lang="ts">
import { defineComponent, PropType } from 'vue'

import { MessageItem } from '@frank/cashweb/types/messages'
import { activeChain } from '@frank/wallet/chain'

import { UnsentWager, useUnsentWagersStore } from '../../stores/unsent-wagers'
import { shortAddress } from '../../utils/blackjack-bet'

/**
 * Shows every blackjack wager to this chat that was paid but whose `bet` message is not confirmed
 * delivered (#310), with the transaction hash and a Retry. Retry re-sends the bet message for the
 * SAME wager transaction and gameId (the dealer treats a duplicate as "already authorized", so it
 * can never start a second game or charge a second stake); it NEVER builds a new wager transfer.
 */
export default defineComponent({
  name: 'BlackjackUnsentWagers',
  props: {
    address: { type: String, required: true },
    name: { type: String, default: '' },
    submit: {
      type: Function as PropType<
        (payload: { items: MessageItem[]; address: string }) => Promise<void>
      >,
      required: true,
    },
  },
  setup() {
    return { unsent: useUnsentWagersStore() }
  },
  data() {
    return { retrying: [] as string[], failures: {} as Record<string, string> }
  },
  computed: {
    wagers(): UnsentWager[] {
      return this.unsent.stranded(this.address)
    },
  },
  methods: {
    shortAddress,
    displayAmount(wager: UnsentWager): string {
      return activeChain.toDisplayAmount(BigInt(wager.amountWei))
    },
    statusText(wager: UnsentWager): string {
      if (this.retrying.includes(wager.wagerTxHash)) {
        return this.$t('blackjackBet.unsentRetrying')
      }
      const failure = this.failures[wager.wagerTxHash]
      return failure
        ? this.$t('blackjackBet.unsentFailed', { message: failure })
        : ''
    },
    async retry(wager: UnsentWager) {
      // Synchronous re-entrancy guard: a double click re-sends at most once at a time.
      if (this.retrying.includes(wager.wagerTxHash)) return
      this.retrying.push(wager.wagerTxHash)
      delete this.failures[wager.wagerTxHash]
      this.unsent.setInFlight(wager.wagerTxHash, true)
      try {
        await this.submit({
          address: wager.dealerAddress,
          items: [
            {
              type: 'blackjack-move',
              gameId: wager.gameId,
              action: 'bet',
              wagerTxHash: wager.wagerTxHash,
            },
          ],
        })
        this.unsent.remove(wager.wagerTxHash)
      } catch (err) {
        this.unsent.setInFlight(wager.wagerTxHash, false)
        this.failures[wager.wagerTxHash] =
          err instanceof Error ? err.message : String(err)
      } finally {
        this.retrying = this.retrying.filter(h => h !== wager.wagerTxHash)
      }
    },
  },
})
</script>
