<template>
  <form
    ref="form"
    class="sync-pin-entry"
    data-test="sync-pin-entry"
    @submit.prevent="connect"
  >
    <ol
      class="text-body2 q-pl-md q-my-xs"
      data-test="account-sync-instructions"
    >
      <li>{{ $t('accountSync.sourceStep') }}</li>
      <li>{{ $t('accountSync.pinStep') }}</li>
    </ol>
    <div class="row items-start q-gutter-sm q-mt-xs no-wrap">
      <q-input
        v-model="pin"
        autofocus
        dense
        outlined
        class="sync-pin-entry__input"
        :label="$t('accountSync.pinLabel')"
        inputmode="numeric"
        autocomplete="one-time-code"
        :maxlength="SYNC_PIN_DIGITS"
        :disable="pending || busy"
        data-test="sync-pin-input"
      />
      <q-btn
        unelevated
        no-caps
        color="primary"
        type="submit"
        :label="$t('accountSync.connect')"
        :loading="pending || busy"
        :disable="!pinComplete || pending || busy"
        data-test="sync-pin-connect"
      />
    </div>
    <div
      v-if="error"
      role="alert"
      class="text-caption text-negative q-mt-xs"
      data-test="sync-pin-error"
    >
      {{ error }}
    </div>
  </form>
</template>

<script lang="ts">
import { computed, defineComponent, nextTick, onMounted, ref } from 'vue'
import { useTranslate } from 'src/composables/useTranslate'
import { receiveAccountOverBridge } from 'src/utils/extension-account-sync'
import { normalizeSyncPin, SYNC_PIN_DIGITS } from 'src/utils/sync-pairing'

/**
 * The receiving side of account sync: the user types the PIN the other Frank
 * window shows, and this emits the account bundle once the PIN pairing succeeds.
 */
export default defineComponent({
  name: 'SyncPinEntry',
  props: {
    busy: { type: Boolean, default: false },
  },
  emits: ['received'],
  setup(_, { emit }) {
    const t = useTranslate()
    const form = ref<HTMLFormElement | null>(null)
    onMounted(async () => {
      await nextTick()
      form.value?.scrollIntoView?.({ block: 'nearest' })
    })
    const pin = ref('')
    const pending = ref(false)
    const error = ref('')
    const pinComplete = computed(() => normalizeSyncPin(pin.value) !== null)

    async function connect() {
      const normalized = normalizeSyncPin(pin.value)
      if (!normalized || pending.value) return
      pending.value = true
      error.value = ''
      try {
        const result = await receiveAccountOverBridge(normalized)
        if (result.ok) {
          pin.value = ''
          emit('received', result.bundle)
        } else if (result.reason === 'pin-mismatch') {
          pin.value = ''
          error.value = t('accountSync.pinMismatch')
        } else if (result.reason === 'has-account') {
          error.value = t('accountSync.hasAccount')
        } else if (
          result.reason === 'no-sender' ||
          result.reason === 'expired'
        ) {
          error.value = t('accountSync.noSender')
        } else {
          error.value = t('accountSync.failed')
        }
      } catch {
        error.value = t('accountSync.failed')
      } finally {
        pending.value = false
      }
    }

    return { form, pin, pending, error, pinComplete, connect, SYNC_PIN_DIGITS }
  },
})
</script>

<style lang="scss" scoped>
.sync-pin-entry__input {
  max-width: 10rem;
}
</style>
