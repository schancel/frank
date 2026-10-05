<template>
  <q-header
    ><q-toolbar>
      <q-btn
        flat
        dense
        no-caps
        icon="menu"
        :aria-label="$t('accountRecovery.open_navigation')"
        @click="$emit('toggleMyDrawerOpen')"
      />
      <q-toolbar-title>
        {{ $t('accountRecovery.frank_account') }}
      </q-toolbar-title>
    </q-toolbar></q-header
  >
  <q-page-container
    ><q-page class="q-pa-md">
      <section
        class="account-setup q-mx-auto"
        aria-labelledby="account-heading"
      >
        <h1 id="account-heading" ref="heading" tabindex="-1" class="text-h5">
          {{
            mode === 'legacy'
              ? $t('accountRecovery.import_bip39_seed')
              : $t('accountRecovery.frank_account')
          }}
        </h1>
        <p role="status" aria-live="polite" data-test="account-status">
          {{ statusText }}
        </p>
        <p
          v-if="error"
          role="alert"
          class="text-negative"
          data-test="account-error"
        >
          {{ error }}
        </p>
        <template
          v-if="
            account.status === 'locked' ||
            account.status === 'unavailable' ||
            legacy.unavailable
          "
        >
          <p>
            {{ $t('accountRecovery.saved_account_data_could_not_be_opened') }}
          </p>
          <q-btn
            outline
            color="primary"
            no-caps
            :label="$t('accountRecovery.retry_opening_account')"
            :loading="busy"
            data-test="retry-account"
            @click="retry"
          />
        </template>
        <template v-else-if="account.pending">
          <p
            v-if="account.pendingError"
            role="status"
            data-test="pending-error"
          >
            {{ $t('accountRecovery.pending_retry') }}
          </p>
          <q-btn
            v-if="account.pendingError"
            outline
            color="primary"
            no-caps
            :label="$t('accountRecovery.retry_opening_account')"
            data-test="retry-pending"
            :disable="busy"
            @click="retry"
          />
          <p>
            {{ $t('accountRecovery.a_saved_account_attempt_is_pending_it') }}
          </p>
          <p>{{ account.pending.account.displayName }}</p>
          <p class="recovery-text">{{ account.pending.account.descriptor }}</p>
          <div v-if="account.pendingReady" class="row q-gutter-sm q-mt-md items-center">
            <q-btn
              color="primary"
              no-caps
              :label="$t('accountRecovery.activate_account')"
              data-test="activate-account"
              :disable="busy"
              :loading="busy"
              @click="activate"
            />
            <q-btn
              outline
              color="primary"
              no-caps
              :label="$t('accountRecovery.cancel_pending_attempt')"
              data-test="cancel-pending"
              :disable="busy"
              @click="cancelPending"
            />
          </div>
          <div v-else class="q-mt-md">
            <p>
              {{
                $t(
                  'accountRecovery.the_attempt_is_incomplete_or_awaiting_cleanup',
                )
              }}
            </p>
            <q-btn
              outline
              color="primary"
              no-caps
              :label="$t('accountRecovery.cancel_pending_attempt')"
              data-test="cancel-pending"
              :disable="busy"
              @click="cancelPending"
            />
          </div>
          <q-btn
            v-if="account.status === 'ready'"
            class="q-mt-md"
            outline
            color="primary"
            no-caps
            :label="$t('accountRecovery.return_to_wallet')"
            @click="$router.push('/wallet')"
          />
        </template>
        <template v-else-if="account.status !== 'loading'">
          <template v-if="mode === 'choice'">
            <p>
              {{
                $t('accountRecovery.create_a_frank_account_backup_or_restore')
              }}
            </p>
            <div v-if="account.account || legacy.present" class="q-mb-md">
              <p v-if="legacy.present">
                {{
                  $t(
                    'accountRecovery.an_existing_legacy_account_is_quarantined_its',
                  )
                }}
              </p>
              <p v-if="account.account">
                {{
                  $t(
                    'accountRecovery.changing_accounts_replaces_the_active_local_account',
                  )
                }}
              </p>
              <q-checkbox
                v-model="replaceAccepted"
                :label="
                  $t(
                    'accountRecovery.i_understand_this_changes_the_active_local',
                  )
                "
                data-test="replace-ack"
              />
            </div>
            <div class="row q-gutter-sm items-center">
              <q-btn
                color="primary"
                no-caps
                :label="$t('accountRecovery.new_account')"
                data-test="new-account"
                :disable="!mayBegin || busy"
                @click="changeMode('policy')"
              />
              <q-btn
                outline
                color="primary"
                no-caps
                :label="$t('accountRecovery.restore_account')"
                data-test="restore-account"
                :disable="!mayBegin || busy"
                @click="startRestore"
              />
              <q-btn
                outline
                color="primary"
                no-caps
                :label="$t('accountRecovery.import_bip39_seed')"
                data-test="legacy-recovery"
                :disable="!mayBegin || busy"
                @click="changeMode('legacy')"
              />
            </div>
            <q-btn
              v-if="account.status === 'ready'"
              class="q-mt-md"
              outline
              color="primary"
              no-caps
              :label="$t('accountRecovery.return_to_wallet')"
              @click="$router.push('/wallet')"
            />
          </template>
          <q-form v-else-if="mode === 'legacy'" @submit="submitLegacyPhrase">
            <p>
              {{
                $t(
                  'accountRecovery.this_identifies_your_old_account_locally_you',
                )
              }}
            </p>
            <q-input
              v-model="legacyPhrase"
              type="textarea"
              outlined
              autogrow
              :rows="3"
              :label="$t('accountRecovery.legacy_bip39_recovery_phrase')"
              autocomplete="off"
              autocorrect="off"
              :spellcheck="false"
              :maxlength="512"
              data-test="legacy-phrase"
            />
            <p
              v-if="detectedAccount"
              role="status"
              aria-live="polite"
              class="q-mt-sm text-positive"
              data-test="detected-account"
            >
              {{ detectedAccount }}
            </p>
            <div class="row q-gutter-sm q-mt-md items-center">
              <q-btn
                type="submit"
                color="primary"
                no-caps
                :label="$t('accountRecovery.import_bip39_seed')"
                data-test="identify-legacy"
                :disable="busy || !legacyPhrase"
                :loading="busy"
              />
              <q-btn
                outline
                color="primary"
                no-caps
                :label="$t('accountRecovery.cancel_and_start_again')"
                data-test="cancel-ceremony"
                :disable="busy"
                @click="cancel"
              />
            </div>
          </q-form>
          <q-form v-else-if="mode === 'policy'" @submit="beginNew">
            <p v-if="legacyAddress">
              {{ $t('accountRecovery.old_account') }} {{ legacyAddress }}
              {{ $t('accountRecovery.the_new_identity_is_different_no_funds') }}
            </p>
            <p>
              {{ $t('accountRecovery.choose_how_many_shares_you_must_retain') }}
            </p>
            <q-option-group
              v-model="policy"
              type="radio"
              :options="policies"
              data-test="backup-policy"
            />
            <div class="row q-gutter-sm q-mt-md items-center">
              <q-btn
                type="submit"
                color="primary"
                no-caps
                :label="$t('accountRecovery.generate_frank_account_backups')"
                data-test="generate-backups"
                :disable="!policy || busy"
                :loading="busy"
              />
              <q-btn
                outline
                color="primary"
                no-caps
                :label="$t('accountRecovery.cancel_and_start_again')"
                data-test="cancel-ceremony"
                :disable="busy"
                @click="cancel"
              />
            </div>
          </q-form>
          <template v-else-if="mode === 'backup'">
            <p>
              {{ $t('accountRecovery.frank_account_backup') }}
              {{ shareIndex + 1 }} of {{ shareCount }}
              {{
                $t('accountRecovery.save_each_share_before_moving_on_exactly')
              }}
              {{ threshold }}
              {{
                $t('accountRecovery.consistent_shares_are_required_to_confirm')
              }}
            </p>
            <q-input
              :model-value="shownShare"
              type="textarea"
              outlined
              readonly
              :label="$t('accountRecovery.frank_account_backup_share')"
              autocomplete="off"
              data-test="backup-share"
            />
            <div class="row q-gutter-sm q-mt-md items-center">
              <q-btn
                outline
                color="primary"
                no-caps
                :label="$t('accountRecovery.copy_this_share')"
                @click="copy(shownShare)"
              />
              <q-btn
                color="primary"
                no-caps
                :label="
                  shareIndex + 1 < shareCount
                    ? 'Saved this share — next'
                    : 'Saved all shares'
                "
                data-test="next-share"
                @click="nextShare"
              />
              <q-btn
                outline
                color="primary"
                no-caps
                :label="$t('accountRecovery.cancel_and_start_again')"
                data-test="cancel-ceremony"
                :disable="busy"
                @click="cancel"
              />
            </div>
          </template>
          <q-form
            v-else-if="mode === 'confirm' || mode === 'restore-shares' || mode === 'restore'"
            @submit="confirm"
          >
            <p v-if="mode === 'confirm'">
              {{ $t('accountRecovery.re_enter_exactly') }} {{ threshold }}
              {{
                $t(
                  'accountRecovery.saved_frank_account_backup_shares_we_reconstruct',
                )
              }}
            </p>
            <p v-else>
              {{
                $t(
                  'accountRecovery.enter_exactly_the_threshold_number_printed_in',
                )
              }}
            </p>
            <p v-if="descriptor" class="recovery-text" data-test="pinned-descriptor">
              {{ $t('accountRecovery.expected_account') }} {{ descriptor }}
            </p>
            <q-input
              v-model="shareInput"
              type="textarea"
              outlined
              :label="$t('accountRecovery.saved_codex32_shares_one_per_line')"
              :maxlength="6000"
              autocomplete="off"
              autocorrect="off"
              :spellcheck="false"
              data-test="confirm-shares"
            />
            <q-input
              v-model="displayName"
              outlined
              class="q-mt-sm"
              :label="$t('accountRecovery.display_name')"
              :maxlength="80"
              autocomplete="off"
              data-test="display-name"
            />
            <div class="row q-gutter-sm q-mt-md items-center">
              <q-btn
                type="submit"
                color="primary"
                no-caps
                :label="$t('accountRecovery.verify_backups_and_stage_account')"
                data-test="verify-backups"
                :disable="busy || !shareInput || !displayName.trim()"
                :loading="busy"
              />
              <q-btn
                outline
                color="primary"
                no-caps
                :label="$t('accountRecovery.cancel_and_start_again')"
                data-test="cancel-ceremony"
                :disable="busy"
                @click="cancel"
              />
            </div>
          </q-form>
        </template>
        <p class="q-mt-lg text-caption">
          {{
            $t(
              'accountRecovery.browser_preview_encrypted_local_storage_does_not',
            )
          }}
        </p>
      </section>
    </q-page></q-page-container
  >
