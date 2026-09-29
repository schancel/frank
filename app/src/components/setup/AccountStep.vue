<template>
  <div class="col q-gutter-y-md">
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
          val =>
            validateProfileDisplayName(val).valid || $t('profile.pleaseType'),
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
        :rules="[val => isSeedValid || $t('profile.invalidSeed')]"
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
        v-if="action === 'new'"
        flat
        class="q-pa-xs q-ma-none"
        color="primary"
        icon="refresh"
        :aria-label="$t('accountStep.refreshRecoveryPhrase')"
        @click="generateMnemonic"
      />
    </div>
  </div>
</template>

<script lang="ts">
import { computed, defineComponent, PropType, ref } from 'vue'
import { copyToClipboard } from 'quasar'

import { generateMnemonic, validateMnemonic } from 'bip39'
import { seedCopiedNotify } from '../../utils/notifications'
import { normalizeSetupMnemonic } from '../../utils/setup-account'
import { validateProfileDisplayName } from '@frank/wallet/profile-display-name'

interface AccountData {
  name: string
  seed: string
  valid?: boolean
  nameRequired?: boolean
}

export default defineComponent({
  model: {
    accountData: Object,
  },
  props: {
    accountData: {
      type: Object as PropType<AccountData>,
      required: true,
    },
  },
  emits: ['update:account-data'],
  setup(props, { emit }) {
    const action = ref('none')
    const rawName = ref(props.accountData.name)
    const rawSeed = ref(props.accountData.seed)
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

    return {
      action,
      rawName,
      rawSeed,
      isSeedValid,
      isValid,
      validateProfileDisplayName,
      seed,
      name,
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
        rawSeed.value = generateMnemonic()
        emitAccountData()
      },
      newAccount() {
        action.value = 'new'
        rawName.value = ''
        emitAccountData()
      },
      importAccount() {
        action.value = 'import'
        rawSeed.value = ''
        emitAccountData()
      },
    }
  },
})
</script>
