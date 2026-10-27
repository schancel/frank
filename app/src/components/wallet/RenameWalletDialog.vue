<template>
  <q-dialog
    :model-value="modelValue"
    data-test="rename-wallet-dialog"
    @update:model-value="$emit('update:modelValue', $event)"
  >
    <q-card
      style="min-width: 320px; max-width: 450px"
      data-test="rename-wallet-card"
    >
      <q-card-section>
        <div class="text-h6">{{ $t('walletPanel.renameWallet') }}</div>
      </q-card-section>

      <q-card-section class="q-pt-none">
        <q-input
          v-model="inputName"
          dense
          outlined
          autofocus
          :label="$t('walletPanel.walletName')"
          :placeholder="defaultName"
          data-test="rename-wallet-input"
          @keyup.enter="handleSave"
        />
      </q-card-section>

      <q-card-actions align="between">
        <q-btn
          v-if="currentName"
          flat
          dense
          no-caps
          color="grey-7"
          :label="$t('walletPanel.resetDefault')"
          data-test="rename-wallet-reset-btn"
          @click="handleReset"
        />
        <div v-else />
        <div class="row q-gutter-xs">
          <q-btn
            flat
            no-caps
            :label="$t('walletPanel.cancel')"
            color="primary"
            data-test="rename-wallet-cancel-btn"
            @click="handleClose"
          />
          <q-btn
            unelevated
            no-caps
            :label="$t('walletPanel.saveName')"
            color="primary"
            data-test="rename-wallet-save-btn"
            @click="handleSave"
          />
        </div>
      </q-card-actions>
    </q-card>
  </q-dialog>
</template>

<script setup lang="ts">
import { ref, watch } from 'vue'

const props = withDefaults(
  defineProps<{
    modelValue: boolean
    chain?: string
    currentName?: string
    defaultName?: string
  }>(),
  {
    chain: '',
    currentName: '',
    defaultName: '',
  },
)

const emit = defineEmits<{
  (e: 'update:modelValue', value: boolean): void
  (e: 'save', name: string): void
  (e: 'reset'): void
}>()

const inputName = ref('')

watch(
  () => props.modelValue,
  open => {
    if (open) {
      inputName.value = props.currentName || ''
    }
  },
  { immediate: true },
)

function handleSave() {
  emit('save', inputName.value.trim())
  emit('update:modelValue', false)
}

function handleReset() {
  emit('reset')
  emit('update:modelValue', false)
}

function handleClose() {
  emit('update:modelValue', false)
}
</script>
