<template>
  <div>
    <q-header>
      <q-toolbar class="q-pl-sm">
        <q-btn
          flat
          dense
          class="q-px-sm"
          icon="arrow_back"
          :aria-label="$t('settings.back')"
          data-test="backup-back"
          @click="cancel"
        />
        <q-toolbar-title class="h6">
          {{ $t('accountRecovery.backup_account_codex32') }}
        </q-toolbar-title>
        <q-btn
          flat
          dense
          class="q-px-sm"
          icon="menu"
          :aria-label="$t('settings.openMenu')"
          data-test="backup-menu"
          @click="$emit('toggleMyDrawerOpen')"
        />
      </q-toolbar>
    </q-header>
    <q-page-container>
      <q-page class="q-ma-none q-pa-md" data-test="backup-account-page">
        <q-card
          flat
          class="bg-transparent"
          style="max-width: 680px; margin: 0 auto"
        >
          <q-card-section>
            <div class="row items-center justify-between no-wrap">
              <div class="text-h6">
                {{ $t('accountRecovery.backup_account_codex32') }}
              </div>
              <div
                v-if="!backupUnavailable"
                class="row items-center q-gutter-xs"
              >
                <q-btn
                  outline
                  no-caps
                  size="sm"
                  color="primary"
                  :label="`${threshold} of ${count}`"
                  :disable="backupLoading"
                  data-test="codex32-scheme-btn"
                  @click="cycleScheme"
                />
                <q-btn
                  flat
                  round
                  dense
                  size="sm"
                  icon="tune"
                  color="primary"
                  :disable="backupLoading"
                  data-test="codex32-custom-scheme-btn"
                  @click="toggleCustomConfig"
                >
                  <q-tooltip>{{
                    $t('accountRecovery.configure_scheme')
                  }}</q-tooltip>
                </q-btn>
              </div>
            </div>
            <div
              v-if="backupShares.length > 0"
              class="text-caption text-grey-8 q-mt-xs"
              data-test="backup-explainer"
            >
              {{
                $t('accountRecovery.codex32_threshold_explainer', {
                  threshold,
                  count,
                })
              }}
              {{ $t('accountRecovery.codex32_backup_sets_do_not_mix') }}
            </div>
          </q-card-section>

          <q-card-section
            v-if="showCustomConfig && !backupUnavailable"
            class="q-py-none"
            data-test="custom-scheme-section"
          >
            <div class="custom-scheme-box q-pa-sm rounded-borders q-mb-sm">
              <div class="text-caption text-weight-medium q-mb-xs">
                {{ $t('accountRecovery.custom_threshold_shares') }}
              </div>
              <div class="row items-center q-gutter-sm">
                <div class="col">
                  <q-input
                    v-model.number="customThreshold"
                    type="number"
                    dense
                    outlined
                    :min="2"
                    :max="9"
                    :label="$t('accountRecovery.threshold')"
                    data-test="input-threshold"
                  />
                </div>
                <div class="col">
                  <q-input
                    v-model.number="customCount"
                    type="number"
                    dense
                    outlined
                    :min="customThreshold || 2"
                    :max="31"
                    :label="$t('accountRecovery.total_shares')"
                    data-test="input-count"
                  />
                </div>
                <div class="col-auto">
                  <q-btn
                    unelevated
                    no-caps
                    size="sm"
                    color="primary"
                    :label="$t('accountRecovery.apply')"
                    data-test="apply-custom-scheme"
                    :disable="!isCustomValid || backupLoading"
                    @click="applyCustom"
                  />
                </div>
              </div>
            </div>
          </q-card-section>

          <q-card-section class="q-pt-none">
            <div
              v-if="backupLoading"
              class="text-center q-pa-lg"
              data-test="backup-loading"
            >
              <q-spinner color="primary" size="2.5em" />
              <div class="q-mt-md text-body2">
                {{ $t('accountRecovery.generating_codex32_backup_shares') }}
              </div>
            </div>
            <div
              v-else-if="backupUnavailable"
              role="alert"
              class="text-body2 q-pa-sm"
              data-test="backup-unavailable"
            >
              {{ $t('accountRecovery.codex32_backup_unavailable_for_account') }}
            </div>
            <div
              v-else-if="backupError"
              class="text-negative q-pa-sm"
              data-test="backup-error"
            >
              {{ backupError }}
            </div>
            <div
              v-else-if="backupShares.length === 0"
              class="q-pa-sm"
              data-test="backup-reveal"
            >
              <div class="text-body2 q-mb-sm" data-test="backup-reveal-warning">
                {{ $t('accountRecovery.show_recovery_shares_warning') }}
              </div>
              <q-btn
                unelevated
                no-caps
                color="primary"
                :label="$t('accountRecovery.show_recovery_shares')"
                data-test="show-recovery-shares"
                @click="generateShares"
              />
            </div>
            <div v-else class="q-gutter-y-sm" data-test="backup-shares-list">
              <div
                v-for="(share, index) in backupShares"
                :key="index"
                class="share-card q-pa-sm rounded-borders"
              >
                <div class="row items-center justify-between q-mb-xs">
                  <div class="text-weight-bold text-caption">
                    {{
                      `${$t('accountRecovery.share')} ${index + 1} / ${
                        backupShares.length
                      }`
                    }}
                  </div>
                  <q-btn
                    flat
                    dense
                    no-caps
                    size="sm"
                    color="primary"
                    icon="content_copy"
                    :label="$t('accountRecovery.copy_share')"
                    data-test="copy-share"
                    @click="copyShare(share, index)"
                  />
                </div>
                <div
                  class="text-caption text-mono"
                  style="
                    word-break: break-all;
                    font-family: monospace;
                    user-select: all;
                  "
                  data-test="codex32-share"
                >
                  {{ share }}
                </div>
              </div>
              <div
                v-if="copyStatus"
                role="status"
                class="text-caption text-positive q-mt-xs text-right"
                data-test="copy-status"
              >
                {{ copyStatus }}
              </div>
            </div>
          </q-card-section>

          <q-card-actions align="right" class="q-pa-md">
            <q-btn
              flat
              no-caps
              :label="$t('settings.back')"
              color="primary"
              data-test="backup-done"
              @click="cancel"
            />
          </q-card-actions>
        </q-card>
      </q-page>
    </q-page-container>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch, onBeforeUnmount } from 'vue'
