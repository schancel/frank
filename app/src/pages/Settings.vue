<template>
  <div class="settings-container column full-height overflow-hidden">
    <q-header>
      <q-toolbar class="q-pl-sm">
        <q-btn
          v-if="sectionOnly"
          flat
          dense
          class="q-px-sm"
          icon="arrow_back"
          :aria-label="$t('settings.back')"
          data-test="settings-back"
          @click="closeSection"
        />
        <q-btn
          v-else
          flat
          dense
          class="q-px-sm"
          icon="menu"
          :aria-label="$t('settings.openMenu')"
          data-test="settings-menu"
          @click="$emit('toggleMyDrawerOpen')"
        />
        <q-toolbar-title class="h6" data-test="settings-title">{{
          sectionOnly && activeSectionDef
            ? $t(activeSectionDef.labelKey)
            : $t('settings.title')
        }}</q-toolbar-title>
        <q-space />
        <extension-popout-btn />
      </q-toolbar>
    </q-header>
    <q-page-container class="col full-height overflow-hidden">
      <q-page
        class="settings-page q-ma-none q-pa-none row no-wrap col full-height overflow-hidden"
        :style-fn="pageStyle"
      >
        <!-- One grouped list (iPhone Settings / Telegram). Phone: the list or one section, each
        its own route. Wide: the list on the left and the selected section beside it. -->
        <nav
          v-if="showList"
          class="settings-list-pane full-height"
          :class="wide ? 'col-auto settings-list-pane--wide' : 'col'"
          :aria-label="$t('settings.title')"
          data-test="settings-list"
        >
          <q-list class="settings-group q-mb-md">
            <q-item
              clickable
              v-ripple
              class="settings-profile-row"
              data-test="settings-row-profile"
              @click="openRoute('/profile')"
            >
              <q-item-section avatar>
                <q-avatar rounded size="48px">
                  <img :src="profileAvatar(myAvatar, myAddress || '')" alt="" />
                </q-avatar>
              </q-item-section>
              <q-item-section>
                <q-item-label class="text-weight-medium" lines="1">{{
                  myName || $t('SettingPanel.profile')
                }}</q-item-label>
                <q-item-label caption lines="1">{{
                  $t('settings.profileRowCaption')
                }}</q-item-label>
              </q-item-section>
              <q-item-section side class="row no-wrap items-center">
                <q-btn
                  flat
                  round
                  dense
                  icon="qr_code_2"
                  :aria-label="$t('profileDialog.identityQr')"
                  data-test="settings-row-identity-qr"
                  @click.stop="openRoute('/profile?tab=identity')"
                />
              </q-item-section>
              <q-item-section side>
                <q-icon name="chevron_right" />
              </q-item-section>
            </q-item>
          </q-list>

          <q-list
            v-for="(group, index) in rowGroups"
            :key="index"
            class="settings-group q-mb-md"
          >
            <template v-for="(row, rowIndex) in group" :key="row.id">
              <q-separator v-if="rowIndex > 0" inset="item" />
              <q-item
                clickable
                v-ripple
                :active="wide && row.section === activeSection"
                active-class="settings-row--active"
                :data-test="`settings-row-${row.id}`"
                @click="openRow(row)"
              >
                <q-item-section avatar>
                  <q-icon :name="row.icon" color="primary" />
                </q-item-section>
                <q-item-section>
                  <q-item-label>{{ $t(row.labelKey) }}</q-item-label>
                </q-item-section>
                <q-item-section side>
                  <q-icon name="chevron_right" />
                </q-item-section>
              </q-item>
            </template>
          </q-list>
        </nav>

        <section
          v-if="activeSection"
          class="settings-section-pane col full-height"
          :aria-label="activeSectionDef ? $t(activeSectionDef.labelKey) : ''"
          :data-section="activeSection"
          data-test="settings-section"
        >
          <div class="settings-section-body q-pa-md">
            <div
              v-if="wide && activeSectionDef"
              class="text-h6 q-mb-md"
              data-test="settings-section-heading"
            >
              {{ $t(activeSectionDef.labelKey) }}
            </div>

            <template v-if="activeSection === 'networking'">
              <q-input
                outlined
                v-model="updateInterval"
                :label="$t('settings.contactRefreshInterval')"
                type="number"
                min="1"
                :hint="$t('settings.contactRefreshIntervalHint')"
                :error="!!updateIntervalError"
                :error-message="
                  updateIntervalError ? $t(updateIntervalError) : ''
                "
                class="full-width"
                data-test="contact-refresh-interval-input"
                @update:model-value="updateIntervalField.schedule()"
                @blur="updateIntervalField.commitNow()"
              />
              <q-separator class="q-my-md" />
              <div class="text-subtitle2 q-mb-sm">
                {{ $t('settings.networkModeTitle') }}
              </div>
              <!-- Shown, on and locked: the app runs on testnet only for now. A future
                unlock belongs in the settings store's `networkMode`, not in a global swap. -->
              <div class="row items-center justify-between no-wrap q-mb-sm">
                <div class="col q-pr-sm" style="min-width: 0">
                  <div class="text-body2 text-weight-medium">
                    {{ $t('settings.testnetMode') }}
                  </div>
                  <div
                    class="text-caption settings-muted"
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
                class="settings-mode-banner settings-mode-banner--testnet q-mb-md"
              >
                <template #avatar>
                  <q-icon name="info" color="warning" />
                </template>
                {{ $t('settings.testnetActiveBanner') }}
              </q-banner>
              <q-banner
                v-else
                dense
                rounded
                class="settings-mode-banner settings-mode-banner--mainnet q-mb-md"
              >
                <template #avatar>
                  <q-icon name="verified" color="primary" />
                </template>
                {{ $t('settings.mainnetActiveBanner') }}
              </q-banner>

              <div
                class="text-caption text-weight-medium settings-muted q-mb-xs"
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
                    <q-item-label caption>
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
                    <div class="text-caption settings-muted">
                      {{ $t('settings.coldVaultSubtitle') }}
                    </div>
                  </div>
                  <q-toggle
                    v-model="coldVaultEnabled"
                    :aria-label="$t('settings.coldVaultEnabled')"
                    color="primary"
                    data-test="cold-vault-enabled-toggle"
                    @update:model-value="toggleColdVault"
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
                  class="full-width q-mb-xs"
                  @update:model-value="coldVaultError = ''"
                />
                <!-- A pasted address is never saved implicitly: a truncated Solana address is often
                still a well-formed one, so the user confirms the full address first. -->
                <div
                  v-if="coldVaultAddressChanged"
                  class="row items-center no-wrap q-gutter-x-sm q-mb-sm"
                >
                  <div
                    class="col text-caption settings-muted"
                    data-test="cold-vault-address-unconfirmed"
                  >
                    {{ $t('settings.coldVaultAddressUnconfirmed') }}
                  </div>
                  <q-btn
                    unelevated
                    dense
                    no-caps
                    size="sm"
                    color="primary"
                    class="q-px-sm"
                    :label="$t('settings.coldVaultUseAddress')"
                    data-test="cold-vault-address-use-btn"
                    @click="reviewColdVaultAddress"
                  />
                </div>
                <!-- An emptied field with a stored address must not look like a removed vault:
                sweeps still go to the stored address until it is removed here. -->
                <div
                  v-else-if="coldVaultAddressEmptied"
                  class="row items-center no-wrap q-gutter-x-sm q-mb-sm"
                >
                  <div
                    class="col text-caption settings-muted"
                    data-test="cold-vault-address-still-stored"
                  >
                    {{ $t('settings.coldVaultAddressStillStored') }}
                  </div>
                  <q-btn
                    outline
                    dense
                    no-caps
                    size="sm"
                    color="negative"
                    class="q-px-sm"
                    :label="$t('settings.coldVaultRemoveAddress')"
                    data-test="cold-vault-address-remove-btn"
                    @click="reviewColdVaultAddressRemoval"
                  />
                </div>
                <q-input
                  v-model="coldVaultMaxHotBalanceInput"
                  :label="$t('settings.coldVaultMaxHotBalanceLabel')"
                  :hint="$t('settings.coldVaultMaxHotBalanceHint')"
                  type="number"
                  dense
                  outlined
                  data-test="cold-vault-max-hot-balance-input"
                  class="full-width q-mb-xs"
                  @update:model-value="coldVaultField.markDirty()"
                  @blur="coldVaultField.commitNow()"
                />
                <div
                  v-if="coldVaultError"
                  class="text-negative text-caption q-mb-xs error-msg"
                  data-test="cold-vault-error"
                >
                  {{ coldVaultError }}
                </div>
                <div class="row items-center justify-end q-gutter-x-sm q-mt-sm">
                  <q-btn
                    outline
                    dense
                    no-caps
                    size="sm"
                    color="primary"
                    icon="restart_alt"
                    class="q-px-sm"
                    :label="$t('settings.resetDefault')"
                    data-test="reset-cold-vault-btn"
                    @click="resetColdVaultSweep"
                  />
                </div>
              </div>
              <q-dialog
                v-model="coldVaultConfirmOpen"
                data-test="cold-vault-confirm-dialog"
              >
                <q-card class="cold-vault-confirm-card">
                  <q-card-section
                    class="text-h6"
                    data-test="cold-vault-confirm-title"
                  >
                    {{
                      coldVaultDialogMode === 'remove'
                        ? $t('settings.coldVaultRemoveTitle')
                        : coldVaultEnableOnConfirm
                        ? $t('settings.coldVaultConfirmTitleAndEnable')
                        : $t('settings.coldVaultConfirmTitle')
                    }}
                  </q-card-section>
                  <q-card-section class="q-pt-none">
                    <div class="text-caption settings-muted">
                      {{ $t('settings.coldVaultConfirmChain') }}
                    </div>
                    <div class="q-mb-sm" data-test="cold-vault-confirm-chain">
                      {{
                        coldVaultPendingChainKey
                          ? $t(coldVaultPendingChainKey)
                          : ''
                      }}
                    </div>
                    <div
                      class="cold-vault-confirm-address q-pa-sm q-mb-sm"
                      data-test="cold-vault-confirm-address"
                    >
                      {{ coldVaultPendingAddress }}
                    </div>
                    <div
                      class="text-caption"
                      data-test="cold-vault-confirm-body"
                    >
                      {{
                        coldVaultDialogMode === 'remove'
                          ? $t('settings.coldVaultRemoveBody')
                          : coldVaultEnableOnConfirm
                          ? $t('settings.coldVaultConfirmBodyAndEnable')
                          : $t('settings.coldVaultConfirmBody')
                      }}
                    </div>
                  </q-card-section>
                  <q-card-actions align="right">
                    <q-btn
                      flat
                      no-caps
                      :label="$t('settings.coldVaultConfirmCancel')"
                      data-test="cold-vault-confirm-cancel"
                      @click="coldVaultConfirmOpen = false"
                    />
                    <q-btn
                      unelevated
                      no-caps
                      :color="
                        coldVaultDialogMode === 'remove'
                          ? 'negative'
                          : 'primary'
                      "
                      :label="
                        coldVaultDialogMode === 'remove'
                          ? $t('settings.coldVaultRemoveAddress')
                          : $t('settings.coldVaultUseAddress')
                      "
                      data-test="cold-vault-confirm-accept"
                      @click="confirmColdVaultDialog"
                    />
                  </q-card-actions>
                </q-card>
              </q-dialog>
            </template>

            <template v-else-if="activeSection === 'appearance'">
              <div class="row items-center q-mb-md">
                <q-toggle
                  :label="$t('settings.darkMode')"
                  v-model="darkMode"
                  data-test="dark-mode-toggle"
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
                    :data-test="`theme-chip-${stone.id}`"
                  >
                    <q-avatar
                      :style="stoneSwatchStyle(stone)"
                      size="18px"
                      class="q-mr-xs"
                    />
                    <span>{{ stone.label }}</span>
                  </q-chip>
                </div>
                <div class="text-caption settings-muted q-mt-xs">
                  {{ selectedThemeDescription }}
                </div>
              </div>
              <div class="q-mb-lg" data-test="ui-scale-section">
                <div class="text-subtitle2 q-mb-sm">
                  {{ $t('settings.uiScaleTitle') }}
                </div>
                <div class="row q-gutter-sm">
                  <q-chip
                    v-for="opt in uiScaleOptions"
                    :key="String(opt.value)"
                    clickable
                    :selected="uiScale === opt.value"
                    @click="selectUiScale(opt.value)"
                    outline
                    :color="uiScale === opt.value ? 'primary' : ''"
                    class="cursor-pointer"
                    :data-test="`ui-scale-chip-${opt.value}`"
                  >
                    <span>{{ $t(opt.labelKey) }}</span>
                  </q-chip>
                </div>
                <div class="text-caption settings-muted q-mt-xs">
                  {{ $t('settings.uiScaleHint') }}
                </div>
              </div>
              <div
                v-if="isExtensionMode"
                class="q-mb-lg"
                data-test="extension-view-settings-section"
              >
                <div class="text-subtitle2 q-mb-xs">
                  {{ extViewLabels.sectionTitle }}
                </div>
                <div class="text-caption settings-muted q-mb-sm">
                  {{ extViewLabels.sectionSubtitle }}
                </div>
                <div class="row q-gutter-sm">
                  <q-chip
                    clickable
                    outline
                    icon="web_asset"
                    :selected="extensionLaunchMode === 'popup'"
                    :color="extensionLaunchMode === 'popup' ? 'primary' : ''"
                    class="cursor-pointer"
                    data-test="ext-mode-chip-popup"
                    @click="selectExtensionLaunchMode('popup')"
                  >
                    <span>{{ extViewLabels.popupMode }}</span>
                  </q-chip>
                  <q-chip
                    v-if="supportsSidePanel"
                    clickable
                    outline
                    icon="view_sidebar"
                    :selected="extensionLaunchMode === 'sidepanel'"
                    :color="
                      extensionLaunchMode === 'sidepanel' ? 'primary' : ''
                    "
                    class="cursor-pointer"
                    data-test="ext-mode-chip-sidepanel"
                    @click="selectExtensionLaunchMode('sidepanel')"
                  >
                    <span>{{ extViewLabels.sidepanelMode }}</span>
                  </q-chip>
                  <q-chip
                    clickable
                    outline
                    icon="open_in_new"
                    :selected="extensionLaunchMode === 'window'"
                    :color="extensionLaunchMode === 'window' ? 'primary' : ''"
                    class="cursor-pointer"
                    data-test="ext-mode-chip-window"
                    @click="selectExtensionLaunchMode('window')"
                  >
                    <span>{{ extViewLabels.windowMode }}</span>
                  </q-chip>
                </div>
                <div
                  class="text-caption settings-muted q-mt-xs"
                  data-test="ext-mode-description"
                >
                  {{ extLaunchModeDescription }}
                </div>
                <div
                  v-if="extLaunchModeError"
                  class="text-caption text-negative q-mt-xs"
                  data-test="ext-mode-error"
                >
                  {{ extLaunchModeError }}
                </div>
                <div class="row items-center q-mt-sm">
                  <q-btn
                    outline
                    dense
                    no-caps
                    size="sm"
                    icon="tab"
                    color="primary"
                    :label="extViewLabels.openFullTabBtn"
                    :aria-label="extViewLabels.openFullTabBtn"
                    data-test="ext-open-full-tab-btn"
                    @click="openInFullBrowserTab"
                  />
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
                  data-test="locale-select"
                />
              </div>
            </template>

            <template v-else-if="activeSection === 'notifications'">
              <notification-permission-panel />
              <q-separator class="q-my-md" />
              <q-input
                outlined
                v-model="notificationFeeThresholdAvu"
                :label="$t('settings.notificationFeeThresholdAvu')"
                type="number"
                min="0"
                step="0.01"
                :hint="$t('settings.notificationFeeThresholdAvuHint')"
                :error="!!notificationFeeThresholdError"
                :error-message="
                  notificationFeeThresholdError
                    ? $t(notificationFeeThresholdError)
                    : ''
                "
                data-test="notification-fee-threshold-input"
                data-testid="notification-fee-threshold-input"
                class="full-width q-mb-sm"
                @update:model-value="notificationFeeThresholdField.schedule()"
                @blur="commitNotificationFeeThresholdAndSync"
              />
              <div class="row items-center q-mt-sm">
                <q-toggle
                  v-model="allowContactNotificationBypass"
                  :label="$t('settings.allowContactNotificationBypass')"
                  data-test="notification-contact-bypass-toggle"
                  @update:model-value="commitAllowContactNotificationBypass"
                />
              </div>
            </template>

            <template v-else-if="activeSection === 'storage'">
              <persistent-storage-panel />
            </template>

            <template v-else-if="activeSection === 'gateways'">
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
                @update:model-value="emailGatewayField.schedule()"
                @blur="emailGatewayField.commitNow()"
              />
              <div
                v-if="emailGatewayError"
                class="text-negative text-caption q-mb-xs error-msg"
                data-test="email-gateway-error"
              >
                {{ emailGatewayError }}
              </div>
              <div class="row items-center justify-between q-gutter-sm q-mt-sm">
                <div
                  class="col text-caption settings-muted"
                  style="min-width: 200px"
                  data-test="email-gateway-fee"
                >
                  <q-icon
                    name="local_post_office"
                    size="14px"
                    class="q-mr-xs text-primary"
                  />
                  {{ $t('settings.emailGatewayFee') }}
                </div>
                <q-btn
                  outline
                  dense
                  no-caps
                  size="sm"
                  color="primary"
                  icon="restart_alt"
                  class="q-px-sm col-auto"
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
            </template>
          </div>
        </section>
      </q-page>
    </q-page-container>
  </div>
