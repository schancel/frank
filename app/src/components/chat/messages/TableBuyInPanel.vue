<template>
  <div class="table-buy-in q-mt-xs" data-testid="table-buy-in">
    <div
      v-if="lockLine"
      class="text-caption q-mb-xs"
      data-testid="table-buy-in-lock"
    >
      {{ lockLine }}
    </div>
    <div
      v-if="statusLine"
      class="text-caption q-mb-xs"
      :class="
        state.phase === 'failed' || state.phase === 'join-failed'
          ? 'text-negative'
          : 'text-grey-8'
      "
      data-testid="table-buy-in-status"
      role="status"
    >
      {{ statusLine }}
      <a
        v-if="txUrl"
        :href="txUrl"
        target="_blank"
        rel="noopener"
        class="q-ml-xs"
        >{{ $t('tableBuyIn.viewTransaction') }}</a
      >
    </div>
    <q-btn
      v-if="showJoin"
      dense
      no-caps
      color="positive"
      class="full-width q-mb-xs"
      :label="joinLabel"
      :loading="state.phase === 'working' && !refunding"
      :disable="state.phase === 'working'"
      data-testid="table-join-btn"
      @click="onJoin"
    />
    <q-btn
      v-if="buyIn.refundable.value"
      dense
      no-caps
      outline
      color="primary"
      class="full-width q-mb-xs"
      :label="$t('tableBuyIn.refund')"
      :loading="state.phase === 'working' && refunding"
      :disable="state.phase === 'working'"
      data-testid="table-refund-btn"
      @click="onRefund"
    />
  </div>
</template>

<script lang="ts">
import { defineComponent, type PropType } from 'vue'
import type {
  MessageItem,
  TableBuyInLockItem,
  TableEscrowItemTerms,
} from '@frank/cashweb/types/messages'
import { activeChain } from '@frank/wallet/chain'
import { useTableBuyIn } from '../../../composables/useTableBuyIn'
import type { TableGame } from '../../../games/table-buy-in-session'
import { formatDisplayAmount } from '../../../utils/chain-amount'
import { transactionExplorerUrl } from '../../../utils/explorer'

/** How often an open card reads its lock and the chain's time again, so the refund appears
 * once the deadline passes. */
const REFRESH_MS = 60_000

/**
 * A table's buy-in, on the newest card of the table: join (lock, then the structured join), the
 * state of this account's lock, and its refund from the deadline on. Shown only for a table
 * whose bot states an escrow.
 */
export default defineComponent({
  name: 'TableBuyInPanel',
  props: {
    game: { type: String as PropType<TableGame>, required: true },
    tableId: { type: String, required: true },
    buyInWei: { type: String, default: undefined },
    escrow: {
      type: Object as PropType<TableEscrowItemTerms>,
      default: undefined,
    },
    /** The table takes players now. */
    joinable: { type: Boolean, default: false },
    /** This account's identity holds a seat, as the bot's newest card says. */
    seated: { type: Boolean, default: false },
    /** The join item naming the lock. */
    joinItem: {
      type: Function as PropType<(lock: TableBuyInLockItem) => MessageItem>,
      required: true,
    },
  },
  emits: ['sendFollowUp'],
  setup(props) {
    const buyIn = useTableBuyIn({
      game: () => props.game,
      tableId: () => props.tableId,
      buyInWei: () => props.buyInWei,
      escrow: () => props.escrow,
    })
    return { buyIn, state: buyIn.state }
  },
  data() {
    return {
      refunding: false,
      timer: undefined as ReturnType<typeof setInterval> | undefined,
    }
  },
  computed: {
    buyInText(): string {
      return this.buyInWei
        ? formatDisplayAmount(activeChain, this.buyInWei)
        : ''
    },
    lockOpen(): boolean {
      return this.state.lock?.state === 'open'
    },
    showJoin(): boolean {
      if (!this.escrow || !this.buyInWei || this.seated) return false
      // A lock that is no longer open cannot seat anyone.
      if (this.state.lock && this.state.lock.state !== 'open') return false
      return (
        this.joinable ||
        this.state.phase === 'join-failed' ||
        this.state.phase === 'pending'
      )
    },
    joinLabel(): string {
      if (this.state.phase === 'pending')
        return this.$t('tableBuyIn.checkAgain')
      if (this.lockOpen || this.state.phase === 'join-failed')
        return this.$t('tableBuyIn.sendJoin')
      return this.$t('tableBuyIn.join', { amount: this.buyInText })
    },
    deadlineText(): string {
      const at = this.state.lock?.expiresAt ?? this.escrow?.expiresAt
      return at ? new Date(at * 1000).toLocaleString() : ''
    },
    lockLine(): string {
      const lock = this.state.lock
      if (!lock) return ''
      if (lock.state === 'refunded') return this.$t('tableBuyIn.lockRefunded')
      if (lock.state === 'withdrawn') return this.$t('tableBuyIn.lockPaidOut')
      return this.$t('tableBuyIn.lockOpen', {
        amount: this.buyInText,
        deadline: this.deadlineText,
      })
    },
    statusLine(): string {
      const { phase, progress, error } = this.state
      if (phase === 'working') {
        switch (progress?.stage) {
          case 'funding':
            return this.$t('tableBuyIn.funding', {
              amount: formatDisplayAmount(activeChain, progress.moveWei),
            })
          case 'locking':
            return this.$t('tableBuyIn.locking')
          case 'lock-sent':
            return this.$t('tableBuyIn.lockSent')
          case 'locked':
            return this.$t('tableBuyIn.joining')
          case 'refund-sent':
            return this.$t('tableBuyIn.refundSent')
          default:
            return this.$t('tableBuyIn.checking')
        }
      }
      if (phase === 'pending') return this.$t('tableBuyIn.pending')
      if (phase === 'join-failed') return this.$t('tableBuyIn.joinFailed')
      if (phase === 'join-sent') return this.$t('tableBuyIn.joinSent')
      if (phase === 'failed')
        return this.$t(`tableBuyIn.errors.${error ?? 'other'}`)
      return ''
    },
    txUrl(): string | undefined {
      return transactionExplorerUrl(
        this.state.txHash,
        activeChain.chainIdentifier,
      )
    },
  },
  mounted() {
    if (!this.escrow) return
    void this.buyIn.refresh()
    this.timer = setInterval(() => void this.buyIn.refresh(), REFRESH_MS)
  },
  beforeUnmount() {
    if (this.timer) clearInterval(this.timer)
  },
  methods: {
    onJoin() {
      this.refunding = false
      void this.buyIn.join(
        lock =>
          new Promise<boolean>(resolve => {
            this.$emit('sendFollowUp', {
              items: [this.joinItem(lock)],
              // The buy-in is locked on chain; the join message itself pays nothing.
              stampValueWei: 0n,
              settled: (sent: boolean) => resolve(sent),
            })
          }),
      )
    },
    onRefund() {
      this.refunding = true
      void this.buyIn.refund()
    },
  },
})
</script>
