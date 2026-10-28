<template>
  <!-- Where the balance is: one row per place the wallet holds money, then their sum. -->
  <div class="balance-breakdown" data-testid="balance-breakdown">
    <div
      v-if="state === 'loading'"
      class="row justify-center q-py-sm"
      data-testid="balance-breakdown-loading"
    >
      <q-spinner size="20px" color="primary" />
    </div>
    <div
      v-else-if="state === 'unavailable'"
      class="text-caption text-center q-py-sm"
      role="status"
      data-testid="balance-breakdown-unavailable"
    >
      {{ $t('balanceBreakdown.unavailable') }}
    </div>
    <template v-else>
      <div
        v-for="row in countedRows"
        :key="row.id"
        class="balance-breakdown-row"
        :data-testid="`balance-breakdown-${row.id}`"
      >
        <div class="balance-breakdown-label">
          <div class="text-body2">
            {{ $t(`balanceBreakdown.${row.id}`, { count: row.count ?? 0 }) }}
            <span
              v-if="row.address"
              class="text-caption balance-breakdown-muted"
              :title="row.address"
              >{{ shortAddress(row.address) }}</span
            >
          </div>
          <div class="text-caption balance-breakdown-muted">
            {{ $t(`balanceBreakdown.${row.id}Note`) }}
          </div>
        </div>
        <div
          class="text-body2 text-weight-medium balance-breakdown-amount"
          :title="exact(row.amount)"
        >
          {{ display(row.amount) }}
        </div>
      </div>
      <div
        class="balance-breakdown-row balance-breakdown-total"
        data-testid="balance-breakdown-total"
      >
        <div class="balance-breakdown-label text-body2 text-weight-bold">
          {{ $t('balanceBreakdown.total') }}
        </div>
        <div
          class="text-body2 text-weight-bold balance-breakdown-amount"
          :title="exact(total)"
        >
          {{ display(total) }}
        </div>
      </div>
      <!-- Subset information: already counted in received holdings and the total. -->
      <div
        v-for="row in otherRows"
        :key="row.id"
        class="balance-breakdown-row"
        :data-testid="`balance-breakdown-${row.id}`"
      >
        <div class="balance-breakdown-label">
          <div class="text-body2">
            {{ $t(`balanceBreakdown.${row.id}`, { count: row.count ?? 0 }) }}
            <span
              v-if="row.address"
              class="text-caption balance-breakdown-muted"
              :title="row.address"
              >{{ shortAddress(row.address) }}</span
            >
          </div>
          <div class="text-caption balance-breakdown-muted">
            {{ $t(`balanceBreakdown.${row.id}Note`) }}
          </div>
        </div>
        <div
          class="text-body2 text-weight-medium balance-breakdown-amount"
          :title="exact(row.amount)"
        >
          {{ display(row.amount) }}
        </div>
      </div>
      <div class="text-caption balance-breakdown-muted q-mt-xs">
        {{ $t('balanceBreakdown.yours') }}
      </div>
    </template>
  </div>
</template>

<script lang="ts">
import { computed, defineComponent, onMounted, ref } from 'vue'
import { activeChain } from '@frank/wallet/chain'
import { useActiveWallet } from 'src/composables/useActiveWallet'
import {
  breakdownFromParts,
  readBalanceBreakdown,
  type BalanceBreakdown,
} from 'src/composables/balance-breakdown'
import { useBalance } from 'src/composables/useBalance'
import { formatDisplayAmount, formatRawAmount } from 'src/utils/chain-amount'
import { shortAddress } from 'src/utils/short-address'

/**
 * The balance, taken apart: shown when the user opens it from the balance on the Wallet page.
 * A wallet that reports where its balance is (`getBalanceParts`) is shown from the shared balance
 * read (`useBalance().parts`): the same read as the balance above it, kept up to date with it, so
 * the two never disagree. Another wallet is read once (`readBalanceBreakdown`).
 */
export default defineComponent({
  name: 'BalanceBreakdown',
  setup() {
    const { parts, refresh } = useBalance()
    const source = ref<
      | { kind: 'loading' }
      | { kind: 'balance'; addresses: { main?: string; profile?: string } }
      | { kind: 'read'; breakdown: BalanceBreakdown }
      | { kind: 'unavailable' }
    >({ kind: 'loading' })
    onMounted(async () => {
      try {
        const wallet = (await useActiveWallet()) as {
          getBalanceParts?: unknown
          getReceiveAddress?(): Promise<{ raw: string }>
          identity?: { address?: { raw?: string } }
        }
        if (typeof wallet.getBalanceParts === 'function') {
          const main =
            typeof wallet.getReceiveAddress === 'function'
              ? (await wallet.getReceiveAddress()).raw
              : undefined
          // Read now, for the balance above and these rows at once.
          await refresh()
          source.value = {
            kind: 'balance',
            addresses: { main, profile: wallet.identity?.address?.raw },
          }
          return
        }
        const read = await readBalanceBreakdown(wallet)
        source.value = read
          ? { kind: 'read', breakdown: read }
          : { kind: 'unavailable' }
      } catch {
        source.value = { kind: 'unavailable' }
      }
    })
    const breakdown = computed((): BalanceBreakdown | undefined => {
      const current = source.value
      if (current.kind === 'read') return current.breakdown
      if (current.kind === 'balance' && parts.value)
        return breakdownFromParts(parts.value, current.addresses)
      return undefined
    })
    const rows = computed(() => breakdown.value?.rows ?? [])
    const state = computed<'loading' | 'ready' | 'unavailable'>(() =>
      source.value.kind === 'loading'
        ? 'loading'
        : rows.value.length > 0
        ? 'ready'
        : 'unavailable',
    )
    return {
      state,
      rows,
      countedRows: computed(() => rows.value.filter(r => r.id !== 'tooSmall')),
      otherRows: computed(() => rows.value.filter(r => r.id === 'tooSmall')),
      total: computed(() => breakdown.value?.total ?? 0n),
      shortAddress,
      display: (amount: bigint) => formatDisplayAmount(activeChain, amount),
      exact: (amount: bigint) => formatRawAmount(activeChain, amount),
    }
  },
})
</script>

<style lang="scss" scoped>
.balance-breakdown {
  max-width: 420px;
  margin: 0 auto;
  text-align: left;
}

.balance-breakdown-row {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
  padding: 6px 0;
}

/* The label takes the room that is left and wraps; the amount never wraps or shrinks. */
.balance-breakdown-label {
  min-width: 0;
  flex: 1 1 auto;
}

.balance-breakdown-amount {
  flex: 0 0 auto;
  white-space: nowrap;
}

.balance-breakdown-total {
  border-top: 1px solid rgba(128, 128, 128, 0.35);
  margin-top: 4px;
}

/* Quieter than its neighbour in both themes (a fixed grey is unreadable on the dark page). */
.balance-breakdown-muted {
  opacity: 0.7;
}
</style>
