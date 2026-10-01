<template>
  <div class="col q-gutter-y-md">
    <div v-if="resume" role="note" class="text-body2" data-test="resume-notice">
      {{ $t('accountStep.resumeNotice') }}
    </div>
    <div v-if="action === 'none'">
      <div class="row q-ma-xs q-ma-xs">
        <q-space />
        <q-btn
          class="q-ma-xs q-ma-xsrow"
          color="primary"
          :label="$t('accountStep.newAccount')"
          @click="newAccount"
        />
        <q-space />
      </div>
      <div class="row q-ma-xs q-ma-xs">
        <q-space />
        <q-btn
          class="row q-ma-xs q-ma-xs"
          color="primary"
          :label="$t('accountStep.importAccount')"
          @click="importAccount"
        />
        <q-space />
      </div>
    </div>

    <div v-if="action !== 'none'">
      <q-input
        v-if="action === 'new'"
        v-model="name"
        filled
        :label="$t('profile.name')"
        lazy-rules
        style="width: 100%"
        :rules="[
          val => profileNameRule(val, (key, params) => $t(key, params ?? {})),
        ]"
        @blur="commitName"
      />
      <q-input
        :readonly="action === 'new'"
        v-model="seed"
        :label="$t('profile.seedEntry')"
        type="textarea"
        filled
        rows="2"
        lazy-rules
        :rules="[val => !val || isSeedValid || $t('profile.invalidSeed')]"
        :placeholder="$t('profile.enterSeed')"
      />
      <q-btn
        v-if="action === 'new'"
        flat
        class="q-pa-xs q-ma-none"
        color="primary"
        icon="content_copy"
        :aria-label="$t('accountStep.copyRecoveryPhrase')"
        @click="copySeed"
      />
      <q-btn
        v-if="action === 'new' && !resume"
        flat
        class="q-pa-xs q-ma-none"
        color="primary"
        icon="refresh"
        :aria-label="$t('accountStep.refreshRecoveryPhrase')"
        @click="generateMnemonic"
      />
      <p
        v-if="resume && action === 'new'"
        class="q-ma-none text-body2"
        data-test="confirm-stored-first"
      >
        {{ $t('accountStep.confirmStoredFirst') }}
      </p>
      <button
        v-if="resume && action === 'new'"
        type="button"
        data-test="import-different-phrase"
        :aria-expanded="differentOpen ? 'true' : 'false'"
        :aria-controls="differentFormId"
        @click="openDifferentPhrase"
      >
        {{ $t('accountStep.importDifferentPhrase') }}
      </button>
      <form
        v-if="resume && action === 'new' && differentOpen"
        :id="differentFormId"
        class="q-gutter-y-sm"
        novalidate
        data-test="import-different-form"
        @submit.prevent="tryDifferentPhrase"
      >
        <p class="q-ma-none text-negative" role="note">
          {{ $t('replaceGuard.warning') }}
        </p>
        <label :for="differentInputId" style="display: block">
          {{ $t('replaceGuard.typeLabel', { word: $t('replaceGuard.word') }) }}
        </label>
        <input
          :id="differentInputId"
          ref="differentInput"
          v-model="differentTyped"
          type="text"
          autocomplete="off"
          autocapitalize="off"
          spellcheck="false"
          data-test="import-different-input"
          style="width: 100%; padding: 8px"
          :aria-invalid="differentMismatch ? 'true' : 'false'"
          :aria-describedby="differentStatusId"
        />
        <div
          :id="differentStatusId"
          role="status"
          aria-live="polite"
          class="text-negative"
        >
          {{ differentMismatch ? $t('replaceGuard.mismatch') : '' }}
        </div>
        <button type="submit" data-test="import-different-confirm">
          {{ $t('accountStep.importDifferentContinue') }}
        </button>
      </form>
    </div>
  </div>
</template>

<script lang="ts">
import {
  computed,
  defineComponent,
  nextTick,
  onMounted,
  PropType,
  ref,
} from 'vue'
import { copyToClipboard } from 'quasar'

import { generateMnemonic, validateMnemonic } from 'bip39'
import { seedCopiedNotify } from '../../utils/notifications'
import { normalizeSetupMnemonic } from '../../utils/setup-account'
import { validateProfileDisplayName } from '@frank/wallet/profile-display-name'
import { profileNameRule } from 'src/utils/profile-name'

