<template>
  <div v-if="views.length || store.loadError || notice" class="q-px-md q-pt-sm">
    <div
      v-if="store.loadError"
      class="bg-negative text-white q-pa-sm q-mb-xs rounded-borders"
      role="alert"
      data-testid="blackjack-unsent-load-error"
    >
      {{ $t('blackjackBet.loadError', { message: store.loadError }) }}
    </div>
    <div
      role="status"
      aria-live="polite"
      class="text-caption"
      data-testid="blackjack-unsent-notice"
    >
      {{ notice }}
    </div>
    <div
      v-for="view in views"
      :key="view.wager.wagerTxHash"
      class="blackjack-unsent bg-warning text-black q-pa-sm q-mb-xs rounded-borders"
      data-testid="blackjack-unsent"
      role="group"
      :aria-label="titleFor(view)"
    >
      <div class="text-weight-bold">{{ titleFor(view) }}</div>
      <div class="text-caption">{{ bodyFor(view) }}</div>
      <div class="text-caption" style="overflow-wrap: anywhere">
        {{ $t('blackjackBet.unsentTx', { hash: view.wager.wagerTxHash }) }}
      </div>
      <div
        role="status"
        aria-live="polite"
        class="text-caption text-negative"
        data-testid="blackjack-unsent-status"
      >
        {{ statusText(view.wager) }}
      </div>
      <div v-if="dismissing.includes(view.wager.wagerTxHash)" role="alert">
        <div class="text-caption text-weight-bold">
          {{ $t('blackjackBet.dismissWarning') }}
        </div>
        <q-btn
          dense
          color="negative"
          class="q-mr-sm"
          data-testid="blackjack-unsent-dismiss-confirm"
          :label="$t('blackjackBet.dismissConfirm')"
          @click="dismiss(view.wager)"
        />
        <q-btn
          dense
          flat
          :label="$t('blackjackBet.dismissCancel')"
          @click="cancelDismiss(view.wager)"
        />
      </div>
      <div v-else class="q-gutter-sm">
        <q-btn
          v-if="view.wager.state === 'signed'"
          dense
          color="primary"
          data-testid="blackjack-unsent-check"
          :label="$t('blackjackBet.checkPayment')"
          :loading="busyHashes.includes(view.wager.wagerTxHash)"
          :disable="busyHashes.includes(view.wager.wagerTxHash)"
          @click="checkPayment(view.wager)"
        />
        <q-btn
          v-else
          dense
          color="primary"
          data-testid="blackjack-unsent-retry"
          :label="$t('blackjackBet.unsentRetry')"
          :loading="busyHashes.includes(view.wager.wagerTxHash)"
          :disable="busyHashes.includes(view.wager.wagerTxHash)"
          @click="retry(view.wager)"
        />
        <q-btn
          dense
          flat
          data-testid="blackjack-unsent-dismiss"
          :label="$t('blackjackBet.dismiss')"
          :disable="busyHashes.includes(view.wager.wagerTxHash)"
          @click="startDismiss(view.wager)"
        />
      </div>
    </div>
  </div>
</template>

<script lang="ts">
import { defineComponent, PropType } from 'vue'

import { MessageItem } from '@frank/cashweb/types/messages'
import { activeChain } from '@frank/wallet/chain'

import { useChatStore } from '../../stores/chats'
import { UnsentWager, useUnsentWagersStore } from '../../stores/unsent-wagers'
import {
  checkWagerStatus,
  dealerReplyFor,
  DealerReply,
  shortAddress,
  wagerMove,
} from '../../utils/blackjack-bet'
import { getOwnCanonicalAddress } from '../../utils/own-address'

/** How long a delivered bet may go unanswered before the player is offered a Retry. */
export const DEALER_SILENCE_MS = 90_000

interface View {
  wager: UnsentWager
  kind: 'signed' | 'paid' | 'unconfirmed' | 'silent'
}

