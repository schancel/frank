<template>
  <section class="q-pa-md" data-testid="tempo-pathusd-panel">
    <div class="text-h6">PathUSD on Tempo Moderato</div>
    <p class="text-caption text-grey-7">
      PathUSD is a six-decimal token. Network fees are also paid in PathUSD.
    </p>
    <q-banner v-if="error" class="bg-red-1 text-red-10 q-mb-md" role="alert">{{
      error
    }}</q-banner>
    <q-btn
      v-if="error"
      flat
      no-caps
      label="Reload payment state"
      :loading="loading"
      @click="scheduleOpen"
    />
    <q-skeleton v-if="loading" type="text" />
    <template v-else-if="wallet">
      <div class="text-h5" data-testid="tempo-pathusd-balance">
        {{ balance === null ? '—' : formatUnits(balance, 6) }} PathUSD
      </div>
      <div class="text-caption">
        {{ balance === null ? 'Balance unavailable' : 'Available balance' }}
      </div>
      <div class="q-mt-md text-subtitle2">Receive PathUSD</div>
      <qrcode-vue
        :value="wallet.address"
        :size="180"
        level="H"
        data-testid="tempo-pathusd-qr"
      />
      <q-input
        :model-value="wallet.address"
        readonly
        filled
        label="Tempo Moderato address"
        data-testid="tempo-pathusd-address"
      >
        <template #append
          ><q-btn
            flat
            dense
            icon="content_copy"
            aria-label="Copy address"
            @click="copyAddress"
        /></template>
      </q-input>
      <div class="text-caption q-mt-xs">
        Send only Tempo Moderato assets to this address.
      </div>

      <div class="text-subtitle2 q-mt-lg">Send PathUSD</div>
      <q-input
        v-model="recipient"
        filled
        label="Recipient address"
        :disable="busy || !!review || unresolved"
        data-testid="tempo-recipient"
      />
      <q-input
        v-model="amount"
        filled
        inputmode="decimal"
        label="Amount in PathUSD"
        :disable="busy || !!review || unresolved"
        data-testid="tempo-amount"
      />
      <q-btn
        v-if="!review"
        class="q-mt-sm"
        color="primary"
        label="Review payment"
        :loading="busy"
        :disable="unresolved"
        data-testid="tempo-review"
        @click="reviewPayment"
      />
      <q-card
        v-else
        flat
        bordered
        class="q-mt-md"
        data-testid="tempo-review-card"
      >
        <q-card-section>
          <div>To: {{ review.recipient }}</div>
          <div>Send: {{ formatUnits(review.amountAtomic, 6) }} PathUSD</div>
          <div>
            Maximum network fee:
            {{ formatUnits(review.maximumFeeAtomic, 6) }} PathUSD
          </div>
          <div>
            Maximum total:
            {{ formatUnits(review.amountAtomic + review.maximumFeeAtomic, 6) }}
            PathUSD
          </div>
          <div class="text-caption">
            The fee ceiling and recipient are checked again before signing.
          </div>
        </q-card-section>
        <q-card-actions align="right">
          <q-btn flat label="Back" :disable="busy" @click="review = null" />
          <q-btn
            color="primary"
            label="Confirm and send"
            :loading="busy"
            :disable="busy"
            data-testid="tempo-confirm"
            @click="confirmPayment"
          />
        </q-card-actions>
      </q-card>
      <q-banner
        v-if="unresolved"
        class="bg-amber-1 text-amber-10 q-mt-md"
        role="status"
      >
        A payment may still complete. Check its status below before sending
        another.
      </q-banner>

      <div class="text-subtitle2 q-mt-lg">Payment activity</div>
      <q-btn
        flat
        no-caps
        label="Refresh activity"
        :loading="busy"
        data-testid="tempo-refresh"
        @click="scheduleOpen"
      />
      <q-list bordered separator>
        <q-item
          v-for="operation in operations"
          :key="operation.operationId"
          data-testid="tempo-operation"
        >
          <q-item-section>
            <q-item-label
              >{{ formatUnits(BigInt(operation.amountAtomic), 6) }} PathUSD to
              {{ operation.recipient }}</q-item-label
            >
            <q-item-label caption>{{
              operationStatus(operation)
            }}</q-item-label>
            <q-item-label v-if="operation.transactionHash" caption>{{
              operation.transactionHash
            }}</q-item-label>
          </q-item-section>
          <q-item-section side v-if="canRetry(operation)">
            <q-btn
              flat
              no-caps
              label="Resume same payment"
              :loading="busy"
              @click="retryOperation(operation.operationId)"
            />
          </q-item-section>
        </q-item>
        <q-item v-if="operations.length === 0"
          ><q-item-section>No payments yet</q-item-section></q-item
        >
      </q-list>
      <div class="text-caption q-mt-lg">Received PathUSD</div>
      <q-list bordered separator>
        <q-item
          v-for="item in received"
          :key="`${item.transactionHash}:${item.logIndex}`"
        >
          <q-item-section>
            <q-item-label
              >+{{
                formatUnits(BigInt(item.amountAtomic), 6)
              }}
              PathUSD</q-item-label
            >
            <q-item-label caption>{{ item.transactionHash }}</q-item-label>
          </q-item-section>
        </q-item>
        <q-item v-if="received.length === 0"
          ><q-item-section
            >No received payments scanned yet</q-item-section
          ></q-item
        >
      </q-list>
      <div
        v-if="catchUp"
        class="text-caption q-mt-sm"
        data-testid="tempo-catchup"
      >
        {{
          catchUp.complete
            ? 'History is caught up.'
            : `History scan reached block ${catchUp.nextBlock}; more history remains.`
        }}
      </div>
      <q-btn
        flat
        no-caps
        label="Scan more history"
        :loading="busy"
        class="q-mt-sm"
        @click="scanMore"
      />
    </template>
  </section>