interface AccountData {
  name: string
  seed: string
  valid?: boolean
  nameRequired?: boolean
}

let differentPhraseCounter = 0

export default defineComponent({
  model: {
    accountData: Object,
  },
  props: {
    accountData: {
      type: Object as PropType<AccountData>,
      required: true,
    },
    /**
     * Resume mode (#284): the wallet already holds a seed but no account name. The stored phrase
     * is shown read-only. New/generate stay hidden. A different phrase (#387) is reachable only
     * after the same typed acknowledgement as the replace-seed guard, and nothing is written here.
     */
    resume: {
      type: Boolean,
      default: false,
    },
  },
  emits: ['update:account-data', 'resume-import-acknowledged'],
  setup(props, { emit }) {
    const phraseUid = ++differentPhraseCounter
    const action = ref(props.resume ? 'new' : 'none')
    const rawName = ref(props.accountData.name)
    const rawSeed = ref(props.accountData.seed)
    const differentOpen = ref(false)
    const differentTyped = ref('')
    const differentMismatch = ref(false)
    const differentInput = ref<HTMLInputElement | null>(null)
    const isSeedValid = computed(() => {
      return validateMnemonic(normalizeSetupMnemonic(rawSeed.value))
    })
    const displayName = computed(() =>
      validateProfileDisplayName(rawName.value),
    )
    const isValid = computed(() => {
      if (action.value === 'new') {
        return displayName.value.valid && isSeedValid.value
      }
      if (action.value === 'import') {
        return isSeedValid.value
      }
      return false
    })
    const emitAccountData = () => {
      emit('update:account-data', {
        name:
          action.value === 'new' ? displayName.value.normalized : rawName.value,
        seed: normalizeSetupMnemonic(rawSeed.value),
        valid: isValid.value,
        nameRequired: action.value === 'new',
      })
    }
    const seed = computed({
      get() {
        return rawSeed.value
      },
      set(val: string) {
        rawSeed.value = val
        emitAccountData()
      },
    })

    const name = computed({
      get() {
        return rawName.value
      },
      set(val: string) {
        rawName.value = val
        emitAccountData()
      },
    })

    // Resume mode has no New/Import choice to click: publish the (stored-seed) account data now.
    onMounted(() => {
      if (props.resume) emitAccountData()
    })

    return {
      action,
      rawName,
      rawSeed,
      isSeedValid,
      isValid,
      profileNameRule,
      seed,
      name,
      differentOpen,
      differentTyped,
      differentMismatch,
      differentInput,
      differentFormId: `import-different-form-${phraseUid}`,
      differentInputId: `import-different-input-${phraseUid}`,
      differentStatusId: `import-different-status-${phraseUid}`,
      openDifferentPhrase() {
        if (!props.resume || action.value !== 'new') return
        if (differentOpen.value) {
          differentOpen.value = false
          differentTyped.value = ''
          differentMismatch.value = false
          return
        }
        differentOpen.value = true
        differentTyped.value = ''
        differentMismatch.value = false
        void nextTick(() => differentInput.value?.focus())
      },
      // Parent records the acknowledgement before this draft changes. Neither side writes.
      acceptDifferentPhrase() {
        emit('resume-import-acknowledged')
        differentOpen.value = false
        differentMismatch.value = false
        differentTyped.value = ''
        action.value = 'import'
        rawName.value = ''
        rawSeed.value = ''
        emitAccountData()
      },
      commitName() {
        if (action.value !== 'new') return
        rawName.value = displayName.value.normalized
        emitAccountData()
      },
      copySeed() {
        copyToClipboard(seed.value)
          .then(() => {
            seedCopiedNotify()
          })
          .catch(() => {
            // fail
          })
      },
      generateMnemonic() {
        if (props.resume) return
        rawSeed.value = generateMnemonic()
        emitAccountData()
      },
      newAccount() {
        action.value = 'new'
        rawName.value = ''
        emitAccountData()
      },
      importAccount() {
        if (props.resume) return
        action.value = 'import'
        rawSeed.value = ''
        emitAccountData()
      },
    }
  },
  methods: {
    tryDifferentPhrase() {
      if (this.differentTyped.trim() !== this.$t('replaceGuard.word')) {
        this.differentMismatch = true
        void nextTick(() => this.differentInput?.focus())
        return
      }
      this.acceptDifferentPhrase()
    },
  },
})
</script>
