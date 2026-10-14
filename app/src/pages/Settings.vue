<template>
  <div class="settings-container column full-height overflow-hidden">
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
    <q-page-container class="col full-height overflow-hidden">
      <q-page
        class="settings-page q-ma-none q-pa-none column no-wrap col full-height overflow-hidden"
        :style-fn="pageStyle"
      >
        <q-card
          flat
          class="settings-content col column full-width full-height bg-transparent"
        >
          <div
            class="col full-height overflow-hidden"
            :class="$q?.screen?.gt?.xs || false ? 'row' : 'column'"
          >
            <q-tabs
              v-model="tab"
              :vertical="$q?.screen?.gt?.xs || false"
              class="text-primary col-auto"
              outside-arrows
              mobile-arrows
            >
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
                name="notifications"
                icon="notifications"
                :label="$t('notificationPermission.title')"
                data-test="settings-tab-notifications"
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
            <q-tab-panels
              v-model="tab"
              animated
              swipeable
              :vertical="$q?.screen?.gt?.xs || false"
              class="col"
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
                <!-- Shown, on and locked: the app runs on testnet only for now. A future
                  unlock belongs in the settings store's `networkMode`, not in a global swap. -->
                <div class="row items-center justify-between q-mb-sm">
                  <div>
                    <div class="text-body2 text-weight-medium">
                      {{ $t('settings.testnetMode') }}
                    </div>
                    <div
                      class="text-caption text-grey"
                      data-test="mainnet-locked-hint"
                    >
                      {{ $t('settings.mainnetLockedBanner') }}
                    </div>
                  </div>
                  <q-toggle
                    :model-value="isTestnetMode"
                    disable
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
                    class="settings-chain-item q-px-none"
                  >
                    <q-item-section avatar style="min-width: 36px">
                      <q-icon :name="chain.icon" size="20px" color="primary" />
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
                      <!-- What the app can actually do on each network now, from the
                        chain registry. -->
                      <q-badge
                        :color="
                          chainStatus(chain) === 'available'
                            ? isTestnetMode
                              ? 'warning'
                              : 'primary'
                            : 'grey-7'
                        "
                        outline
                        :label="$t(chainStatusKey(chain))"
                        :data-test="`settings-chain-${chain.id}-status`"
                      />
                    </q-item-section>
                  </q-item>
                </q-list>
                <q-separator class="q-my-md" />
                <div data-test="cold-vault-sweep-section">
                  <div class="row items-center justify-between q-mb-xs">
                    <div class="col">
                      <div
                        class="text-subtitle2"
                        data-test="cold-vault-sweep-title"
                      >
                        {{ $t('settings.coldVaultTitle') }}
                      </div>
                      <div class="text-caption text-grey">
                        {{ $t('settings.coldVaultSubtitle') }}
                      </div>
                    </div>
                    <q-toggle
                      v-model="coldVaultEnabled"
                      :aria-label="$t('settings.coldVaultEnabled')"
                      color="primary"
                      data-test="cold-vault-enabled-toggle"
                    />
                  </div>
                  <q-input
                    v-model="coldVaultAddressInput"
                    :label="$t('settings.coldVaultAddressLabel')"
                    :hint="$t('settings.coldVaultAddressHint')"
                    dense
                    outlined
                    :error="!!coldVaultError"
                    data-test="cold-vault-address-input"
                    class="full-width q-mb-sm"
                  />
                  <q-input
                    v-model="coldVaultMaxHotBalanceInput"
                    :label="$t('settings.coldVaultMaxHotBalanceLabel')"
                    :hint="$t('settings.coldVaultMaxHotBalanceHint')"
                    type="number"
                    dense
                    outlined
                    data-test="cold-vault-max-hot-balance-input"
                    class="full-width q-mb-xs"
                  />
                  <div
                    v-if="coldVaultError"
                    class="text-negative text-caption q-mb-xs error-msg"
                    data-test="cold-vault-error"
                  >
                    {{ coldVaultError }}
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
                      data-test="reset-cold-vault-btn"
                      @click="resetColdVaultSweep"
                    />
                  </div>
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
              <q-tab-panel name="notifications">
                <notification-permission-panel />
                <q-separator class="q-my-md" />
                <div class="row q-mb-sm">
                  <q-input
                    outlined
                    v-model.number="notificationFeeThresholdAvu"
                    :label="
                      $t(
                        'settings.notificationFeeThresholdAvu',
                        'Notification Fee Threshold (AVU)',
                      )
                    "
                    type="number"
                    min="0"
                    step="0.01"
                    :hint="
                      $t(
                        'settings.notificationFeeThresholdAvuHint',
                        'Minimum stamp value in AVU required to trigger a push notification (messages below this threshold are still delivered silently to your inbox)',
                      )
                    "
                    data-test="notification-fee-threshold-input"
                    data-testid="notification-fee-threshold-input"
                    style="width: 100%"
                  />
                </div>
                <div class="row items-center q-mt-sm">
                  <q-toggle
                    v-model="allowContactNotificationBypass"
                    :label="
                      $t(
                        'settings.allowContactNotificationBypass',
                        'Allow contacts with wakeup tokens to notify without a stamp',
                      )
                    "
                    data-test="notification-contact-bypass-toggle"
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
                <div
                  class="text-caption q-mb-sm"
                  data-test="email-gateway-status"
                >
                  <template v-if="emailGatewayStatus === 'ready'">
                    {{ $t('settings.emailGatewayRelayLabel') }}
                    {{ emailGatewayDomain }} ({{ emailGatewayAddress }})
                  </template>
                  <template v-else-if="emailGatewayStatus === 'changed'">
                    {{ $t('settings.emailGatewayChanged') }}
                  </template>
                  <template v-else-if="emailGatewayStatus === 'loading'">
                    {{ $t('settings.emailGatewayChecking') }}
                  </template>
                  <template v-else>
                    {{ $t('settings.emailGatewayUnavailable') }}
                  </template>
                </div>
                <q-input
                  v-model="emailGatewayInput"
                  :label="$t('settings.emailGatewayAddress')"
                  dense
                  outlined
                  :error="!!emailGatewayError"
                  :hint="$t('settings.emailGatewayOverrideHint')"
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
                  class="text-caption text-grey-7 q-mt-sm"
                  data-test="email-gateway-fee"
                >
                  <q-icon
                    name="local_post_office"
                    size="14px"
                    class="q-mr-xs text-primary"
                  />
                  {{
                    $t(
                      'settings.emailGatewayFee',
                      'Gateway delivery stamp: 0.01 MONT per email',
                    )
                  }}
                </div>
                <div class="row items-center justify-end q-gutter-x-sm q-mt-xs">
                  <q-btn
                    flat
                    dense
                    no-caps
                    size="sm"
                    color="grey-7"
                    :label="
                      emailGatewayStatus === 'changed'
                        ? $t('settings.acceptRelayGateway')
                        : $t('settings.useRelayGateway')
                    "
                    data-test="reset-email-gateway-btn"
                    data-testid="reset-email-gateway-btn"
                    @click="resetEmailGateway"
                  />
                </div>
              </q-tab-panel>
            </q-tab-panels>
          </div>
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
              data-test="save-email-gateway-btn"
              data-testid="save-email-gateway-btn"
            />
          </q-card-actions>
        </q-card>
      </q-page>
    </q-page-container>
  </div>
