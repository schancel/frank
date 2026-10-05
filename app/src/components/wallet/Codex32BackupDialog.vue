<template>
  <q-dialog
    :model-value="modelValue"
    persistent
    @update:model-value="$emit('update:modelValue', $event)"
  >
    <q-card
      style="min-width: 350px; max-width: 600px"
      data-test="backup-codex32-dialog"
    >
      <q-card-section>
        <div class="row items-center justify-between no-wrap">
          <div class="text-h6">
            {{ $t('accountRecovery.backup_account_codex32') }}
          </div>
          <div class="row items-center q-gutter-xs">
            <q-btn
              outline
              no-caps
              size="sm"
              color="primary"
              :label="`${threshold} of ${count}`"
              :disable="loading"
              data-test="codex32-scheme-btn"
              @click="$emit('cycle-scheme')"
            />
          </div>
        </div>
        <div class="text-caption text-grey-8 q-mt-xs">
          {{ $t('accountRecovery.codex32_threshold_explainer', { threshold, count }) }}
        </div>
      </q-card-section>

      <q-card-section class="q-pt-none">
        <div v-if="loading" class="text-center q-pa-md">
          <q-spinner color="primary" size="2em" />
          <div class="q-mt-sm">
            {{ $t('accountRecovery.generating_codex32_backup_shares') }}
          </div>
        </div>
        <div
          v-else-if="error"
          class="text-negative q-pa-sm"
          data-test="backup-error"
        >
          {{ error }}
        </div>
        <div v-else class="q-gutter-y-sm">
          <div
            v-for="(share, index) in shares"
            :key="index"
            class="q-pa-sm bg-grey-2 rounded-borders"
          >
            <div class="text-weight-bold text-caption q-mb-xs">
              {{ `${$t('accountRecovery.share')} ${index + 1} / ${shares.length}` }}
            </div>
            <div
              class="text-caption text-mono"
              style="word-break: break-all; font-family: monospace"
              data-test="codex32-share"
            >
              {{ share }}
            </div>
            <div class="row justify-end q-mt-xs">
              <q-btn
                flat
                dense
                no-caps
                size="sm"
                color="primary"
                :label="$t('accountRecovery.copy_share')"
                data-test="copy-share"
                @click="copyShare(share, index)"
              />
            </div>
          </div>
          <div
            v-if="copyStatus"
            role="status"
            class="text-caption text-positive q-mt-xs text-right"
          >
            {{ copyStatus }}
          </div>
        </div>
      </q-card-section>

      <q-card-actions align="right">
        <q-btn
          flat
          no-caps
          :label="$t('close')"
          color="primary"
          data-test="close-backup-dialog"
          @click="$emit('close')"
        />
      </q-card-actions>
    </q-card>
  </q-dialog>
</template>

<script setup lang="ts">
import { ref, computed, watch } from 'vue'

const props = withDefaults(
  defineProps<{
    modelValue: boolean
    loading: boolean
    error: string
    shares: readonly string[]
    threshold?: number
    count?: number
  }>(),
  {
    threshold: 2,
    count: 3,
  },
)

const emit = defineEmits([
  'update:modelValue',
  'close',
  'cycle-scheme',
])

const copyStatus = ref('')

async function copyShare(share: string, index: number) {
  try {
    await navigator.clipboard.writeText(share)
    copyStatus.value = `Share ${index + 1} copied.`
  } catch {
    copyStatus.value = 'Failed to copy share.'
  }
}
</script>
