<template>
  <q-header>
    <q-toolbar class="q-pl-sm">
      <q-btn
        flat
        dense
        class="q-px-sm"
        icon="arrow_back"
        :aria-label="$t('settings.back')"
        data-test="settings-back"
        @click="cancel"
      />
      <q-toolbar-title class="h6">{{ $t('settings.title') }}</q-toolbar-title>
      <q-btn
        flat
        dense
        class="q-px-sm"
        icon="menu"
        :aria-label="$t('settings.openMenu')"
        data-test="settings-menu"
        @click="$emit('toggleMyDrawerOpen')"
      />
    </q-toolbar>
  </q-header>
  <q-page-container>
    <q-page class="q-ma-none q-pa-sm">
      <q-card>
        <q-splitter :model-value="130" unit="px" disable>
          <template #before>
            <q-tabs v-model="tab" vertical class="text-primary">
              <q-tab
                name="networking"
                icon="cloud"
                :label="$t('settings.networking')"
              />
              <q-tab
                name="appearance"
                icon="color_lens"
                :label="$t('settings.appearance')"
              />
              <q-tab
                name="storage"
                icon="save"
                :label="$t('persistentStorage.tab')"
              />
              <q-tab
                name="recovery"
                icon="security"
                :label="$t('accountRecovery.frank_account_recovery')"
              />
            </q-tabs>
          </template>
          <template #after>
            <q-tab-panels
              v-model="tab"
              animated
              swipeable
              vertical
              transition-prev="jump-up"
              transition-next="jump-up"
            >
              <q-tab-panel name="networking">
                <div class="row">
                  <q-input
                    outlined
                    v-model="updateInterval"
                    :label="$t('settings.contactRefreshInterval')"
                    type="number"
                    :hint="$t('settings.contactRefreshIntervalHint')"
                    style="width: 100%"
                    ref="contactRefreshInterval"
                  />
                </div>
              </q-tab-panel>
              <q-tab-panel name="appearance">
                <div class="row">
                  <q-toggle
                    :label="$t('settings.darkMode')"
                    v-model="darkMode"
                  />
                </div>
                <div style="height: 2rem"></div>
                <div class="row">
                  <q-select
                    v-model="locale"
                    :options="localeOptions"
                    :label="$t('settings.languageSelectorCaption')"
                    dense
                    borderless
                    emit-value
                    map-options
                    options-dense
                    style="min-width: 150px"
                  />
                </div>
              </q-tab-panel>
              <q-tab-panel name="storage">
                <persistent-storage-panel />
              </q-tab-panel>
              <q-tab-panel name="recovery">
                <div v-if="account.account" class="q-pa-sm">
                  <div class="text-subtitle1 text-weight-medium q-mb-sm">
                    {{ $t('accountRecovery.frank_account_recovery') }}
                  </div>
                  <div class="q-my-md">
                    <q-btn
                      unelevated
                      no-caps
                      color="primary"
                      icon="security"
                      class="full-width q-py-sm"
                      :label="$t('accountRecovery.backup_account_codex32')"
                      data-test="backup-codex32-button"
                      @click="openBackupDialog"
                    />
                    <div class="text-caption text-grey-8 q-mt-xs">
                      {{ $t('accountRecovery.write_down_each_paper_share') }}
                    </div>
                  </div>

                  <q-expansion-item
                    icon="info"
                    :label="$t('accountRecovery.public_recovery_descriptor')"
                    :caption="$t('accountRecovery.advanced_details')"
                    class="q-mt-md text-grey-9"
                    header-class="text-weight-medium"
                    data-test="advanced-recovery-details"
                  >
                    <div class="q-pa-sm">
                      <p class="text-caption text-grey-8">
                        {{
                          $t(
                            'accountRecovery.backup_shares_were_verified_before_activation_keep',
                          )
                        }}
                      </p>
                      <q-input
                        :model-value="account.account.descriptor"
                        readonly
                        outlined
                        class="q-my-md"
                        :label="
                          $t('accountRecovery.public_recovery_descriptor')
                        "
                        data-test="recovery-descriptor"
                      />
                      <div class="row items-center q-gutter-sm q-my-sm">
                        <q-btn
                          color="primary"
                          outline
                          :label="$t('accountRecovery.copy_public_descriptor')"
                          data-test="copy-descriptor"
                          @click="copyDescriptor"
                        />
                        <span
                          role="status"
                          aria-live="polite"
                          data-test="copy-status"
                          class="text-caption"
                        >
                          {{ copyStatus }}
                        </span>
                      </div>
                      <p
                        class="text-caption text-grey-8 q-mt-md"
                        style="overflow-wrap: anywhere"
                      >
                        {{ $t('accountRecovery.fingerprint') }}:
                        {{ account.account.fingerprint }}
                      </p>
                    </div>
                  </q-expansion-item>
                </div>
                <div v-else class="q-pa-sm">
                  <p class="text-grey-7">
                    {{ $t('accountRecovery.balance_unavailable') }}
                  </p>
                </div>
              </q-tab-panel>
            </q-tab-panels>
          </template>
        </q-splitter>
        <q-card-actions align="right">
          <q-btn
            @click="cancel"
            :label="$t('settings.cancelSettings')"
            color="negative"
            class="q-ma-sm"
          />
          <q-btn
            @click="save"
            :label="$t('settings.saveSettings')"
            color="primary"
            class="q-ma-sm"
          />
        </q-card-actions>
      </q-card>
      <codex32-backup-dialog
        v-model="showBackupDialog"
        :loading="backupLoading"
        :error="backupError"
        :shares="backupShares"
        :threshold="threshold"
        :count="count"
        @cycle-scheme="cycleScheme"
        @change-scheme="setScheme"
        @close="closeBackupDialog"
      />
    </q-page>
  </q-page-container>
