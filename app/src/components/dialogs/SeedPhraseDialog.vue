<template>
  <q-card class="q-px-sm q-pb-md dialog-medium" data-test="seed-phrase-dialog">
    <q-card-section>
      <div class="text-h6">{{ $t('seedPhraseDialog.seedPhrase') }}</div>
    </q-card-section>

    <!-- Disclosure / Warning state: plaintext is never rendered before explicit user consent (#536) -->
    <template v-if="!revealed">
      <q-card-section class="q-pt-none">
        <q-banner
          class="bg-amber-1 text-black q-mb-md"
          rounded
          dense
          data-test="disclosure-banner"
        >
          <template #avatar>
            <q-icon name="warning" color="warning" />
          </template>
          <div class="text-weight-medium">
            {{ $t('seedPhraseDialog.warningTitle') }}
          </div>
          <div class="text-caption text-grey-9 q-mt-xs">
            {{ $t('seedPhraseDialog.warningBody') }}
          </div>
        </q-banner>
        <p class="text-body2 text-grey-8" data-test="disclosure-text">
          {{ $t('seedPhraseDialog.disclosureText') }}
        </p>
      </q-card-section>

      <q-card-actions align="right">
        <q-btn
          flat
          :label="$t('seedPhraseDialog.cancel')"
          color="grey-7"
          v-close-popup
          data-test="cancel-disclosure-btn"
        />
        <q-btn
          unelevated
          color="warning"
          text-color="dark"
          icon="visibility"
          data-test="reveal-seed-btn"
          :label="$t('seedPhraseDialog.revealButton')"
          @click="revealPhrase"
        />
      </q-card-actions>
    </template>

    <!-- Revealed state: plaintext is visible only after passing the disclosure step -->
    <template v-else>
      <q-card-section class="q-pt-none">
        <div
          class="text-caption text-negative q-mb-sm flex items-center"
          role="status"
          aria-live="polite"
        >
          <q-icon name="visibility" size="xs" class="q-mr-xs" />
          {{ $t('seedPhraseDialog.keepPrivateNotice') }}
        </div>
        <q-input
          autogrow
          class="text-bold text-h6"
          data-test="seed-phrase-input"
          :model-value="renderedPhrase"
          filled
          readonly
        />
      </q-card-section>

      <q-card-actions align="right">
        <q-btn
          flat
          icon="file_copy"
          :label="
            copied
              ? $t('seedPhraseDialog.copied')
              : $t('seedPhraseDialog.copyButton')
          "
          :aria-label="$t('accountStep.copyRecoveryPhrase')"
          size="sm"
          color="primary"
          data-test="copy-seed-btn"
          @click="copySeed"
        />
        <q-btn
          flat
          icon="visibility_off"
          :label="$t('seedPhraseDialog.hideButton')"
          color="primary"
          data-test="hide-seed-btn"
          @click="hidePhrase"
        />
        <q-btn
          flat
          :label="$t('close')"
          color="primary"
          v-close-popup
          data-test="close-seed-dialog-btn"
        />
      </q-card-actions>
    </template>
  </q-card>
</template>

<script lang="ts">
import { copyToClipboard, useQuasar } from 'quasar'
import { useWalletStore } from 'src/stores/wallet'
import { defineComponent, onBeforeUnmount, ref } from 'vue'

export default defineComponent({
  emits: ['close'],
  setup(_props, { emit }) {
    const walletStore = useWalletStore()
    const $q = useQuasar()
    const revealed = ref(false)
    const renderedPhrase = ref('')
    const copied = ref(false)
    let copyResetTimer: ReturnType<typeof setTimeout> | undefined

    function revealPhrase() {
      renderedPhrase.value = walletStore.seedPhrase ?? ''
      revealed.value = true
    }

    function hidePhrase() {
      renderedPhrase.value = ''
      revealed.value = false
      copied.value = false
      if (copyResetTimer) {
        clearTimeout(copyResetTimer)
      }
    }

    const copySeed = () => {
      const phrase = renderedPhrase.value || walletStore.seedPhrase
      if (!phrase) {
        return
      }
      copyToClipboard(phrase)
        .then(() => {
          copied.value = true
          $q.notify({
            message: $q.lang.getLocale()?.startsWith('fr')
              ? 'Phrase de récupération copiée dans le presse-papiers'
              : 'Recovery phrase copied to clipboard',
            color: 'positive',
            icon: 'check',
          })
          if (copyResetTimer) {
            clearTimeout(copyResetTimer)
          }
          copyResetTimer = setTimeout(() => {
            copied.value = false
          }, 3000)
        })
        .catch(() => {
          // fail soft
        })
    }

    function reset() {
      hidePhrase()
    }

    onBeforeUnmount(() => {
      reset()
    })

    return {
      revealed,
      renderedPhrase,
      copied,
      revealPhrase,
      hidePhrase,
      copySeed,
      reset,
      onClose() {
        reset()
        emit('close')
      },
    }
  },
  props: {
    address: {
      type: String,
      default: () => '',
    },
    name: {
      type: String,
      default: () => '',
    },
  },
})
</script>
