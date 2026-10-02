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
          :disable="locked"
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
          :disable="locked"
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
        :readonly="locked"
        :label="$t('profile.name')"
        lazy-rules
        style="width: 100%"
        :rules="[
          val => profileNameRule(val, (key, params) => $t(key, params ?? {})),
        ]"
        @blur="commitName"
      />
      <q-input
        ref="seedInput"
        :readonly="locked || action === 'new'"
        v-model="seed"
        :label="$t('profile.seedEntry')"
        type="textarea"
        filled
        rows="2"
        lazy-rules
        :error="isSeedInvalid"
        :error-message="seedValidationKey ? $t(seedValidationKey) : ''"
        :rules="[
          () =>
            !isSeedInvalid || (seedValidationKey ? $t(seedValidationKey) : ''),
        ]"
        :aria-invalid="isSeedInvalid ? 'true' : 'false'"
        :placeholder="$t('profile.enterSeed')"
        @blur="onSeedBlur"
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
        :disable="locked"
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
        :disabled="locked"
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
        <p :id="differentWarningId" class="q-ma-none text-negative" role="note">
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
          :disabled="locked"
          style="width: 100%; padding: 8px"
          :aria-invalid="differentMismatch ? 'true' : 'false'"
          :aria-describedby="`${differentWarningId} ${differentStatusId}`"
        />
        <div
          :id="differentStatusId"
          role="status"
          aria-live="polite"
          class="text-negative"
        >
          {{ differentMismatch ? $t('replaceGuard.mismatch') : '' }}
        </div>
        <button
          type="submit"
          data-test="import-different-confirm"
          :disabled="locked"
        >
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
  watch,
} from 'vue'
import { copyToClipboard } from 'quasar'

import { generateMnemonic, validateMnemonic } from 'bip39'
import { seedCopiedNotify } from '../../utils/notifications'
import {
  getMnemonicValidationKey,
  normalizeSetupMnemonic,
} from '../../utils/setup-account'
import { validateProfileDisplayName } from '@frank/wallet/profile-display-name'
import { profileNameRule } from 'src/utils/profile-name'

interface AccountData {
  name: string
  seed: string
  valid?: boolean
  nameRequired?: boolean
}

interface FocusableInput {
  focus(): void
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
    resumeImportAcknowledged: {
      type: Boolean,
      default: false,
    },
    locked: {
      type: Boolean,
      default: false,
    },
  },
  emits: ['update:account-data', 'resume-import-acknowledged'],
  setup(props, { emit }) {
    const phraseUid = ++differentPhraseCounter
    const action = ref(
      props.resume
        ? props.resumeImportAcknowledged
          ? 'import'
          : 'new'
        : 'none',
    )
    const rawName = ref(props.accountData.name)
    const rawSeed = ref(props.accountData.seed)
    const differentOpen = ref(false)
    const differentTyped = ref('')
    const differentMismatch = ref(false)
    const differentInput = ref<HTMLInputElement | null>(null)
    const seedInput = ref<FocusableInput | null>(null)
    const seedBlurred = ref(false)
    const isSeedValid = computed(() => {
      const normalized = normalizeSetupMnemonic(rawSeed.value)
      return Boolean(normalized && validateMnemonic(normalized))
    })
    const seedValidationKey = computed(() => {
      if (action.value !== 'import') return null
      if (!seedBlurred.value) return null
      if (!rawSeed.value.trim()) return null
      if (isSeedValid.value) return null
      return getMnemonicValidationKey(rawSeed.value)
    })
    const isSeedInvalid = computed(() => seedValidationKey.value !== null)
    const onSeedBlur = () => {
      seedBlurred.value = true
    }
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
      if (props.locked) return
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
        if (props.locked) return
        rawSeed.value = val
        emitAccountData()
      },
    })

    const name = computed({
      get() {
        return rawName.value
      },
      set(val: string) {
        if (props.locked) return
        rawName.value = val
        emitAccountData()
      },
    })

    // Resume mode has no New/Import choice to click: publish the (stored-seed) account data now.
    onMounted(() => {
      if (props.resume) emitAccountData()
    })
    watch(
      () => props.locked,
      locked => {
        if (!locked) return
        rawName.value = props.accountData.name
        rawSeed.value = props.accountData.seed
      },
    )

    return {
      action,
      rawName,
      rawSeed,
      isSeedValid,
      seedBlurred,
      seedValidationKey,
      isSeedInvalid,
      onSeedBlur,
      isValid,
      profileNameRule,
      seed,
      name,
      differentOpen,
      differentTyped,
      differentMismatch,
      differentInput,
      seedInput,
      differentFormId: `import-different-form-${phraseUid}`,
      differentInputId: `import-different-input-${phraseUid}`,
      differentWarningId: `import-different-warning-${phraseUid}`,
      differentStatusId: `import-different-status-${phraseUid}`,
      openDifferentPhrase() {
        if (props.locked || !props.resume || action.value !== 'new') return
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
        if (props.locked) return
        emit('resume-import-acknowledged')
        differentOpen.value = false
        differentMismatch.value = false
        differentTyped.value = ''
        seedBlurred.value = false
        action.value = 'import'
        rawName.value = ''
        rawSeed.value = ''
        emitAccountData()
        void nextTick(() => seedInput.value?.focus())
      },
      commitName() {
        if (props.locked || action.value !== 'new') return
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
        if (props.locked || props.resume) return
        rawSeed.value = generateMnemonic()
        emitAccountData()
      },
      newAccount() {
        if (props.locked) return
        seedBlurred.value = false
        action.value = 'new'
        rawName.value = ''
        if (!props.resume) {
          rawSeed.value = generateMnemonic()
        }
        emitAccountData()
      },
      importAccount() {
        if (props.locked || props.resume) return
        seedBlurred.value = false
        action.value = 'import'
        rawSeed.value = ''
        emitAccountData()
      },
    }
  },
  methods: {
    tryDifferentPhrase() {
      if (this.locked) return
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
