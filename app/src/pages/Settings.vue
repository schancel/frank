<template>
  <q-page-container>
    <q-page class="q-ma-none q-pa-sm">
      <q-card>
        <q-splitter :model-value="110" unit="px" disable>
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
const msToMinutes = 60000

export default defineComponent({
  setup() {
    const appearanceStore = useAppearanceStore()
    const contactStore = useContactStore()
    const { updateInterval: storeUpdateInterval } = storeToRefs(contactStore)
    const { darkMode: storeDarkMode, locale: storeLocale } =
      storeToRefs(appearanceStore)

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