</template>

<script lang="ts">
import { navigateBack } from 'src/utils/navigate-back'
import { localeOptions } from 'src/i18n'
import { applyLocale } from 'src/utils/apply-locale'

import { defineComponent, ref } from 'vue'
import { QInput } from 'quasar'

import { useAppearanceStore } from 'src/stores/appearance'
import { useContactStore } from 'src/stores/contacts'
import { storeToRefs } from 'pinia'
import { accountStatus as account } from 'src/accounts/session'
import PersistentStoragePanel from 'src/components/settings/PersistentStoragePanel.vue'
import Codex32BackupDialog from 'src/components/wallet/Codex32BackupDialog.vue'
import { useCodex32Backup } from 'src/composables/useCodex32Backup'
const msToMinutes = 60000

export default defineComponent({
  components: { PersistentStoragePanel, Codex32BackupDialog },
  emits: ['toggleMyDrawerOpen'],
  setup() {
    const appearanceStore = useAppearanceStore()
    const contactStore = useContactStore()
    const { updateInterval: storeUpdateInterval } = storeToRefs(contactStore)
    const { darkMode: storeDarkMode, locale: storeLocale } =
      storeToRefs(appearanceStore)

    const {
      showBackupDialog,
      backupLoading,
      backupError,
      backupShares,
      threshold,
      count,
      openBackupDialog,
      closeBackupDialog,
      cycleScheme,
      setScheme,
    } = useCodex32Backup()

    const copyStatus = ref('')
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

    return {
      darkMode: ref(storeDarkMode.value),
      updateInterval: ref(storeUpdateInterval.value / msToMinutes),
      // A local draft, not bound to vue-i18n's own global locale -- ticket #156: selecting an
      // option must never affect the app until Save, the same as darkMode/updateInterval above.
      locale: ref(storeLocale.value),
      contactRefreshInterval: ref<QInput | null>(null),
      storeDarkMode,
      storeUpdateInterval,
      storeLocale,
      localeOptions,
      account,
      copyStatus,
      copyDescriptor,
      showBackupDialog,
      backupLoading,
      backupError,
      backupShares,
      threshold,
      count,
      openBackupDialog,
      closeBackupDialog,
      cycleScheme,
      setScheme,
    }
  },
  data() {
    return {
      tab: 'networking',
    }
  },
  methods: {
    save() {
      this.storeDarkMode = this.darkMode
      this.$q.dark.set(this.darkMode)
      this.storeUpdateInterval = this.updateInterval * msToMinutes
      this.storeLocale = this.locale
      void applyLocale({
        $q: this.$q,
        setI18nLocale: value => {
          this.$i18n.locale = value
        },
        locale: this.locale,
      })
      navigateBack(this.$router)
    },
    cancel() {
      // Discard the draft -- it was never applied anywhere, so there's nothing else to undo.
      this.locale = this.storeLocale
      navigateBack(this.$router)
    },
  },
  mounted() {
    this.contactRefreshInterval?.focus()
  },
})
</script>
