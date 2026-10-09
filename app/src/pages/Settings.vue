<template>
  <div>
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
      <q-page class="q-ma-none q-pa-none column full-height">
        <q-card flat class="col column full-width full-height bg-transparent">
          <q-splitter
            :model-value="120"
            unit="px"
            disable
            class="col full-height"
          >
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
                  name="gateways"
                  icon="alt_route"
                  :label="$t('settings.gateways')"
                  data-test="settings-tab-gateways"
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
                  <q-separator class="q-my-md" />
                  <div class="text-subtitle2 q-mb-sm">
                    {{ $t('settings.networkModeTitle') }}
                  </div>
                  <div class="row items-center justify-between q-mb-sm">
                    <div>
                      <div class="text-body2 text-weight-medium">
                        {{ $t('settings.testnetMode') }}
                      </div>
                      <div class="text-caption text-grey">
                        {{ $t('settings.testnetModeLockedHint') }}
                      </div>
                    </div>
                    <q-toggle
                      v-model="isTestnetMode"
                      color="warning"
                      data-test="testnet-mode-toggle"
                    />
                  </div>
                  <q-banner
                    v-if="isTestnetMode"
                    dense
                    rounded
                    class="bg-amber-1 text-amber-10 q-mb-md"
                  >
                    <template #avatar>
                      <q-icon name="info" color="amber-9" />
                    </template>
                    {{ $t('settings.testnetActiveBanner') }}
                  </q-banner>
                  <q-banner
                    v-else
                    dense
                    rounded
                    class="bg-blue-1 text-blue-10 q-mb-md"
                  >
                    <template #avatar>
                      <q-icon name="verified" color="primary" />
                    </template>
                    {{ $t('settings.mainnetActiveBanner') }}
                  </q-banner>

                  <div
                    class="text-caption text-weight-medium text-grey-8 q-mb-xs"
                  >
                    {{ $t('settings.supportedChainsTitle') }}
                  </div>
                  <q-list dense class="rounded-borders">
                    <q-item
                      v-for="chain in supportedChains"
                      :key="chain.id"
                      class="q-px-none"
                    >
                      <q-item-section avatar style="min-width: 36px">
                        <q-icon
                          :name="chain.icon"
                          size="20px"
                          color="primary"
                        />
                      </q-item-section>
                      <q-item-section>
                        <q-item-label class="text-body2">
                          {{ $t(chain.defaultNameKey) }}
                        </q-item-label>
                        <q-item-label caption class="text-grey-7">
                          {{ getWalletNetworkLabel(chain, isTestnetMode, $t) }}
                        </q-item-label>
                      </q-item-section>
                      <q-item-section side>
                        <q-badge
                          :color="isTestnetMode ? 'warning' : 'primary'"
                          outline
                          :label="$t('settings.chainActive')"
                        />
                      </q-item-section>
                    </q-item>
                  </q-list>
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
                        @click="selectTheme(stone.id)"
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
                <q-tab-panel name="gateways">
                  <div class="text-subtitle2 q-mb-sm">
                    {{ $t('settings.networkSettings') }}
                  </div>
                  <q-input
                    v-model="emailGatewayInput"
                    :label="$t('settings.emailGatewayAddress')"
                    dense
                    outlined
                    :error="!!emailGatewayError"
                    :error-message="emailGatewayError"
                    hint="0x-prefixed 40-character hex address"
                    data-test="email-gateway-input"
                    data-testid="email-gateway-input"
                    class="full-width q-mb-xs"
                  />
                  <div
                    v-if="emailGatewayError"
                    class="text-negative text-caption q-mb-xs error-msg"
                    data-test="email-gateway-error"
                  >
                    {{ emailGatewayError }}
                  </div>
                  <div
                    class="row items-center justify-end q-gutter-x-sm q-mt-xs"
                  >
                    <q-btn
                      flat
                      dense
                      no-caps
                      size="sm"
                      color="grey-7"
                      :label="$t('settings.resetDefault')"
                      data-test="reset-email-gateway-btn"
                      data-testid="reset-email-gateway-btn"
                      @click="resetEmailGateway"
                    />
                    <q-btn
                      unelevated
                      dense
                      no-caps
                      size="sm"
                      color="primary"
                      :label="$t('settings.save')"
                      data-test="save-email-gateway-btn"
                      data-testid="save-email-gateway-btn"
                      @click="saveEmailGateway"
                    />
                  </div>
                </q-tab-panel>
              </q-tab-panels>
            </template>
          </q-splitter>
          <q-separator />
          <q-card-actions align="right" class="q-pa-md bg-transparent">
            <q-btn
              @click="cancel"
              :label="$t('settings.cancelSettings')"
              color="negative"
              flat
              no-caps
              class="q-mr-sm"
            />
            <q-btn
              @click="save"
              :label="$t('settings.saveSettings')"
              color="primary"
              unelevated
              no-caps
            />
          </q-card-actions>
        </q-card>
      </q-page>
    </q-page-container>
  </div>
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