</template>

<script setup lang="ts">
import {
  formatUnits,
  getAddress,
  hexlify,
  parseUnits,
  randomBytes,
} from 'ethers'
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import QrcodeVue from 'qrcode.vue'
import { copyToClipboard, Notify } from 'quasar'
import type {
  TempoPathUsdOperation,
  TempoPathUsdQuote,
} from '@frank/wallet/chain/tempo-pathusd-operation'
import type { TempoReceiveItem } from '@frank/wallet/chain/tempo-pathusd-receive'
import { accountStatus } from '../../accounts/session'
import { translateMessage } from '../../i18n'
import {
  openTempoPathUsdWallet,
  type OpenTempoPathUsdWallet,
} from '../../accounts/tempo-wallets'

const loading = ref(true)
const busy = ref(false)
const error = ref('')
const wallet = ref<OpenTempoPathUsdWallet['wallet'] | null>(null)
const balance = ref<bigint | null>(null)
const operations = ref<TempoPathUsdOperation[]>([])
const received = ref<TempoReceiveItem[]>([])
const catchUp = ref<{ nextBlock: bigint; complete: boolean } | null>(null)
const recipient = ref('')
const amount = ref('')
const review = ref<TempoPathUsdQuote | null>(null)
const uncertain = ref(false)
let opened: OpenTempoPathUsdWallet | null = null
let generation = 0
let lifecycle: Promise<void> = Promise.resolve()
let idleWaiters: Array<() => void> = []
function whenIdle(): Promise<void> {
  return busy.value
    ? new Promise(resolve => idleWaiters.push(resolve))
    : Promise.resolve()
}
function finishBusy(): void {
  busy.value = false
  for (const wake of idleWaiters) wake()
  idleWaiters = []
}
const unresolved = computed(
  () =>
    uncertain.value ||
    operations.value.some(
      row =>
        row.observation.state === 'included-mismatch' ||
        !row.observation.state.startsWith('included-') ||
        (row.observation.state.startsWith('included-') &&
          !row.observation.finalized),
    ),
)