</template>

<script lang="ts">
import { viewportPageStyle, isNarrowWidth } from 'src/utils/layout'
import { localeOptions } from 'src/i18n'
import { applyLocale } from 'src/utils/apply-locale'
import {
  DEFAULT_SIGNET_THEME,
  SIGNET_THEMES,
  SignetStone,
} from 'src/utils/theme'
import {
  DEFAULT_UI_SCALE,
  UiScaleSetting,
  getEffectiveScreenWidth,
  getSavedUiScaleSetting,
} from 'src/utils/mobile-viewport-scale'

import { computed, defineComponent, onBeforeUnmount, ref, watch } from 'vue'

import { useAppearanceStore } from 'src/stores/appearance'
import { useContactStore } from 'src/stores/contacts'
import {
  externalVaultAddressChain,
  useSettingsStore,
} from 'src/stores/settings'
import { useProfileStore } from 'src/stores/my-profile'
import { storeToRefs } from 'pinia'
import NotificationPermissionPanel from 'src/components/settings/NotificationPermissionPanel.vue'
import PersistentStoragePanel from 'src/components/settings/PersistentStoragePanel.vue'
import ExtensionPopoutBtn from 'src/components/navigation/ExtensionPopoutBtn.vue'
import { activeChain } from '@frank/wallet/chain'
import { WALLET_CONFIGS, getWalletNetworkLabel } from 'src/utils/wallet-configs'
import { walletSupport } from 'src/utils/wallet-support'
import { profileAvatar } from 'src/utils/avatar'
import { useReactiveOwnCanonicalAddress } from 'src/utils/own-address'
import {
  SETTINGS_SECTIONS,
  SETTINGS_ROW_GROUPS,
  SettingsRow,
  SettingsSectionId,
  blurField,
  debouncedField,
  settingsSectionFromParam,
} from 'src/utils/settings-navigation'
import {
  ExtensionLaunchMode,
  getExtensionRuntime,
  isBrowserExtensionRuntime,
  openExtensionTab,
  sendRuntimeMessage,
} from '../../src-bex/runtime-adapter'
import { FRANK_DAPP_BRIDGE_CHANNEL } from '../../src-bex/inpage'
import { FA_PLUG_CIRCLE_PLUS_ICON } from 'src/utils/extension-download'
const msToMinutes = 60000

