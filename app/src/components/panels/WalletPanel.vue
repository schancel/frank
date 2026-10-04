<template>
  <div class="full-width column col" data-test="wallet-panel">
    <p
      v-if="messaging.status !== 'ready'"
      class="q-pa-sm"
      role="status"
      data-test="messaging-pending"
    >
      {{ $t('accountRecovery.messaging_pending_open_settings_networking') }}
    </p>
    <q-list>
      <q-item
        clickable
        v-ripple
        data-test="wallet-row"
        @click="$router.push('/wallet')"
      >
        <q-item-section avatar
          ><q-icon name="account_balance_wallet"
        /></q-item-section>
        <q-item-section
          ><q-item-label> {{ $t('accountRecovery.main_wallet') }} </q-item-label
          ><q-item-label caption role="status" data-test="wallet-balance">{{
            loaded
              ? formattedBalance
              : $t(
                  hasError
                    ? 'accountRecovery.balance_unavailable'
                    : 'accountRecovery.balance_loading',
                )
          }}</q-item-label></q-item-section
        >
      </q-item>
      <p v-if="loaded && hasError" role="status" data-test="balance-stale">
        {{ $t('accountRecovery.balance_stale') }}
      </p>
    </q-list>
    <section v-if="account.account" class="q-pa-sm">
      <h2 class="text-subtitle1">
        {{ $t('accountRecovery.frank_account_recovery') }}
      </h2>
      <p>
        {{
          $t(
            'accountRecovery.backup_shares_were_verified_before_activation_keep',
          )
        }}
      </p>
      <q-input
        :model-value="account.account.descriptor"
        readonly
        :label="$t('accountRecovery.public_recovery_descriptor')"
        data-test="recovery-descriptor"
      />
      <q-btn
        flat
        :label="$t('accountRecovery.copy_public_descriptor')"
        data-test="copy-descriptor"
        @click="copyDescriptor"
      />
      <p role="status" aria-live="polite" data-test="copy-status">
        {{ copyStatus }}
      </p>
      <p class="recovery-text">
        {{ $t('accountRecovery.fingerprint') }}
        {{ account.account.fingerprint }}
      </p>
    </section>
    <section v-if="demoEnabled" class="q-pa-sm">
      <p>{{ $t('accountRecovery.local_fake_demo_only_add_up_to') }}</p>
      <q-btn
        :label="$t('accountRecovery.add_simulated_funds')"
        data-test="demo-fund"
        :disable="funding || account.status !== 'ready'"
        :loading="funding"
        @click="fund"
      />
      <p role="status" aria-live="polite" data-test="fund-status">
        {{ fundingStatus }}
      </p>
    </section>
    <q-btn
      flat
      :label="$t('accountRecovery.create_or_restore_account')"
      @click="$router.push('/setup')"
    />
  </div>
</template>
<script setup lang="ts">
import { ref } from 'vue'
import {
  accountSession,
  accountStatus as account,
} from '../../accounts/session'
import { useBalance } from '../../composables/useBalance'
// The same readiness state Settings > Networking reports; the notice shows only while messaging
// really is not ready for this account.
import { messagingState as messaging } from '../../utils/messaging-state'
import { ensureDemoBalance } from '@frank/bot/demo/demo-funding'
const { loaded, hasError, formattedBalance, refresh } = useBalance()
const fakeChain = String(import.meta.env.QCLI_FRANK_FAKE_DEMO) === 'true'
const rpcUrl = import.meta.env.QCLI_FRANK_DEMO_CONTROL_URL ?? ''
const loopback = /^http:\/\/127\.0\.0\.1:([1-9][0-9]{0,4})$/.exec(rpcUrl)
const demoEnabled = fakeChain && !!loopback && Number(loopback[1]) <= 65535
const funding = ref(false)
const fundingStatus = ref('')
const copyStatus = ref('')
async function fund() {
  if (!demoEnabled || funding.value) return
  funding.value = true
  const revision = account.revision
  try {
    const wallet = await accountSession.getWallet()
    const address = await wallet.getReceiveAddress()
    if (account.revision !== revision) return
    await ensureDemoBalance({ fakeChain, rpcUrl }, address.raw)
    if (account.revision !== revision) return
    await refresh()
    fundingStatus.value =
      'Simulated credit confirmed. Balance refresh requested.'
  } catch {
    fundingStatus.value =
      'Simulated funding unavailable. Your account remains active.'
  } finally {
    funding.value = false
  }
}
async function copyDescriptor() {
  if (!account.account) return
  try {
    await navigator.clipboard.writeText(account.account.descriptor)
    copyStatus.value = 'Public descriptor copied.'
  } catch {
    copyStatus.value =
      'Copy unavailable. Save the displayed public descriptor manually.'
  }
}
</script>
<style scoped>
.recovery-text {
  overflow-wrap: anywhere;
}
</style>