/**
 * Every blackjack wager to this chat whose outcome at the dealer is not yet proven (#310), each
 * with its transaction hash and the action that fits its state:
 * - `signed` (payment may not be on chain): "Check payment" asks the node (run automatically once
 *   per record when this appears, so a reload reconciles). Mined -> `paid`; failed -> removed;
 *   pending/unknown -> says so, and only an explicit warned "discard" removes it. It never says
 *   nothing was paid on its own.
 * - `paid` / `sent` needing attention (dealer said "unconfirmed", or silent for a while): Retry
 *   re-sends the bet message for the SAME wager transaction and gameId (a duplicate is answered
 *   "already authorized"; it can never start a second game or charge) and NEVER builds a new
 *   transfer.
 * A `sent` record is removed only when the dealer's reply proves it (a hand for the game, or an
 *   "already authorized" / rejection reply; the bot refunds rejected stakes).
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
    return { store: useUnsentWagersStore() }
  },
  data() {
    return {
      walletAddress: '',
      busyHashes: [] as string[],
      dismissing: [] as string[],
      failures: {} as Record<string, string>,
      notice: '',
      now: Date.now(),
      timer: undefined as ReturnType<typeof setInterval> | undefined,
      autoChecked: [] as string[],
    }
  },
  computed: {
    messages(): Array<{
      outbound: boolean
      items: Array<Record<string, any>>
    }> {
      return (useChatStore().chats[this.address]?.messages ?? []) as never
    },
    replies(): Record<string, DealerReply> {
      const out: Record<string, DealerReply> = {}
      for (const w of this.store.forDealer(this.address, this.walletAddress)) {
        if (w.state === 'sent')
          out[w.wagerTxHash] = dealerReplyFor(
            this.messages.slice(w.seenMessages ?? 0),
            w.gameId,
            w.kind,
          )
      }
      return out
    },
    views(): View[] {
      const out: View[] = []
      for (const wager of this.store.forDealer(
        this.address,
        this.walletAddress,
      )) {
        if (this.store.inFlight.includes(wager.wagerTxHash)) continue
        if (wager.state === 'signed' || wager.state === 'paid') {
          out.push({ wager, kind: wager.state })
          continue
        }
        const reply = this.replies[wager.wagerTxHash]
        if (reply === 'unconfirmed') out.push({ wager, kind: 'unconfirmed' })
        else if (
          reply === 'none' &&
          this.now - (wager.sentAt ?? 0) > DEALER_SILENCE_MS
        ) {
          out.push({ wager, kind: 'silent' })
        }
      }
      return out
    },
  },
  watch: {
    // The dealer's reply proves a delivered bet: only then is the record forgotten.
    replies: {
      immediate: true,
      handler(replies: Record<string, DealerReply>) {
        for (const [hash, reply] of Object.entries(replies)) {
          if (reply === 'accepted' || reply === 'rejected') {
            this.store.remove(hash)
          }
        }
      },
    },
    // After a reload, reconcile every payment that was signed but never confirmed.
    views: {
      immediate: true,
      handler(views: View[]) {
        for (const view of views) {
          const hash = view.wager.wagerTxHash
          if (view.kind === 'signed' && !this.autoChecked.includes(hash)) {
            this.autoChecked.push(hash)
            void this.checkPayment(view.wager)
          }
        }
      },
    },
  },
  async created() {
    this.walletAddress = (await getOwnCanonicalAddress()) ?? ''
  },
  mounted() {
    this.timer = setInterval(() => (this.now = Date.now()), 15_000)
  },
  beforeUnmount() {
    if (this.timer !== undefined) clearInterval(this.timer)
  },
  methods: {
    displayAmount(wager: UnsentWager): string {
      return activeChain.toDisplayAmount(BigInt(wager.amountWei))
    },
    params(wager: UnsentWager) {
      return {
        amount: this.displayAmount(wager),
        name: this.name || shortAddress(this.address),
        address: shortAddress(this.address),
      }
    },
    titleFor(view: View): string {
      if (view.wager.kind === 'double' && view.kind === 'paid')
        return this.$t('blackjackBet.doublePaidTitle')
      switch (view.kind) {
        case 'signed':
          return this.$t('blackjackBet.unsentSigned')
        case 'silent':
          return this.$t('blackjackBet.unsentDealerSilent')
        case 'unconfirmed':
          return this.$t('blackjackBet.unsentDealerUnconfirmed')
        default:
          return this.$t('blackjackBet.unsentTitle')
      }
    },
    bodyFor(view: View): string {
      const params = this.params(view.wager)
      if (view.wager.kind === 'double') {
        return this.$t(
          view.kind === 'signed'
            ? 'blackjackBet.doubleSignedBody'
            : 'blackjackBet.doublePendingBody',
          params,
        )
      }
      switch (view.kind) {
        case 'signed':
          return this.$t('blackjackBet.unsentSignedBody', params)
        case 'silent':
        case 'unconfirmed':
          return this.$t('blackjackBet.unsentDealerSilentBody', params)
        default:
          return this.$t('blackjackBet.unsentBody', params)
      }
    },
    statusText(wager: UnsentWager): string {
      if (this.busyHashes.includes(wager.wagerTxHash)) {
        return this.$t('blackjackBet.checking')
      }
      return this.failures[wager.wagerTxHash] ?? ''
    },
    startDismiss(wager: UnsentWager) {
      this.dismissing = [...this.dismissing, wager.wagerTxHash]
    },
    cancelDismiss(wager: UnsentWager) {
      this.dismissing = this.dismissing.filter(h => h !== wager.wagerTxHash)
    },
    /** Explicit, warned discard (the only way out of a record the network never confirms). */
    dismiss(wager: UnsentWager) {
      this.store.remove(wager.wagerTxHash)
      this.cancelDismiss(wager)
    },
    async checkPayment(wager: UnsentWager) {
      const hash = wager.wagerTxHash
      if (this.busyHashes.includes(hash)) return
      this.busyHashes = [...this.busyHashes, hash]
      delete this.failures[hash]
      try {
        const status = await checkWagerStatus(hash)
        if (status === 'confirmed') {
          this.store.setState(hash, 'paid')
        } else if (status === 'failed') {
          this.store.remove(hash)
          this.notice = this.$t('blackjackBet.paymentFailedRemoved')
        } else {
          this.failures[hash] = this.$t(
            status === 'pending'
              ? 'blackjackBet.paymentStillPending'
              : 'blackjackBet.paymentNotFound',
          )
        }
      } catch (err) {
        this.failures[hash] = this.$t('blackjackBet.unsentFailed', {
          message: err instanceof Error ? err.message : String(err),
        })
      } finally {
        this.busyHashes = this.busyHashes.filter(h => h !== hash)
      }
    },
    async retry(wager: UnsentWager) {
      const hash = wager.wagerTxHash
      // Synchronous re-entrancy guard: a double click re-sends at most once at a time.
      if (this.busyHashes.includes(hash) || this.store.inFlight.includes(hash))
        return
      this.busyHashes = [...this.busyHashes, hash]
      delete this.failures[hash]
      this.store.setInFlight(hash, true)
      try {
        if (
          wager.kind === 'double' &&
          (await getOwnCanonicalAddress())?.toLowerCase() !==
            wager.walletAddress.toLowerCase()
        ) {
          throw new Error(this.$t('blackjackBet.doubleUnavailable'))
        }
        // Capture before submission: a reply can arrive while the relay call is settling.
        const seenMessages = wager.seenMessages ?? this.messages.length
        if (wager.kind === 'double') {
          this.store.setState(hash, 'paid', undefined, seenMessages)
          await this.store.flushPersistence()
        }
        await this.submit({
          address: wager.dealerAddress,
          items: [wagerMove(wager)],
        })
        // Delivered, not proven: the record stays until the dealer's reply arrives.
        this.store.setState(hash, 'sent', Date.now(), seenMessages)
      } catch (err) {
        this.failures[hash] = this.$t('blackjackBet.unsentFailed', {
          message: err instanceof Error ? err.message : String(err),
        })
      } finally {
        this.store.setInFlight(hash, false)
        this.busyHashes = this.busyHashes.filter(h => h !== hash)
      }
    },
  },
})
</script>