function operationStatus(row: TempoPathUsdOperation): string {
  switch (row.observation.state) {
    case 'included-success':
      return row.observation.finalized
        ? 'Completed'
        : 'Included, awaiting finality'
    case 'included-revert':
      return row.observation.finalized
        ? 'Reverted; network fee paid'
        : 'Included, awaiting finality'
    case 'included-mismatch':
      return 'Needs review: unexpected chain result'
    case 'nonce-consumed-unknown':
      return 'Needs review: account nonce was used'
    default:
      return row.exposed
        ? 'Pending or status uncertain; funds may move'
        : 'Prepared; not yet sent'
  }
}
function canRetry(row: TempoPathUsdOperation): boolean {
  return (
    row.observation.state === 'pending' || row.observation.state === 'unknown'
  )
}
async function readState(host: OpenTempoPathUsdWallet): Promise<void> {
  balance.value = await host.wallet.balanceAtomic()
  operations.value = [...host.pendingOperations]
  received.value = host.wallet.receivedItems()
}
async function open(current: number): Promise<void> {
  const old = opened
  opened = null
  wallet.value = null
  review.value = null
  balance.value = null
  operations.value = []
  received.value = []
  catchUp.value = null
  recipient.value = ''
  amount.value = ''
  error.value = ''
  uncertain.value = false
  loading.value = true
  if (old) {
    await whenIdle()
    await old.close()
  }
  if (accountStatus.status !== 'ready' || current !== generation) {
    loading.value = false
    return
  }
  try {
    const host = await openTempoPathUsdWallet('tempo-testnet')
    if (current !== generation || accountStatus.status !== 'ready') {
      await host.close()
      return
    }
    opened = host
    wallet.value = host.wallet
    await readState(host)
  } catch (cause) {
    if (current === generation) error.value = String(cause)
  } finally {
    if (current === generation) loading.value = false
  }
}
function scheduleOpen(): void {
  const current = ++generation
  lifecycle = lifecycle.catch(() => undefined).then(() => open(current))
}
watch(() => [accountStatus.status, accountStatus.revision], scheduleOpen, {
  immediate: true,
})
onBeforeUnmount(() => {
  generation++
  lifecycle = lifecycle
    .catch(() => undefined)
    .then(async () => {
      const old = opened
      opened = null
      if (old) {
        await whenIdle()
        await old.close()
      }
    })
})
async function scanMore(): Promise<void> {
  const host = opened
  if (!host || busy.value) return
  busy.value = true
  error.value = ''
  try {
    const result = await host.wallet.syncReceivedCatchUp(8)
    if (host !== opened) return
    catchUp.value = { nextBlock: result.nextBlock, complete: result.complete }
    received.value = host.wallet.receivedItems()
    balance.value = await host.wallet.balanceAtomic()
  } catch (cause) {
    if (host === opened) error.value = String(cause)
  } finally {
    finishBusy()
  }
}
async function reviewPayment(): Promise<void> {
  const host = opened
  if (!host || busy.value || unresolved.value) return
  error.value = ''
  busy.value = true
  try {
    const address = getAddress(recipient.value)
    const atomic = parseUnits(amount.value, 6)
    if (atomic <= 0n) throw new Error('Enter an amount greater than zero')
    const quote = await host.wallet.quote(address, atomic)
    if (host !== opened) return
    if (
      balance.value === null ||
      balance.value < quote.amountAtomic + quote.maximumFeeAtomic
    )
      throw new Error(
        'Insufficient PathUSD for the payment and maximum network fee',
      )
    review.value = quote
  } catch (cause) {
    if (host === opened) error.value = String(cause)
  } finally {
    finishBusy()
  }
}
async function confirmPayment(): Promise<void> {
  const host = opened
  const quote = review.value
  if (!host || !quote || busy.value) return
  busy.value = true
  error.value = ''
  review.value = null
  const operationId = hexlify(randomBytes(32))
  let preparedOperation: TempoPathUsdOperation | null = null
  try {
    preparedOperation = await host.wallet.prepare({
      operationId,
      recipient: quote.recipient,
      amountAtomic: quote.amountAtomic,
      authorizedFeeAsset: quote.feeAsset,
      authorizedFeeCeilingAtomic: quote.maximumFeeAtomic,
      quotedNonce: quote.nonce,
    })
    // The user already confirmed this exact operation. An account-view change
    // must not abandon it after its reservation has been persisted.
    if (host === opened)
      operations.value = [preparedOperation, ...operations.value]
    const submitted = await host.wallet.submit(operationId)
    if (host !== opened) return
    operations.value = operations.value.map(row =>
      row.operationId === operationId ? submitted : row,
    )
    balance.value = await host.wallet.balanceAtomic()
  } catch (cause) {
    if (host === opened) {
      uncertain.value = true
      error.value = `Payment status must be checked before another send. ${String(
        cause,
      )}`
    } else {
      // A rejected prepare can still have committed its journal write, and an exposed
      // operation can still settle. Direct the user to the original account's recovery UI.
      Notify.create({
        message: translateMessage('tempoPayment.interrupted'),
        html: false,
        color: 'warning',
        timeout: 0,
        actions: [
          {
            label: translateMessage('tempoPayment.dismiss'),
            color: 'black',
          },
        ],
      })
    }
  } finally {
    finishBusy()
  }
}
async function retryOperation(operationId: string): Promise<void> {
  const host = opened
  if (!host || busy.value) return
  busy.value = true
  error.value = ''
  try {
    const row = await host.wallet.submit(operationId)
    if (host !== opened) return
    operations.value = operations.value.map(item =>
      item.operationId === operationId ? row : item,
    )
    balance.value = await host.wallet.balanceAtomic()
  } catch (cause) {
    if (host === opened)
      error.value = `The same payment is still unresolved. ${String(cause)}`
  } finally {
    finishBusy()
  }
}
async function copyAddress(): Promise<void> {
  if (!wallet.value) return
  try {
    await copyToClipboard(wallet.value.address)
  } catch (cause) {
    error.value = String(cause)
  }
}
</script>