const UI_SCALE_OPTIONS: readonly {
  value: UiScaleSetting
  labelKey: string
}[] = [
  { value: 'auto', labelKey: 'settings.uiScaleAuto' },
  { value: 85, labelKey: 'settings.uiScale85' },
  { value: 100, labelKey: 'settings.uiScale100' },
  { value: 115, labelKey: 'settings.uiScale115' },
  { value: 130, labelKey: 'settings.uiScale130' },
  { value: 150, labelKey: 'settings.uiScale150' },
]

const EXT_VIEW_LABELS = Object.freeze({
  sectionTitle: 'Extension Toolbar Click Behavior',
  sectionSubtitle:
    'Choose how Frank opens when you click its icon in the browser toolbar.',
  popupMode: 'Popup (400×600)',
  sidepanelMode: 'Side Panel',
  windowMode: 'Pop Out Window',
  openFullTabBtn: 'Open in Full Browser Tab',
  descPopup: 'Clicking the Frank toolbar icon opens the compact 400×600 popup.',
  descSidepanel:
    'Clicking the Frank toolbar icon opens the persistent browser Side Panel.',
  descWindow:
    'Opens Frank in a standalone 440×740 pop-out window that stays open when clicking away.',
})

function detectExtensionEnvironment(): boolean {
  if (isBrowserExtensionRuntime()) return true
  if (typeof window !== 'undefined' && window.location) {
    const proto = String(window.location.protocol || '')
    if (
      proto === 'chrome-extension:' ||
      proto === 'safari-web-extension:' ||
      proto === 'moz-extension:'
    ) {
      return true
    }
    if (String(window.location.search || '').includes('extMode=')) {
      return true
    }
  }
  return false
}