</template>

<script lang="ts">
import { navigateBack } from 'src/utils/navigate-back'
import { viewportPageStyle } from 'src/utils/layout'
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
import NotificationPermissionPanel from 'src/components/settings/NotificationPermissionPanel.vue'
import PersistentStoragePanel from 'src/components/settings/PersistentStoragePanel.vue'
import { activeChain } from '@frank/wallet/chain'
import { WALLET_CONFIGS, getWalletNetworkLabel } from 'src/utils/wallet-configs'
import { walletSupport } from 'src/utils/wallet-support'
const msToMinutes = 60000

export default defineComponent({
  components: { PersistentStoragePanel, NotificationPermissionPanel },
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
    const emailGatewayInput = ref(
      settingsStore.emailGatewayOverride?.address ?? '',
    )
    const emailGatewayError = ref('')
    const notificationFeeThresholdAvu = ref<number>(
      settingsStore.notificationFeeThresholdAvu ?? 0,
    )
    const allowContactNotificationBypass = ref<boolean>(
      settingsStore.allowContactNotificationBypass ?? true,
    )

    const coldVaultEnabled = ref(settingsStore.coldVaultSweep?.enabled ?? false)
    const coldVaultAddressInput = ref(
      settingsStore.coldVaultSweep?.externalVaultAddress ?? '',
    )
    const coldVaultMaxHotBalanceInput = ref(
      settingsStore.coldVaultSweep?.maxHotBalanceDisplay ?? '1500',
    )
    const coldVaultError = ref('')

    watch(
      () => settingsStore.emailGatewayOverride,
      newVal => {
        emailGatewayInput.value = newVal?.address ?? ''
      },
    )
    watch(
      () => settingsStore.notificationFeeThresholdAvu,
      newVal => {
        notificationFeeThresholdAvu.value = newVal ?? 0
      },
    )
    watch(
      () => settingsStore.allowContactNotificationBypass,
      newVal => {
        allowContactNotificationBypass.value = newVal ?? true
      },
    )

    watch(
      () => settingsStore.coldVaultSweep,
      newVal => {
        if (!newVal) return
        coldVaultEnabled.value = newVal.enabled
        coldVaultAddressInput.value = newVal.externalVaultAddress
        coldVaultMaxHotBalanceInput.value = newVal.maxHotBalanceDisplay
      },
      { deep: true },
    )

    const emailGatewayAddress = computed(
      () => settingsStore.advertisedEmailGateway?.address ?? '',
    )

    function resetEmailGateway() {
      emailGatewayError.value = ''
      if (settingsStore.emailGatewayStatus === 'changed') {
        settingsStore.acceptAdvertisedEmailGateway()
      } else {
        settingsStore.resetEmailGatewayAddress()
      }
      emailGatewayInput.value = emailGatewayAddress.value
    }

    function saveEmailGateway() {
      emailGatewayError.value = ''
      const trimmed = emailGatewayInput.value.trim()
      if (
        !trimmed ||
        (emailGatewayAddress.value &&
          trimmed.toLowerCase() === emailGatewayAddress.value.toLowerCase())
      ) {
        resetEmailGateway()
        return
      }
      try {
        settingsStore.setEmailGatewayAddress(trimmed)
        emailGatewayInput.value =
          settingsStore.emailGatewayOverride?.address ?? ''
      } catch (err: any) {
        emailGatewayError.value =
          err?.message || 'Invalid Ethereum address format'
      }
    }

    function resetColdVaultSweep() {
      coldVaultError.value = ''
      if (typeof settingsStore.resetColdVaultSweep === 'function') {
        settingsStore.resetColdVaultSweep()
      }
      coldVaultEnabled.value = false
      coldVaultAddressInput.value = ''
      coldVaultMaxHotBalanceInput.value = '1500'
    }

    function saveColdVaultSweep() {
      coldVaultError.value = ''
      if (typeof settingsStore.setColdVaultSweep !== 'function') {
        return
      }
      try {
        settingsStore.setColdVaultSweep({
          enabled: coldVaultEnabled.value,
          externalVaultAddress: String(coldVaultAddressInput.value ?? ''),
          maxHotBalanceDisplay: String(
            coldVaultMaxHotBalanceInput.value ?? '1500',
          ),
        })
      } catch (err: any) {
        coldVaultError.value =
          err?.message || 'Invalid Cold-Wallet Auto-Sweep configuration'
      }
    }

    // Stated, not chosen: the toggle shows the network the app is running on and cannot be
    // flipped. Swapping the chain under an open wallet breaks every call that wallet makes.
    const isTestnetMode = activeChain.isTestnet ?? false
    const chainStatus = (chain: { id: string }) =>
      walletSupport(chain.id, isTestnetMode).status

    return {
      appearanceStore,
      settingsStore,
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
      notificationFeeThresholdAvu,
      allowContactNotificationBypass,
      emailGatewayStatus: computed(() => settingsStore.emailGatewayStatus),
      emailGatewayDomain: computed(
        () => settingsStore.advertisedEmailGateway?.domain ?? '',
      ),
      emailGatewayAddress: computed(
        () => settingsStore.advertisedEmailGateway?.address ?? '',
      ),
      saveEmailGateway,
      resetEmailGateway,
      coldVaultEnabled,
      coldVaultAddressInput,
      coldVaultMaxHotBalanceInput,
      coldVaultError,
      saveColdVaultSweep,
      resetColdVaultSweep,
      getWalletNetworkLabel,
      supportedChains: WALLET_CONFIGS.filter(c => c.enabled !== false),
      chainStatus,
      chainStatusKey: (chain: { id: string }) =>
        chainStatus(chain) === 'available'
          ? 'settings.chainSendReceive'
          : 'settings.chainUnsupported',
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
    pageStyle: viewportPageStyle,
    selectTheme(stoneId: SignetStone) {
      this.theme = stoneId
      this.isSaved = false
      applyTheme(stoneId, this.darkMode)
    },
    onSelectTheme(stoneId: SignetStone) {
      this.selectTheme(stoneId)
    },
    save() {
      this.saveEmailGateway()
      this.saveColdVaultSweep()
      if (this.emailGatewayError || this.coldVaultError) {
        this.isSaved = false
        return
      }
      if (
        typeof this.settingsStore?.setNotificationFeeThresholdAvu === 'function'
      ) {
        this.settingsStore.setNotificationFeeThresholdAvu(
          this.notificationFeeThresholdAvu,
        )
      }
      if (
        typeof this.settingsStore?.setAllowContactNotificationBypass ===
        'function'
      ) {
        this.settingsStore.setAllowContactNotificationBypass(
          this.allowContactNotificationBypass,
        )
      }
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
      this.notificationFeeThresholdAvu =
        this.settingsStore?.notificationFeeThresholdAvu ?? 0
      this.allowContactNotificationBypass =
        this.settingsStore?.allowContactNotificationBypass ?? true
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

<style scoped>
.settings-container {
  height: 100%;
  min-height: 0;
}
.settings-page {
  height: 100%;
  min-height: 0 !important;
}
.settings-content,
.settings-content :deep(.q-tab-panels) {
  min-width: 0;
  max-width: 100%;
}

@media (max-width: 600px) {
  .settings-chain-item {
    display: grid;
    grid-template-columns: 36px minmax(0, 1fr);
    align-items: center;
  }

  .settings-chain-item :deep(.q-item__section--avatar) {
    grid-column: 1;
    grid-row: 1 / span 2;
  }

  .settings-chain-item :deep(.q-item__section--main) {
    grid-column: 2;
    grid-row: 1;
    min-width: 0;
  }

  .settings-chain-item
    :deep(.q-item__section--side:not(.q-item__section--avatar)) {
    grid-column: 2;
    grid-row: 2;
    padding-left: 0;
    justify-self: start;
    align-items: flex-start;
  }
}
</style>