import { useRouter } from 'vue-router'
import { useCodex32Backup } from '../composables/useCodex32Backup'
import { navigateBack } from '../utils/navigate-back'

defineEmits<{
  (e: 'toggleMyDrawerOpen'): void
  (e: 'toggleContactDrawerOpen'): void
  (e: 'setupNavigationLocked'): void
  (e: 'setupCompleted'): void
}>()

const router = useRouter()
const {
  backupLoading,
  backupError,
  backupUnavailable,
  backupShares,
  threshold,
  count,
  cycleScheme,
  setScheme,
  generateShares,
  clearShares,
} = useCodex32Backup()

const copyStatus = ref('')
const showCustomConfig = ref(false)
const customThreshold = ref(threshold.value)
const customCount = ref(count.value)

watch(
  () => [threshold.value, count.value],
  ([newT, newC]) => {
    customThreshold.value = newT ?? 2
    customCount.value = newC ?? 3
  },
)

const isCustomValid = computed(() => {
  const t = Number(customThreshold.value)
  const c = Number(customCount.value)
  return (
    Number.isInteger(t) &&
    Number.isInteger(c) &&
    t >= 2 &&
    t <= 9 &&
    c >= t &&
    c <= 31
  )
})

function toggleCustomConfig() {
  showCustomConfig.value = !showCustomConfig.value
  if (showCustomConfig.value) {
    customThreshold.value = threshold.value
    customCount.value = count.value
  }
}

function applyCustom() {
  if (!isCustomValid.value) return
  setScheme(Number(customThreshold.value), Number(customCount.value))
  showCustomConfig.value = false
}

async function copyShare(share: string, index: number) {
  try {
    await navigator.clipboard.writeText(share)
    copyStatus.value = `Share ${index + 1} copied.`
  } catch {
    copyStatus.value = 'Failed to copy share.'
  }
}

function cancel() {
  navigateBack(router)
}

// Nothing is read from custody until the user asks for shares, and whatever was shown
// (or was still being issued) is dropped when they leave the page.
onBeforeUnmount(clearShares)
</script>

<style lang="scss" scoped>
.share-card,
.custom-scheme-box {
  background: rgba(0, 0, 0, 0.04);
  border: 1px solid rgba(0, 0, 0, 0.08);
}

:global(body.body--dark) {
  .share-card,
  .custom-scheme-box {
    background: rgba(255, 255, 255, 0.05);
    border: 1px solid rgba(255, 255, 255, 0.1);
  }
}
</style>