function syncNotificationPolicy(
  avuThreshold: number,
  allowContactBypass: boolean,
) {
  void import('src/utils/webpush-sync')
    .then(({ syncRelayNotificationPolicy }) =>
      syncRelayNotificationPolicy({ avuThreshold, allowContactBypass }),
    )
    .catch(() => undefined)
}

export default defineComponent({
  components: {
    PersistentStoragePanel,
    NotificationPermissionPanel,
    ExtensionPopoutBtn,
  },
  emits: [
    'toggleMyDrawerOpen',
    'toggleContactDrawerOpen',
    'setupNavigationLocked',
    'setupCompleted',
  ],
  setup() {
    // Every control writes its store directly: there is no draft and no Save. The appearance
    // store is applied to the document by AppRuntime's own watcher, the single place that does.
    const appearanceStore = useAppearanceStore()
    const contactStore = useContactStore()
    const settingsStore = useSettingsStore()
    const profileStore = useProfileStore()
    const { updateInterval: storeUpdateInterval } = storeToRefs(contactStore)
    const myAddress = useReactiveOwnCanonicalAddress()

    const darkMode = computed<boolean>({
      get: () => Boolean(appearanceStore.darkMode),
      set: value => appearanceStore.setDarkMode(Boolean(value)),
    })
    const theme = computed<SignetStone>(
      () => appearanceStore.theme || DEFAULT_SIGNET_THEME,
    )
    const uiScale = computed<UiScaleSetting>(
      () =>
        appearanceStore.uiScale || getSavedUiScaleSetting() || DEFAULT_UI_SCALE,
    )
    const themeOptions = Object.values(SIGNET_THEMES)
    const isExtensionMode = ref(detectExtensionEnvironment())
    const supportsSidePanel = computed(
      () => getExtensionRuntime().kind !== 'safari-extension',
    )
    const extensionLaunchMode = ref<ExtensionLaunchMode>('popup')
    const extLaunchModeDescription = computed(() => {
      if (extensionLaunchMode.value === 'sidepanel') {
        return EXT_VIEW_LABELS.descSidepanel
      }
      if (extensionLaunchMode.value === 'window') {
        return EXT_VIEW_LABELS.descWindow
      }
      return EXT_VIEW_LABELS.descPopup
    })

    if (isExtensionMode.value) {
      void sendRuntimeMessage<Record<string, any>, any>({
        channel: FRANK_DAPP_BRIDGE_CHANNEL,
        type: 'get-launch-mode',
      })
        .then(res => {
          const mode = res?.result?.launchMode
          if (mode === 'popup' || mode === 'sidepanel' || mode === 'window') {
            extensionLaunchMode.value = mode
          }
        })
        .catch(() => undefined)
    }

    const extLaunchModeError = ref('')
    // The one place that changes what the toolbar icon opens: the user's choice here.
    async function selectExtensionLaunchMode(mode: ExtensionLaunchMode) {
      const previous = extensionLaunchMode.value
      extensionLaunchMode.value = mode
      extLaunchModeError.value = ''
      let res: any
      try {
        res = await sendRuntimeMessage<Record<string, any>, any>({
          channel: FRANK_DAPP_BRIDGE_CHANNEL,
          type: 'set-launch-mode',
          launchMode: mode,
          openNow: mode !== 'popup',
        })
      } catch (err) {
        res = { error: { message: String(err) } }
      }
      if (res?.result?.launchMode !== mode) {
        extensionLaunchMode.value = previous
        extLaunchModeError.value = `Could not save the toolbar click choice${
          res?.error?.message ? `: ${res.error.message}` : ''
        }`
      }
    }

    async function openInFullBrowserTab() {
      await openExtensionTab()
    }

    // --- Contact refresh interval (minutes in the field, milliseconds in the store) ---
    const updateInterval = ref<string | number>(
      storeUpdateInterval.value / msToMinutes,
    )
    const updateIntervalError = ref('')
    const updateIntervalField = debouncedField(() => {
      const minutes = Number(updateInterval.value)
      if (
        String(updateInterval.value).trim() === '' ||
        !Number.isFinite(minutes) ||
        minutes < 1
      ) {
        updateIntervalError.value = 'settings.invalidRefreshInterval'
        return
      }
      updateIntervalError.value = ''
      const ms = Math.round(minutes * msToMinutes)
      if (ms !== storeUpdateInterval.value) storeUpdateInterval.value = ms
    })
    watch(storeUpdateInterval, ms => {
      if (Number(updateInterval.value) * msToMinutes !== ms) {
        updateInterval.value = ms / msToMinutes
      }
    })

    // --- Notification policy ---
    const notificationFeeThresholdAvu = ref<string | number>(
      settingsStore.notificationFeeThresholdAvu ?? 0,
    )
    const notificationFeeThresholdError = ref('')
    const allowContactNotificationBypass = ref<boolean>(
      settingsStore.allowContactNotificationBypass ?? true,
    )
    const notificationFeeThresholdField = debouncedField(() => {
      const raw = String(notificationFeeThresholdAvu.value ?? '').trim()
      const value = Number(raw)
      if (raw === '' || !Number.isFinite(value) || value < 0) {
        notificationFeeThresholdError.value =
          'settings.invalidNotificationFeeThreshold'
        return
      }
      notificationFeeThresholdError.value = ''
      if (value === settingsStore.notificationFeeThresholdAvu) return
      settingsStore.setNotificationFeeThresholdAvu(value)
    })
    // The relay is told the policy once the user is done with the field (blur, leaving the
    // page), not at every typing pause.
    let syncedThresholdAvu = settingsStore.notificationFeeThresholdAvu
    function syncThresholdIfChanged() {
      if (settingsStore.notificationFeeThresholdAvu === syncedThresholdAvu)
        return
      syncedThresholdAvu = settingsStore.notificationFeeThresholdAvu
      syncNotificationPolicy(
        settingsStore.notificationFeeThresholdAvu,
        settingsStore.allowContactNotificationBypass,
      )
    }
    function commitNotificationFeeThresholdAndSync() {
      notificationFeeThresholdField.commitNow()
      syncThresholdIfChanged()
    }
    function commitAllowContactNotificationBypass(value: boolean) {
      settingsStore.setAllowContactNotificationBypass(Boolean(value))
      syncedThresholdAvu = settingsStore.notificationFeeThresholdAvu
      syncNotificationPolicy(
        settingsStore.notificationFeeThresholdAvu,
        settingsStore.allowContactNotificationBypass,
      )
    }
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

    // --- Email gateway override ---
    const emailGatewayInput = ref(
      settingsStore.emailGatewayOverride?.address ?? '',
    )
    const emailGatewayError = ref('')
    const emailGatewayAddress = computed(
      () => settingsStore.advertisedEmailGateway?.address ?? '',
    )
    watch(
      () => settingsStore.emailGatewayOverride,
      newVal => {
        emailGatewayInput.value = newVal?.address ?? ''
      },
    )

    function resetEmailGateway() {
      emailGatewayField.cancel()
      emailGatewayError.value = ''
      if (settingsStore.emailGatewayStatus === 'changed') {
        settingsStore.acceptAdvertisedEmailGateway()
      } else {
        settingsStore.resetEmailGatewayAddress()
      }
      emailGatewayInput.value = emailGatewayAddress.value
    }

    const emailGatewayField = debouncedField(() => {
      emailGatewayError.value = ''
      const trimmed = String(emailGatewayInput.value ?? '').trim()
      const current = settingsStore.emailGatewayOverride?.address ?? ''
      const usesRelayGateway =
        !trimmed ||
        (emailGatewayAddress.value &&
          trimmed.toLowerCase() === emailGatewayAddress.value.toLowerCase())
      if (usesRelayGateway) {
        // Clearing the field drops the override. Accepting a *changed* relay gateway stays an
        // explicit decision on the button; it never happens as a side effect of typing.
        if (current) settingsStore.clearEmailGatewayOverride()
        return
      }
      if (trimmed === current) return
      try {
        settingsStore.setEmailGatewayAddress(trimmed)
      } catch (err: any) {
        emailGatewayError.value =
          err?.message || 'Invalid Ethereum address format'
      }
    })

    // --- Cold-wallet auto-sweep ---
    // The toggle and the ceiling apply themselves (blur, leaving). The vault address never does:
    // base58 has no checksum and a truncated Solana address is often still well formed, so a
    // changed address is saved only through the explicit confirm dialog. Leaving with an
    // unconfirmed address drops it.
    const coldVaultEnabled = ref(settingsStore.coldVaultSweep?.enabled ?? false)
    const coldVaultAddressInput = ref(
      settingsStore.coldVaultSweep?.externalVaultAddress ?? '',
    )
    const coldVaultMaxHotBalanceInput = ref<string | number>(
      settingsStore.coldVaultSweep?.maxHotBalanceDisplay ?? '1500',
    )
    const coldVaultError = ref('')
    const coldVaultConfirmOpen = ref(false)
    const coldVaultPendingAddress = ref('')
    const coldVaultDialogMode = ref<'use' | 'remove'>('use')
    // The user turned sweeping on before any address was saved. The store refuses that, so the
    // toggle goes back off; confirming an address then turns sweeping on with it, and the
    // dialog says so.
    const coldVaultEnableOnConfirm = ref(false)
    const savedColdVaultAddress = () =>
      settingsStore.coldVaultSweep?.externalVaultAddress ?? ''
    // An emptied field is not an address to confirm; Reset is how the vault is cleared.
    const coldVaultAddressChanged = computed(() => {
      const typed = String(coldVaultAddressInput.value ?? '').trim()
      return typed !== '' && typed !== savedColdVaultAddress()
    })
    const coldVaultAddressEmptied = computed(
      () =>
        String(coldVaultAddressInput.value ?? '').trim() === '' &&
        savedColdVaultAddress() !== '',
    )
    const coldVaultPendingChainKey = computed(() => {
      const chain = externalVaultAddressChain(coldVaultPendingAddress.value)
      if (chain === 'evm') return 'settings.coldVaultChainEvm'
      if (chain === 'solana') return 'settings.coldVaultChainSolana'
      return ''
    })
    watch(
      () => settingsStore.coldVaultSweep,
      (newVal, oldVal) => {
        if (!newVal) return
        coldVaultEnabled.value = newVal.enabled
        coldVaultMaxHotBalanceInput.value = newVal.maxHotBalanceDisplay
        // Saving the toggle or ceiling must not wipe an address still awaiting confirmation.
        const typed = String(coldVaultAddressInput.value ?? '').trim()
        if (typed === (oldVal?.externalVaultAddress ?? '')) {
          coldVaultAddressInput.value = newVal.externalVaultAddress
        }
      },
      { deep: true },
    )
    const coldVaultField = blurField(() => {
      coldVaultError.value = ''
      const current = settingsStore.coldVaultSweep
      const next = {
        enabled: coldVaultEnabled.value,
        externalVaultAddress: savedColdVaultAddress(),
        maxHotBalanceDisplay: String(
          coldVaultMaxHotBalanceInput.value ?? '1500',
        ).trim(),
      }
      if (
        current &&
        current.enabled === next.enabled &&
        current.maxHotBalanceDisplay === next.maxHotBalanceDisplay
      ) {
        return
      }
      if (next.enabled && !next.externalVaultAddress) {
        coldVaultEnableOnConfirm.value = true
      }
      try {
        settingsStore.setColdVaultSweep(next)
      } catch (err: unknown) {
        coldVaultError.value =
          (err instanceof Error && err.message) ||
          'Invalid Cold-Wallet Auto-Sweep configuration'
        // Nothing was saved: the toggle shows the stored state, not the refused one.
        coldVaultEnabled.value = settingsStore.coldVaultSweep?.enabled ?? false
      }
    })
    function reviewColdVaultAddress() {
      const typed = String(coldVaultAddressInput.value ?? '').trim()
      if (!externalVaultAddressChain(typed)) {
        coldVaultError.value = `Invalid external vault address: "${typed}". Expected an EVM (0x...) or Solana base58 address.`
        return
      }
      coldVaultError.value = ''
      coldVaultDialogMode.value = 'use'
      coldVaultPendingAddress.value = typed
      coldVaultConfirmOpen.value = true
    }
    function toggleColdVault(value: boolean) {
      if (!value) coldVaultEnableOnConfirm.value = false
      coldVaultField.commitNow()
    }
    function reviewColdVaultAddressRemoval() {
      coldVaultError.value = ''
      coldVaultDialogMode.value = 'remove'
      coldVaultPendingAddress.value = savedColdVaultAddress()
      coldVaultConfirmOpen.value = true
    }
    function confirmColdVaultDialog() {
      const address = coldVaultPendingAddress.value
      const mode = coldVaultDialogMode.value
      coldVaultConfirmOpen.value = false
      coldVaultPendingAddress.value = ''
      try {
        if (mode === 'remove') {
          // Removing the destination turns sweeping off; the ceiling is left as it is.
          settingsStore.setColdVaultSweep({
            enabled: false,
            externalVaultAddress: '',
          })
        } else {
          settingsStore.setColdVaultSweep(
            coldVaultEnableOnConfirm.value
              ? { externalVaultAddress: address, enabled: true }
              : { externalVaultAddress: address },
          )
        }
        coldVaultEnableOnConfirm.value = false
        coldVaultAddressInput.value = savedColdVaultAddress()
      } catch (err: unknown) {
        coldVaultError.value =
          (err instanceof Error && err.message) ||
          'Invalid Cold-Wallet Auto-Sweep configuration'
      }
    }
    function dropUnconfirmedColdVaultAddress() {
      coldVaultConfirmOpen.value = false
      coldVaultEnableOnConfirm.value = false
      coldVaultPendingAddress.value = ''
      coldVaultAddressInput.value = savedColdVaultAddress()
    }
    function resetColdVaultSweep() {
      coldVaultField.cancel()
      coldVaultError.value = ''
      coldVaultEnableOnConfirm.value = false
      settingsStore.resetColdVaultSweep()
      coldVaultEnabled.value = false
      coldVaultAddressInput.value = ''
      coldVaultMaxHotBalanceInput.value = '1500'
    }

    // Leaving the page, or switching section on a wide layout (the page stays mounted), applies
    // any pending edit that is valid and drops an unconfirmed vault address.
    function flushPendingEdits() {
      updateIntervalField.flush()
      notificationFeeThresholdField.flush()
      syncThresholdIfChanged()
      emailGatewayField.flush()
      coldVaultField.flush()
      dropUnconfirmedColdVaultAddress()
    }
    onBeforeUnmount(flushPendingEdits)

    // Stated, not chosen: the toggle shows the network the app is running on and cannot be
    // flipped. Swapping the chain under an open wallet breaks every call that wallet makes.
    const isTestnetMode = activeChain.isTestnet ?? false
    const chainStatus = (chain: { id: string }) =>
      walletSupport(chain.id, isTestnetMode).status

    return {
      appearanceStore,
      settingsStore,
      isTestnetMode,
      darkMode,
      theme,
      themeOptions,
      uiScale,
      uiScaleOptions: UI_SCALE_OPTIONS,
      isExtensionMode,
      supportsSidePanel,
      extensionLaunchMode,
      extViewLabels: EXT_VIEW_LABELS,
      extLaunchModeDescription,
      extLaunchModeError,
      selectExtensionLaunchMode,
      openInFullBrowserTab,
      updateInterval,
      updateIntervalError,
      updateIntervalField,
      localeOptions,
      emailGatewayInput,
      emailGatewayError,
      emailGatewayField,
      notificationFeeThresholdAvu,
      notificationFeeThresholdError,
      notificationFeeThresholdField,
      commitNotificationFeeThresholdAndSync,
      allowContactNotificationBypass,
      commitAllowContactNotificationBypass,
      emailGatewayStatus: computed(() => settingsStore.emailGatewayStatus),
      emailGatewayDomain: computed(
        () => settingsStore.advertisedEmailGateway?.domain ?? '',
      ),
      emailGatewayAddress,
      resetEmailGateway,
      coldVaultEnabled,
      coldVaultAddressInput,
      coldVaultMaxHotBalanceInput,
      coldVaultError,
      coldVaultField,
      coldVaultAddressChanged,
      coldVaultConfirmOpen,
      coldVaultPendingAddress,
      coldVaultPendingChainKey,
      reviewColdVaultAddress,
      reviewColdVaultAddressRemoval,
      toggleColdVault,
      confirmColdVaultDialog,
      coldVaultDialogMode,
      coldVaultEnableOnConfirm,
      coldVaultAddressEmptied,
      resetColdVaultSweep,
      flushPendingEdits,
      getWalletNetworkLabel,
      supportedChains: WALLET_CONFIGS.filter(c => c.enabled !== false),
      chainStatus,
      chainStatusKey: (chain: { id: string }) =>
        chainStatus(chain) === 'available'
          ? 'settings.chainSendReceive'
          : 'settings.chainUnsupported',
      profileAvatar,
      myAddress,
      myName: computed(() => profileStore.profile?.name ?? ''),
      myAvatar: computed(() => profileStore.profile?.avatar ?? ''),
      rowGroups: SETTINGS_ROW_GROUPS.map(group =>
        group.map(row =>
          row.id === 'dapp-bridge'
            ? { ...row, icon: FA_PLUG_CIRCLE_PLUS_ICON }
            : row,
        ),
      ),
    }
  },
  computed: {
    locale: {
      get(): string {
        return this.appearanceStore.locale
      },
      set(value: string) {
        this.appearanceStore.locale = value
        void applyLocale({
          $q: this.$q,
          setI18nLocale: next => {
            if (this.$i18n) {
              this.$i18n.locale = next
            }
          },
          locale: value,
        })
      },
    },
    selectedThemeDescription(): string {
      const selected = SIGNET_THEMES[this.theme]
      return selected ? selected.tagline : ''
    },
    wide(): boolean {
      const raw =
        this.$q?.screen?.width ??
        (typeof window !== 'undefined' ? window.innerWidth : 1024)
      return !isNarrowWidth(getEffectiveScreenWidth(raw))
    },
    routeSection(): SettingsSectionId | null {
      return settingsSectionFromParam(
        this.$router?.currentRoute?.value?.params?.section,
      )
    },
    // Wide: a section is always shown beside the list (the first one when none is chosen).
    activeSection(): SettingsSectionId | null {
      return this.routeSection ?? (this.wide ? SETTINGS_SECTIONS[0].id : null)
    },
    activeSectionDef(): (typeof SETTINGS_SECTIONS)[number] | null {
      return SETTINGS_SECTIONS.find(s => s.id === this.activeSection) ?? null
    },
    sectionOnly(): boolean {
      return !this.wide && this.routeSection !== null
    },
    showList(): boolean {
      return !this.sectionOnly
    },
  },
  watch: {
    // Wide: another section replaces the pane without unmounting the page, so pending edits
    // are applied (or an unconfirmed address dropped) here rather than on unmount.
    'activeSection'(
      next: SettingsSectionId | null,
      previous: SettingsSectionId | null,
    ) {
      if (previous && next !== previous) this.flushPendingEdits()
    },
    '$router.currentRoute.value.params.section': {
      handler(param: unknown) {
        // An unknown /settings/<name> goes back to the list instead of an empty page.
        if (param && !settingsSectionFromParam(param)) {
          void this.$router.replace('/settings')
        }
      },
      immediate: true,
    },
  },
  methods: {
    pageStyle: viewportPageStyle,
    stoneSwatchStyle(stone: (typeof SIGNET_THEMES)[SignetStone]) {
      const modeBg = this.darkMode
        ? stone.dark.background
        : stone.light.background
      return {
        background: `linear-gradient(135deg, ${stone.stoneColor} 55%, ${modeBg} 55%)`,
        border: '1px solid rgba(128, 128, 128, 0.35)',
      }
    },
    selectTheme(stoneId: SignetStone) {
      this.appearanceStore.setTheme(stoneId)
    },
    selectUiScale(scaleVal: UiScaleSetting) {
      this.appearanceStore.setUiScale(scaleVal)
    },
    openRoute(path: string) {
      void Promise.resolve(this.$router.push(path)).catch(() => undefined)
    },
    openRow(row: SettingsRow) {
      if (row.section) {
        const target = `/settings/${row.section}`
        // Wide: picking another section swaps the pane; it is not a page to go back through.
        const navigate = this.wide && this.routeSection ? 'replace' : 'push'
        void Promise.resolve(this.$router[navigate](target)).catch(
          () => undefined,
        )
        return
      }
      if (row.route) this.openRoute(row.route)
    },
    closeSection() {
      const previous = (
        typeof window !== 'undefined'
          ? (window.history.state as { back?: unknown } | null)?.back
          : null
      ) as string | null | undefined
      if (previous === '/settings') {
        this.$router.back()
      } else {
        void this.$router.replace('/settings')
      }
    },
  },
})
</script>

