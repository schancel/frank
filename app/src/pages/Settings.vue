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
              <q-tab
                name="storage"
                icon="save"
                :label="$t('persistentStorage.tab')"
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
                <div class="row items-center q-mb-md">
                  <q-toggle
                    :label="$t('settings.darkMode')"
                    v-model="darkMode"
                  />
                </div>
                <div class="q-mb-lg">
                  <div class="text-subtitle2 q-mb-sm">
                    {{ $t('settings.themeTitle') }}
                  </div>
                  <div class="row q-gutter-sm">
                    <q-chip
                      v-for="stone in themeOptions"
                      :key="stone.id"
                      clickable
                      :selected="theme === stone.id"
                      @click="theme = stone.id"
                      outline
                      :color="theme === stone.id ? 'primary' : ''"
                      class="cursor-pointer"
                    >
                      <q-avatar
                        :style="{ backgroundColor: stone.stoneColor }"
                        size="18px"
                        class="q-mr-xs"
                      />
                      <span>{{ stone.label }}</span>
                    </q-chip>
                  </div>
                  <div class="text-caption text-grey q-mt-xs">
                    {{ selectedThemeDescription }}
                  </div>
                </div>
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
import {
  DEFAULT_SIGNET_THEME,
  SIGNET_THEMES,
  SignetStone,
  applyTheme,
} from 'src/utils/theme'

import { defineComponent, ref } from 'vue'
import { QInput } from 'quasar'

import { useAppearanceStore } from 'src/stores/appearance'
import { useContactStore } from 'src/stores/contacts'
import { storeToRefs } from 'pinia'
import PersistentStoragePanel from 'src/components/settings/PersistentStoragePanel.vue'
const msToMinutes = 60000

export default defineComponent({
  components: { PersistentStoragePanel },
  emits: ['toggleMyDrawerOpen'],
  setup() {
    const appearanceStore = useAppearanceStore()
    const contactStore = useContactStore()
    const { updateInterval: storeUpdateInterval } = storeToRefs(contactStore)
    const {
      darkMode: storeDarkMode,
      locale: storeLocale,
      theme: storeTheme,
    } = storeToRefs(appearanceStore)

    const theme = ref<SignetStone>(
      (storeTheme && storeTheme.value) || DEFAULT_SIGNET_THEME,
    )
    const themeOptions = Object.values(SIGNET_THEMES)

    return {
      darkMode: ref(storeDarkMode.value),
      theme,
      themeOptions,
      updateInterval: ref(storeUpdateInterval.value / msToMinutes),
      // A local draft, not bound to vue-i18n's own global locale -- ticket #156: selecting an
      // option must never affect the app until Save, the same as darkMode/updateInterval above.
      locale: ref(storeLocale.value),
      contactRefreshInterval: ref<QInput | null>(null),
      storeDarkMode,
      storeTheme,
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
  computed: {
    selectedThemeDescription(): string {
      const selected = SIGNET_THEMES[this.theme]
      return selected ? selected.tagline : ''
    },
  },
  methods: {
    save() {
      this.storeDarkMode = this.darkMode
      this.$q.dark.set(this.darkMode)
      if (this.storeTheme !== undefined) {
        this.storeTheme = this.theme
      }
      applyTheme(this.theme, this.darkMode)
      this.storeUpdateInterval = this.updateInterval * msToMinutes
      this.storeLocale = this.locale
      void applyLocale({
        $q: this.$q,
        setI18nLocale: value => {
          this.$i18n.locale = value
        },
        locale: this.locale,
      })
      if (typeof this.$q.notify === 'function') {
        this.$q.notify({
          type: 'positive',
          message: this.$t('settings.savedNotification'),
          timeout: 2000,
        })
      }
    },
    cancel() {
      // Discard the draft -- it was never applied anywhere, so there's nothing else to undo.
      this.locale = this.storeLocale
      if (this.storeTheme !== undefined) {
        this.theme = this.storeTheme
      }
      navigateBack(this.$router)
    },
  },
  mounted() {
    this.contactRefreshInterval?.focus()
  },
})
</script>
