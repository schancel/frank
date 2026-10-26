<template>
  <q-card flat bordered class="q-mb-md" data-test="developer-section">
    <q-card-section>
      <div class="text-h6 q-mb-sm">
        {{ $t('walletMaintenance.developerTitle') }}
      </div>
      <p class="text-body2 text-grey-9">
        {{ $t('walletMaintenance.developerIntro') }}
      </p>
      <div class="text-weight-bold text-body2">
        {{ $t('walletMaintenance.reconcileTitle') }}
      </div>
      <p class="text-caption text-grey-8">
        {{ $t('walletMaintenance.reconcileDescription') }}
      </p>
      <q-btn
        unelevated
        no-caps
        color="primary"
        icon="sync"
        :label="
          running
            ? $t('walletMaintenance.reconcileRunning')
            : $t('walletMaintenance.reconcileStart')
        "
        :loading="running"
        :disable="running"
        data-test="reconcile-wallet-btn"
        @click="run"
      />
      <div
        v-if="running && progress"
        class="text-caption q-mt-sm"
        role="status"
        data-test="reconcile-progress"
      >
        <template v-if="progress.step === 'mailbox'">
          {{
            $t('walletMaintenance.reconcileStepMailbox', {
              count: String(progress.messagesRead),
            })
          }}
        </template>
        <template v-else-if="progress.step === 'seed'">
          {{ $t('walletMaintenance.reconcileStepSeed') }}
        </template>
        <template v-else>
          {{
            $t('walletMaintenance.reconcileStepOperations', {
              done: String(progress.operationsObserved),
              total: String(progress.operationsTotal),
            })
          }}
        </template>
      </div>
      <div
        v-if="error"
        class="text-negative text-caption q-mt-sm"
        role="alert"
        data-test="reconcile-error"
      >
        {{ $t('walletMaintenance.reconcileUnavailable', { reason: error }) }}
      </div>
      <div
        v-if="summary"
        class="q-mt-md"
        role="status"
        data-test="reconcile-summary"
      >
        <div class="text-weight-bold text-body2">
          {{ $t('walletMaintenance.reconcileDone') }}
        </div>
        <ul class="text-caption q-pl-md q-my-xs">
          <li>
            {{
              $t('walletMaintenance.summaryNetwork', {
                network: summary.chainIdentifier,
              })
            }}
          </li>
          <li>
            {{
              $t('walletMaintenance.summaryMessages', {
                count: String(summary.messagesRead),
              })
            }}
          </li>
          <li v-if="!summary.mailboxComplete">
            {{ $t('walletMaintenance.summaryMailboxIncomplete') }}
          </li>
          <li data-test="reconcile-coins-added">
            {{
              $t('walletMaintenance.summaryCoinsAdded', {
                count: String(summary.receivedCoinsAdded.length),
              })
            }}
          </li>
          <li>
            {{
              $t('walletMaintenance.summaryCoinsChanged', {
                count: String(summary.receivedCoinsChanged),
              })
            }}
          </li>
          <li>
            {{
              $t('walletMaintenance.summaryAccountsAdded', {
                count: String(summary.accountsAdded.length),
              })
            }}
          </li>
          <li>
            {{
              $t('walletMaintenance.summaryOperations', {
                count: String(summary.operationsObserved),
                changed: String(summary.operationsChanged.length),
              })
            }}
          </li>
          <li
            v-for="(failure, index) in summary.failures"
            :key="index"
            class="text-negative"
          >
            {{
              $t('walletMaintenance.summaryFailure', {
                step: failure.step,
                message: failure.message,
              })
            }}
          </li>
        </ul>
        <div v-if="nothingNew" class="text-caption text-grey-8">
          {{ $t('walletMaintenance.summaryNothingNew') }}
        </div>
      </div>
    </q-card-section>
  </q-card>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import {
  reconcileAccountWallet,
  type WalletReconcileProgress,
  type WalletReconcileSummary,
} from 'src/accounts/wallet-reconcile'

/** The hidden Developer section's reconcile pass: progress while it runs, then its summary. */
const running = ref(false)
const progress = ref<WalletReconcileProgress>()
const summary = ref<WalletReconcileSummary>()
const error = ref<string>()

const nothingNew = computed(
  () =>
    summary.value !== undefined &&
    summary.value.failures.length === 0 &&
    summary.value.receivedCoinsAdded.length === 0 &&
    summary.value.receivedCoinsChanged === 0 &&
    summary.value.accountsAdded.length === 0 &&
    summary.value.operationsChanged.length === 0,
)

async function run() {
  if (running.value) return
  running.value = true
  error.value = undefined
  summary.value = undefined
  progress.value = undefined
  try {
    summary.value = await reconcileAccountWallet(next => {
      progress.value = next
    })
  } catch (failure) {
    error.value = failure instanceof Error ? failure.message : String(failure)
  } finally {
    running.value = false
  }
}
</script>