import { computed, defineComponent, onUnmounted, ref, watch } from 'vue'
import { QInput } from 'quasar'

import { useAppearanceStore } from 'src/stores/appearance'
import { useContactStore } from 'src/stores/contacts'
import { useSettingsStore } from 'src/stores/settings'
import { storeToRefs } from 'pinia'
import PersistentStoragePanel from 'src/components/settings/PersistentStoragePanel.vue'
import { WALLET_CONFIGS, getWalletNetworkLabel } from 'src/utils/wallet-configs'
const msToMinutes = 60000

export default defineComponent({
  components: { PersistentStoragePanel },
  emits: [
    'toggleMyDrawerOpen',
    'toggleContactDrawerOpen',
    'setupNavigationLocked',
    'setupCompleted',
  ],
  setup() {
    const appearanceStore = useAppearanceStore()
    const contactStore = useContactStore()
    const { updateInterval: storeUpdateInterval } = storeToRefs(contactStore)
    const {
      darkMode: storeDarkMode,
      locale: storeLocale,
      theme: storeTheme,
    } = storeToRefs(appearanceStore)

    const isSaved = ref(false)
    const theme = ref<SignetStone>(
      (storeTheme && storeTheme.value) || DEFAULT_SIGNET_THEME,
    )
    const themeOptions = Object.values(SIGNET_THEMES)

    onUnmounted(() => {
      if (!isSaved.value) {
        const revertTheme =
          (storeTheme && storeTheme.value) || DEFAULT_SIGNET_THEME
        const revertDark =
          storeDarkMode && storeDarkMode.value !== undefined
            ? storeDarkMode.value
            : false
        applyTheme(revertTheme, revertDark)
      }
    })

    const settingsStore = useSettingsStore()
    const emailGatewayInput = ref(settingsStore.emailGatewayAddress)
    const emailGatewayError = ref('')

    watch(
      () => settingsStore.emailGatewayAddress,
      newVal => {
        emailGatewayInput.value = newVal
      },
    )

    function saveEmailGateway() {
      emailGatewayError.value = ''
      try {
        settingsStore.setEmailGatewayAddress(emailGatewayInput.value.trim())
        emailGatewayInput.value = settingsStore.emailGatewayAddress
      } catch (err: any) {
        emailGatewayError.value =
          err?.message || 'Invalid Ethereum address format'
      }
    }

    function resetEmailGateway() {
      emailGatewayError.value = ''
      settingsStore.resetEmailGatewayAddress()
      emailGatewayInput.value = settingsStore.emailGatewayAddress
    }

    const isTestnetMode = computed({
      get: () => settingsStore.networkMode === 'testnet',
      set: (val: boolean) => {
        settingsStore.setNetworkMode(val ? 'testnet' : 'mainnet')
      },
    })

    return {
      appearanceStore,
      isSaved,
      isTestnetMode,
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
      emailGatewayInput,
      emailGatewayError,
      saveEmailGateway,
      resetEmailGateway,
      getWalletNetworkLabel,
      supportedChains: WALLET_CONFIGS.filter(c => c.enabled !== false),
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
  beforeRouteLeave() {
    if (!this.isSaved) {
      applyTheme(
        this.storeTheme || DEFAULT_SIGNET_THEME,
        this.storeDarkMode || false,
      )
    }
  },
  methods: {
    selectTheme(stoneId: SignetStone) {
      this.theme = stoneId
      this.isSaved = false
      applyTheme(stoneId, this.darkMode)
    },
    onSelectTheme(stoneId: SignetStone) {
      this.selectTheme(stoneId)
    },
    save() {
      this.isSaved = true
      if (typeof this.appearanceStore?.setDarkMode === 'function') {
        this.appearanceStore.setDarkMode(this.darkMode)
      } else {
        this.storeDarkMode = this.darkMode
      }
      this.$q.dark.set(this.darkMode)
      if (typeof this.appearanceStore?.setTheme === 'function') {
        this.appearanceStore.setTheme(this.theme)
      } else if (this.storeTheme !== undefined) {
        this.storeTheme = this.theme
      }
      applyTheme(this.theme, this.darkMode)
      this.storeUpdateInterval = this.updateInterval * msToMinutes
      this.storeLocale = this.locale
      void applyLocale({
        $q: this.$q,
        setI18nLocale: value => {
          if (this.$i18n) {
            this.$i18n.locale = value
          }
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
      // Discard the draft -- reset theme back to store values
      this.locale = this.storeLocale
      if (this.storeTheme !== undefined) {
        this.theme = this.storeTheme
      }
      applyTheme(
        this.storeTheme || DEFAULT_SIGNET_THEME,
        this.storeDarkMode || false,
      )
      this.isSaved = true
      navigateBack(this.$router)
    },
  },
  mounted() {
    this.contactRefreshInterval?.focus()
  },
})
</script>