<style scoped>
.settings-container {
  width: 100%;
  max-width: 100%;
  height: 100%;
  min-height: 0;
}
.settings-page {
  width: 100%;
  max-width: 100%;
  height: 100%;
  min-height: 0 !important;
  background: var(--q-color-background);
  color: var(--q-color-text);
}
.settings-list-pane {
  min-width: 0;
  overflow-y: auto;
  overflow-x: hidden;
  padding: 16px 12px 24px;
}
.settings-list-pane--wide {
  width: 300px;
  max-width: 40%;
  border-right: 1px solid var(--frank-divider, rgba(128, 128, 128, 0.2));
}
.settings-group {
  background: var(--q-color-bg-surface);
  border-radius: 12px;
  overflow: hidden;
}
.settings-group :deep(.q-item) {
  min-height: 48px;
}
.settings-group :deep(.settings-row--active) {
  background: var(--q-color-bg-active);
  color: inherit;
}
.settings-section-pane {
  min-width: 0;
  overflow-y: auto;
  overflow-x: hidden;
}
.settings-section-body {
  max-width: 760px;
  padding-bottom: 24px;
}
.cold-vault-confirm-card {
  width: 100%;
  max-width: 480px;
}
.cold-vault-confirm-address {
  font-family: monospace;
  word-break: break-all;
  border-radius: 8px;
  background: var(--q-color-bg-surface);
}
.settings-muted {
  opacity: 0.7;
}
.settings-mode-banner {
  max-width: 100%;
  overflow: hidden;
}
.settings-mode-banner--testnet {
  background: color-mix(in srgb, var(--q-warning) 14%, transparent);
}
.settings-mode-banner--mainnet {
  background: color-mix(in srgb, var(--q-primary) 14%, transparent);
}
.settings-mode-banner :deep(.q-banner__content) {
  min-width: 0;
  white-space: normal;
  word-break: break-word;
  overflow-wrap: anywhere;
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