</template>

<script setup lang="ts">
/* global defineProps, defineEmits */
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import {
  accountSession,
  accountStatus as account,
  importBip39Wallet,
} from '../accounts/session'
import {
  createAccountCeremony,
  recoveryErrorMessage,
} from '../accounts/ceremony'
import {
  identifyLegacyAccount,
  legacyStatus as legacy,
  retryLegacyInspection,
} from '../accounts/legacy'
import { usePersistentStorageStore } from '../stores/persistent-storage'
defineProps<{ myDrawerOpen?: boolean }>()
const emit = defineEmits(['toggleMyDrawerOpen', 'setupCompleted'])
const router = useRouter()
const ceremony = createAccountCeremony()
type Mode =
  | 'choice'
  | 'legacy'
  | 'policy'
  | 'backup'
  | 'save-descriptor'
  | 'descriptor'
  | 'confirm'
  | 'restore'
  | 'restore-shares'
const mode = ref<Mode>('choice')
const heading = ref<HTMLElement>()
const busy = ref(false)
const error = ref('')
const policy = ref<string | null>(null)
const policies = [
  { label: '2 of 3 shares — tolerate losing one', value: '2-3' },
  { label: '3 of 5 shares — tolerate losing two', value: '3-5' },
]
const threshold = ref<2 | 3>(2)
const shareCount = ref<3 | 5>(3)
const shareIndex = ref(0)
const shownShare = ref('')
const descriptor = ref('')
const descriptorInput = ref('')
const descriptorSaved = ref(false)
const shareInput = ref('')
const displayName = ref('')
const legacyPhrase = ref('')
const legacyAddress = ref('')
const detectedAccount = ref('')
const replaceAccepted = ref(false)
let alive = true
let request = 0
const mayBegin = computed(
  () => !(account.account || legacy.present) || replaceAccepted.value,
)
const statusText = computed(() =>
  busy.value
    ? 'Account operation in progress.'
    : account.status === 'ready'
    ? 'Local account ready. Messaging is unavailable in this typed-account preview.'
    : account.status === 'fresh'
    ? 'No active local account.'
    : account.status === 'pending'
    ? 'Account pending explicit activation.'
    : account.status === 'loading'
    ? 'Opening account storage…'
    : 'Account storage locked or unavailable.',
)
function clearSecrets() {
  shownShare.value = ''
  shareInput.value = ''
  legacyPhrase.value = ''
  detectedAccount.value = ''
}
function focus() {
  void nextTick(() => heading.value?.focus())
}
function changeMode(value: Mode) {
  if (value === 'restore') {
    void startRestore()
    return
  }
  mode.value = value
  error.value = ''
  focus()
}
function cancel() {
  request++
  ceremony.cancel()
  clearSecrets()
  descriptor.value = ''
  descriptorInput.value = ''
  descriptorSaved.value = false
  policy.value = null
  legacyAddress.value = ''
  changeMode('choice')
}
watch(
  () => [account.revision, legacy.revision],
  () => {
    replaceAccepted.value = false
  },
)
async function run(work: () => Promise<void>) {
  if (busy.value) return
  const token = ++request
  busy.value = true
  error.value = ''
  try {
    await work()
  } catch (failure) {
    ceremony.cancel()
    clearSecrets()
    if (alive && token === request) {
      mode.value = 'choice'
      error.value = recoveryErrorMessage(failure)
      focus()
    }
  } finally {
    if (alive && token === request) busy.value = false
  }
}
function beginNew() {
  return run(async () => {
    if (!mayBegin.value || !policy.value) return
    threshold.value = policy.value === '2-3' ? 2 : 3
    shareCount.value = policy.value === '2-3' ? 3 : 5
    descriptor.value = await ceremony.beginNew(
      threshold.value,
      shareCount.value,
    )
    if (!alive) {
      ceremony.cancel()
      return
    }
    shareIndex.value = 0
    shownShare.value = ceremony.share(0)
    changeMode('backup')
  })
}
function nextShare() {
  shownShare.value = ''
  if (++shareIndex.value < shareCount.value) {
    shownShare.value = ceremony.share(shareIndex.value)
    focus()
  } else changeMode('confirm')
}
function startRestore() {
  return run(async () => {
    if (!mayBegin.value) return
    descriptor.value = await ceremony.beginRestore()
    if (alive) changeMode('restore-shares')
  })
}
function pinDescriptor() {
  return run(async () => {
    if (!mayBegin.value) return
    descriptor.value = await ceremony.beginRestore(descriptorInput.value)
    descriptorInput.value = ''
    if (alive) changeMode('restore-shares')
  })
}
function confirm() {
  return run(async () => {
    let shares = shareInput.value
      .split(/\r?\n/)
      .filter(value => value.length > 0)
    shareInput.value = ''
    shownShare.value = ''
    try {
      await ceremony.confirm(shares, displayName.value)
    } finally {
      shares = []
    }
    if (alive) {
      changeMode('choice')
      focus()
    }
  })
}
function submitLegacyPhrase() {
  return run(async () => {
    let phrase = legacyPhrase.value
    legacyPhrase.value = ''
    try {
      const { scanBip39Accounts } = await import('@frank/wallet/bip39-import')
      let provider: any = undefined
      try {
        const { activeChain } = await import('@frank/wallet/chain')
        provider = (activeChain as any).provider
      } catch {
        // provider unavailable
      }
      const scanned = await scanBip39Accounts({ phrase, provider })
      const detectedInfo = `${scanned.address} (${scanned.label})`
      detectedAccount.value = detectedInfo

      await importBip39Wallet(phrase, scanned.path)
      void usePersistentStorageStore().afterActivation()
      emit('setupCompleted')
      await router.push('/wallet')
    } finally {
      phrase = ''
    }
  })
}
const identifyLegacy = submitLegacyPhrase

function activate() {
  return run(async () => {
    const pending = account.pending
    if (!pending) return
    await accountSession.activatePending(
      pending.account.receipt.operationId,
      pending.expectedActive,
    )
    if (account.status !== 'ready') return
    void usePersistentStorageStore().afterActivation()
    emit('setupCompleted')
    await router.push('/wallet')
  })
}
function cancelPending() {
  return run(async () => {
    const id = account.pending?.account.receipt.operationId
    if (id) await accountSession.cancelPending(id)
    cancel()
    busy.value = false
  })
}
function retry() {
  return run(async () => {
    await retryLegacyInspection()
    await accountSession.retry()
  })
}
async function copy(text: string) {
  try {
    await navigator.clipboard.writeText(text)
  } catch {
    error.value = 'Copy unavailable. Save the displayed text manually.'
  }
}
onBeforeUnmount(() => {
  alive = false
  request++
  ceremony.cancel()
  clearSecrets()
})
</script>
<style scoped>
.account-setup {
  max-width: 48rem;
}
.recovery-text {
  overflow-wrap: anywhere;
}
</style>
