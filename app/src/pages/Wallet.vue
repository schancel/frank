<template>
  <div>
    <q-header>
      <q-toolbar class="q-pl-sm">
        <q-btn
          class="q-px-sm"
          flat
          dense
          icon="menu"
          :aria-label="$t('a11y.openNavigation')"
          :aria-expanded="myDrawerOpen"
          data-test="wallet-menu-btn"
          @click="$emit('toggleMyDrawerOpen')"
        />
        <q-toolbar-title class="q-py-xs">
          <div class="row items-center no-wrap" data-testid="wallet-name">
            <span
              class="text-weight-bold ellipsis"
              data-testid="wallet-name-text"
            >
              {{
                getCustomName(selectedWallet) ||
                (currentWalletConfig
                  ? $t(currentWalletConfig.defaultNameKey)
                  : $t('walletPanel.mainWallet'))
              }}
            </span>
            <span
              v-if="walletUnit"
              class="q-ml-sm text-weight-regular wallet-header-unit"
              data-testid="wallet-unit"
              >({{ walletUnit }})</span
            >
            <q-badge
              v-if="selectedWalletIsTestnet"
              outline
              color="white"
              class="q-ml-sm wallet-header-unit"
              :label="$t('walletPanel.testnet')"
              data-testid="wallet-testnet-badge"
            />
          </div>
        </q-toolbar-title>
        <q-btn
          flat
          dense
          icon="help_outline"
          :aria-label="$t('walletPanel.aboutAvu')"
          data-testid="wallet-about-avu"
          @click="openAvuDetails"
        >
          <q-tooltip>{{ $t('walletPanel.aboutAvu') }}</q-tooltip>
        </q-btn>
        <q-btn
          flat
          round
          dense
          icon="edit"
          :aria-label="$t('walletPanel.renameWallet')"
          data-testid="wallet-rename-action"
          @click="openRenameDialog"
        >
          <q-tooltip>{{ $t('walletPanel.renameWallet') }}</q-tooltip>
        </q-btn>
      </q-toolbar>
    </q-header>

    <q-page-container>
      <q-page class="q-ma-none q-pa-none">
        <!-- The content is held to the viewport width: the tab bar scrolls inside it instead of
        widening the whole page past a phone's screen. -->
        <q-scroll-area
          class="absolute full-width full-height"
          :content-style="{ width: '100%', minWidth: '100%' }"
          :content-active-style="{ width: '100%', minWidth: '100%' }"
        >
          <div class="wallet-scroll-content">
            <q-card
              flat
              class="wallet-content-card bg-transparent"
              style="max-width: 680px; width: 100%; margin: 0 auto"
            >
              <q-tabs
                v-model="activeTab"
                dense
                no-caps
                class="text-grey-7"
                active-color="primary"
                indicator-color="primary"
                align="justify"
                narrow-indicator
                outside-arrows
                data-testid="wallet-tabs"
              >
                <q-tab
                  name="balance"
                  icon="account_balance_wallet"
                  :label="$t('walletPanel.tabBalance')"
                  data-testid="wallet-tab-balance"
                />
                <q-tab
                  name="history"
                  icon="history"
                  :label="$t('walletPanel.tabHistory')"
                  data-testid="wallet-tab-history"
                />
                <q-tab
                  name="swap"
                  icon="swap_horiz"
                  :label="$t('walletPanel.tabSwap')"
                  data-testid="wallet-tab-swap"
                />
                <q-tab
                  name="parity"
                  icon="show_chart"
                  :label="$t('walletPanel.tabParity')"
                  data-testid="wallet-tab-parity"
                />
              </q-tabs>
              <q-separator />

              <q-tab-panels
                v-model="activeTab"
                animated
                class="bg-transparent col column"
                data-testid="wallet-tab-panels"
              >
                <q-tab-panel name="balance" class="q-pa-none">
                  <q-card-section class="q-py-sm">
                    <div
                      class="text-subtitle1 text-center"
                      :class="
                        balanceUnsupported
                          ? 'text-body2 text-grey-7'
                          : 'text-bold'
                      "
                      role="status"
                      aria-live="polite"
                      data-testid="wallet-balance"
                      :title="balanceTitle"
                    >
                      {{
                        balanceObservation
                          ? balanceObservation.formattedBalance
                          : $t(
                              balancePresentation.status === 'loading'
                                ? 'walletPanel.balanceLoading'
                                : balanceUnsupported
                                ? 'walletPanel.balanceUnsupported'
                                : 'walletPanel.balanceUnavailable',
                            )
                      }}
                    </div>
                    <!-- This chain cannot be reached: said here as well as on the messages
                         that are queued because of it. -->
                    <q-banner
                      v-if="chainUnreachable && selectedChain === 'monad'"
                      dense
                      rounded
                      class="bg-orange-1 text-orange-10 q-my-xs"
                      role="status"
                      data-testid="wallet-chain-unreachable"
                    >
                      {{ $t('chat.chainUnreachable') }}
                    </q-banner>
                    <!-- Opens where the balance is: which accounts hold it. -->
                    <div v-if="canBreakDownBalance" class="text-center">
                      <q-btn
                        flat
                        dense
                        no-caps
                        size="sm"
                        color="primary"
                        :label="$t('balanceBreakdown.open')"
                        :icon-right="
                          showBreakdown ? 'expand_less' : 'expand_more'
                        "
                        :aria-expanded="showBreakdown"
                        data-testid="wallet-balance-breakdown-toggle"
                        @click="showBreakdown = !showBreakdown"
                      />
                    </div>
                    <balance-breakdown
                      v-if="canBreakDownBalance && showBreakdown"
                      class="q-mt-xs q-mb-sm"
                    />
                    <div
                      class="text-caption text-primary cursor-pointer flex items-center justify-center q-gutter-xs q-mt-xs"
                      data-testid="wallet-unit-rate-avu"
                      role="button"
                      tabindex="0"
                      @keydown.enter="openAvuDetails"
                      @keydown.space.prevent="openAvuDetails"
                      @click="openAvuDetails"
                    >
                      <span>{{ currentUnitRateAvu }}</span>
                      <q-icon name="help_outline" size="14px" />
                      <q-tooltip>{{ $t('walletPanel.avuTooltip') }}</q-tooltip>
                    </div>
                    <div
                      v-if="currentWalletAvu"
                      class="text-caption text-grey-7 text-center q-mt-xs cursor-pointer flex items-center justify-center q-gutter-xs"
                      data-testid="wallet-balance-avu"
                      role="button"
                      tabindex="0"
                      @keydown.enter="openAvuDetails"
                      @keydown.space.prevent="openAvuDetails"
                      @click="openAvuDetails"
                    >
                      <span>{{ currentWalletAvu }}</span>
                      <q-icon name="help_outline" size="14px" />
                      <q-tooltip>{{ $t('walletPanel.avuTooltip') }}</q-tooltip>
                    </div>
                    <div
                      v-if="currentWalletHasError"
                      class="text-negative text-caption text-center"
                      data-testid="wallet-balance-error"
                    >
                      {{ $t('walletPanel.balanceUnavailable') }}
                    </div>
                  </q-card-section>
                  <q-separator />
                  <q-card-section
                    v-if="walletStatus === 'unsupported'"
                    data-testid="wallet-unsupported"
                  >
                    <!-- No address: money sent to a chain the app cannot read would be invisible. -->
                    <q-banner dense rounded class="bg-grey-2 text-grey-9">
                      <template #avatar>
                        <q-icon name="block" color="grey-7" />
                      </template>
                      {{ $t('walletPanel.walletUnsupported') }}
                    </q-banner>
                  </q-card-section>
                  <q-card-section v-else>
                    <div
                      class="row justify-center items-center"
                      style="min-height: 300px"
                      data-testid="wallet-qr-container"
                    >
                      <qrcode-vue
                        v-if="displayAddress"
                        style="margin-left: auto; margin-right: auto"
                        :value="displayAddress"
                        :size="300"
                        level="H"
                        data-testid="wallet-qr"
                      />
                      <q-skeleton
                        v-else
                        size="300px"
                        square
                        data-testid="wallet-qr-skeleton"
                      />
                    </div>
                    <div class="row q-mt-md">
                      <q-input
                        class="fit"
                        filled
                        auto-grow
                        :loading="addressAvailability === 'loading'"
                        v-model="displayAddress"
                        readonly
                      >
                        <template #append>
                          <q-btn
                            dense
                            color="primary"
                            flat
                            icon="content_copy"
                            :aria-label="$t('a11y.copyAddress')"
                            :disable="!displayAddress"
                            data-testid="wallet-copy-address"
                            @click="copyAddress"
                          />
                        </template>
                      </q-input>
                    </div>
                    <div
                      v-if="
                        addressAvailability === 'discovery-unavailable' ||
                        addressAvailability === 'unavailable'
                      "
                      role="alert"
                      data-testid="wallet-address-unavailable"
                      class="q-mt-md"
                    >
                      {{
                        $t(
                          addressAvailability === 'discovery-unavailable'
                            ? 'walletPanel.receiveDiscoveryUnavailable'
                            : 'walletPanel.receiveAddressUnavailable',
                        )
                      }}
                      <q-btn
                        flat
                        no-caps
                        :label="$t('walletPanel.retryAddress')"
                        data-testid="wallet-retry-address"
                        @click="addressRetry++"
                      />
                    </div>
                    <q-card-actions
                      align="right"
                      class="q-px-none q-pt-md bg-transparent"
                    >
                      <q-btn
                        no-caps
                        outline
                        color="primary"
                        :label="$t('walletPanel.sendToContact')"
                        :disable="selectedWallet !== 'monad'"
                        data-testid="wallet-contact-send-action"
                        @click="openSendContact"
                      />
                      <q-btn
                        no-caps
                        :label="$t(sendLabel.key, sendLabel.params ?? {})"
                        color="primary"
                        :disable="!sendChainIdentifier"
                        data-testid="wallet-send-action"
                        data-test="wallet-legacy-send-action"
                        @click="openSend"
                      />
                    </q-card-actions>
                    <held-contact-payments v-if="selectedWallet === 'monad'" />
                  </q-card-section>

                  <!-- Assets & Tokens Card -->
                  <div class="q-px-md q-pt-md">
                    <q-card
                      flat
                      bordered
                      class="q-pa-md bg-transparent"
                      data-testid="wallet-tokens-card"
                    >
                      <div class="row items-center justify-between q-mb-sm">
                        <div class="row items-center q-gutter-x-xs">
                          <q-icon
                            name="account_balance_wallet"
                            size="18px"
                            color="primary"
                          />
                          <span class="text-subtitle2 text-weight-bold">
                            {{ $t('walletPanel.assetsAndTokens') }}
                          </span>
                        </div>
                        <q-badge
                          outline
                          color="primary"
                          class="text-bold"
                          data-testid="wallet-asset-count"
                        >
                          {{ assetCount }}
                          {{ assetCount === 1 ? 'Asset' : 'Assets' }}
                        </q-badge>
                      </div>

                      <p
                        v-if="tokenStatusKey"
                        role="status"
                        class="text-caption text-grey-7"
                        data-testid="wallet-token-status"
                      >
                        {{ $t(tokenStatusKey) }}
                      </p>

                      <q-list separator class="rounded-borders">
                        <q-item
                          v-if="nativeAsset"
                          class="q-px-none q-py-sm"
                          :data-testid="`wallet-token-item-${nativeAsset.unit.toLowerCase()}`"
                          data-native-asset
                        >
                          <q-item-section avatar top>
                            <q-avatar
                              size="36px"
                              color="primary"
                              text-color="white"
                              icon="toll"
                            />
                          </q-item-section>
                          <q-item-section>
                            <q-item-label class="text-weight-bold">
                              {{ nativeAsset.unit }}
                              <span
                                class="text-caption text-grey-7 font-weight-normal q-ml-xs"
                              >
                                · {{ nativeAsset.name }}
                              </span>
                            </q-item-label>
                            <q-item-label caption class="text-grey-6">
                              {{ $t('walletPanel.nativeCoin') }}
                            </q-item-label>
                          </q-item-section>
                          <q-item-section side>
                            <q-item-label
                              class="text-weight-bolder text-right"
                              :title="balanceTitle"
                            >
                              {{
                                balanceObservation
                                  ? currentWalletHasError
                                    ? $t('walletPanel.balanceStale', {
                                        balance:
                                          balanceObservation.formattedBalance,
                                      })
                                    : balanceObservation.formattedBalance
                                  : $t(
                                      balancePresentation.status === 'loading'
                                        ? 'walletPanel.balanceLoading'
                                        : 'walletPanel.balanceUnavailable',
                                    )
                              }}
                            </q-item-label>
                            <q-item-label
                              v-if="!currentWalletHasError && currentWalletAvu"
                              caption
                              class="text-grey-7 text-right"
                            >
                              {{ currentWalletAvu }}
                            </q-item-label>
                          </q-item-section>
                        </q-item>
                        <q-item
                          v-for="token in nonNativeTokens"
                          :key="token.id"
                          class="q-px-none q-py-sm"
                          :data-testid="`wallet-token-item-${token.symbol.toLowerCase()}`"
                        >
                          <q-item-section avatar top>
                            <q-avatar
                              size="36px"
                              :color="
                                token.isNative ? 'primary' : 'deep-purple'
                              "
                              text-color="white"
                              :icon="
                                token.isNative ? 'toll' : 'generating_tokens'
                              "
                            />
                          </q-item-section>
                          <q-item-section>
                            <q-item-label class="text-weight-bold">
                              {{ token.symbol }}
                              <span
                                class="text-caption text-grey-7 font-weight-normal q-ml-xs"
                              >
                                · {{ token.name }}
                              </span>
                            </q-item-label>
                            <q-item-label caption class="text-grey-6">
                              <span
                                v-if="!token.isNative && token.mintOrAddress"
                              >
                                {{ $t('walletPanel.tokenMint') }}:
                                <address-text
                                  :address="token.mintOrAddress"
                                  copyable
                                />
                              </span>
                              <span v-else>
                                {{ $t('walletPanel.nativeCoin') }}
                              </span>
                            </q-item-label>
                          </q-item-section>
                          <q-item-section side>
                            <q-item-label class="text-weight-bolder text-right">
                              {{ token.balanceFormatted }}
                            </q-item-label>
                            <q-item-label
                              caption
                              class="text-grey-7 text-right"
                            >
                              {{ token.avuFormatted }}
                            </q-item-label>
                          </q-item-section>
                        </q-item>
                        <!-- ERC-20s on the same account, read from the chain. -->
                        <q-item
                          v-for="token in evmTokens"
                          :key="token.address"
                          class="q-px-none q-py-sm"
                          :data-testid="`wallet-token-item-${token.symbol.toLowerCase()}`"
                        >
                          <q-item-section avatar top>
                            <q-avatar
                              size="36px"
                              color="deep-purple"
                              text-color="white"
                              icon="generating_tokens"
                            />
                          </q-item-section>
                          <q-item-section>
                            <q-item-label class="text-weight-bold">
                              {{ token.symbol }}
                              <span
                                class="text-caption text-grey-7 font-weight-normal q-ml-xs"
                              >
                                · {{ token.name }}
                              </span>
                            </q-item-label>
                            <q-item-label
                              caption
                              class="text-grey-6 wallet-token-contract"
                            >
                              {{ $t('walletPanel.tokenContract') }}:
                              <address-text :address="token.address" copyable />
                            </q-item-label>
                          </q-item-section>
                          <q-item-section side>
                            <q-item-label
                              class="text-weight-bolder text-right"
                              :title="token.exact"
                            >
                              {{ token.balance }}
                            </q-item-label>
                          </q-item-section>
                        </q-item>
                      </q-list>
                      <p
                        v-if="evmTokenStatus === 'unavailable'"
                        role="status"
                        class="text-caption text-grey-7 q-mt-sm q-mb-none"
                        data-testid="wallet-evm-token-status"
                      >
                        {{ $t('walletPanel.tokenBalancesUnavailable') }}
                      </p>
                    </q-card>
                  </div>
                </q-tab-panel>

                <q-tab-panel
                  name="history"
                  class="q-pa-none"
                  data-testid="wallet-history-panel"
                >
                  <q-card-section data-testid="wallet-native-operations">
                    <p
                      v-if="nativeOperations.status !== 'available'"
                      role="status"
                      class="text-caption text-grey-7"
                    >
                      {{ $t(`nativeOperation.${nativeOperations.status}`) }}
                    </p>
                    <p
                      v-if="!historyGroups.length"
                      data-testid="wallet-activity-empty"
                    >
                      {{ $t('walletPanel.historyEmpty') }}
                    </p>
                    <q-list v-else separator data-testid="wallet-activity-list">
                      <template v-for="group in historyGroups" :key="group.id">
                        <q-item-label header>{{
                          $t(group.label)
                        }}</q-item-label>
                        <q-item
                          v-for="entry in group.rows"
                          :key="entry.id"
                          class="q-px-none q-py-md"
                          data-testid="wallet-activity-item"
                          :data-activity-id="entry.id"
                        >
                          <q-item-section avatar top>
                            <q-icon
                              :name="
                                entry.kind === 'swap'
                                  ? 'swap_horiz'
                                  : 'north_east'
                              "
                              color="primary"
                              size="24px"
                            />
                          </q-item-section>
                          <q-item-section>
                            <template v-if="entry.kind === 'swap'">
                              <q-item-label class="text-weight-bold">
                                {{ entry.swap.fromAmount }}
                                {{ entry.swap.fromAsset }} →
                                {{ entry.swap.status === 'pending' ? '≥' : ''
                                }}{{ entry.swap.toAmount }}
                                {{ entry.swap.toAsset }}
                              </q-item-label>
                              <q-item-label caption>
                                {{ entry.swap.route }} ·
                                {{ formatSwapTime(entry.swap.timestamp) }}
                              </q-item-label>
                            </template>
                            <template v-else>
                              <q-item-label class="text-weight-bold">
                                {{
                                  nativeAmount(entry.operation.intendedValueWei)
                                }}
                                {{ nativeUnit }}
                              </q-item-label>
                              <q-item-label caption>{{
                                $t('nativeOperation.intendedAmount')
                              }}</q-item-label>
                              <address-text
                                :address="entry.operation.recipient"
                                copyable
                              />
                              <q-item-label caption>
                                {{
                                  $t(
                                    `nativeOperation.${entry.operation.payment}`,
                                    {
                                      network: networkName(
                                        entry.operation.chainIdentifier,
                                      ),
                                    },
                                  )
                                }}
                              </q-item-label>
                            </template>
                            <details
                              v-if="entry.operation"
                              data-testid="wallet-native-operation"
                              class="q-mt-xs"
                            >
                              <summary class="wallet-history-action">
                                {{ $t('nativeOperation.viewTransfer') }}
                              </summary>
                              <p v-if="entry.operation.kind === 'contract'">
                                {{ $t('nativeOperation.contractCall') }}
                              </p>
                              <p>
                                {{
                                  $t(
                                    `nativeOperation.${entry.operation.payment}`,
                                    {
                                      network: networkName(
                                        entry.operation.chainIdentifier,
                                      ),
                                    },
                                  )
                                }}
                              </p>
                              <p>{{ entry.operation.operationId }}</p>
                              <p>
                                {{ $t('nativeOperation.intendedAmount') }}:
                                {{
                                  nativeAmount(entry.operation.intendedValueWei)
                                }}
                                {{ nativeUnit }}
                              </p>
                              <address-text
                                :address="entry.operation.recipient"
                                copyable
                              />
                              <p>
                                {{
                                  $t(
                                    `nativeOperation.fee${entry.operation.feeCoverage}`,
                                    {
                                      amount: nativeAmount(
                                        entry.operation.observedFeeWei,
                                      ),
                                      unit: nativeUnit,
                                    },
                                  )
                                }}
                              </p>
                              <div
                                v-for="(member, index) in entry.operation
                                  .members"
                                :key="index"
                                class="q-my-sm"
                              >
                                <address-text
                                  v-if="member.transactionHash"
                                  :address="member.transactionHash"
                                  copyable
                                />
                                <a
                                  v-if="
                                    member.transactionHash &&
                                    transactionExplorerLink(
                                      member.transactionHash,
                                      entry.operation.chainIdentifier,
                                    )
                                  "
                                  :href="
                                    transactionExplorerLink(
                                      member.transactionHash,
                                      entry.operation.chainIdentifier,
                                    )
                                  "
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  class="wallet-history-action"
                                >
                                  {{ $t('walletPanel.viewInExplorer') }}
                                </a>
                                <p v-if="member.blockNumber !== undefined">
                                  {{
                                    $t('nativeOperation.block', {
                                      block: member.blockNumber,
                                    })
                                  }}
                                </p>
                              </div>
                              <p
                                class="text-caption text-grey-7"
                                data-testid="wallet-native-operation-sync"
                              >
                                {{
                                  $t(
                                    entry.operation.sharing === 'shared'
                                      ? 'nativeOperation.syncShared'
                                      : entry.operation.sharing === 'failed'
                                      ? 'nativeOperation.syncFailed'
                                      : 'nativeOperation.syncNotShared',
                                  )
                                }}
                              </p>
                              <p
                                v-if="
                                  entry.operation.payment !== 'included' &&
                                  entry.operation.payment !== 'pending' &&
                                  entry.operation.payment !== 'missing'
                                "
                                data-testid="wallet-native-operation-recovery"
                              >
                                {{ $t('nativeOperation.recoveryUnavailable') }}
                              </p>
                            </details>
                          </q-item-section>
                          <q-item-section v-if="entry.kind === 'swap'" side top>
                            <q-badge
                              :color="
                                entry.swap.status === 'confirmed'
                                  ? 'positive'
                                  : entry.swap.status === 'pending'
                                  ? 'warning'
                                  : 'negative'
                              "
                              outline
                              class="text-bold"
                              data-testid="wallet-activity-status"
                            >
                              {{ $t(`swap.status.${entry.swap.status}`) }}
                            </q-badge>
                            <a
                              v-if="getExplorerLink(entry.swap)"
                              :href="getExplorerLink(entry.swap)"
                              target="_blank"
                              rel="noopener noreferrer"
                              class="wallet-history-action q-mt-xs"
                            >
                              {{ $t('walletPanel.viewInExplorer') }}
                            </a>
                          </q-item-section>
                        </q-item>
                      </template>
                    </q-list>
                  </q-card-section>
                </q-tab-panel>

                <q-tab-panel name="swap" class="q-pa-none">
                  <d-app-swap-view
                    :selected-wallet="selectedWallet"
                    :is-testnet="isTestnet"
                  />
                </q-tab-panel>

                <q-tab-panel name="parity" class="q-pa-none">
                  <avu-parity-chart :selected-wallet="selectedWallet" />
                </q-tab-panel>
              </q-tab-panels>
            </q-card>
          </div>
        </q-scroll-area>
      </q-page>

      <rename-wallet-dialog
        v-model="showRenameDialog"
        :chain="renameChain"
        :current-name="getCustomName(renameChain)"
        :default-name="
          $t(renameWalletConfig?.defaultNameKey || 'walletPanel.mainWallet')
        "
        @save="saveWalletName"
        @reset="resetCustomName(renameChain)"
      />
    </q-page-container>
  </div>
</template>

<script lang="ts">
import {
  computed,
  defineComponent,
  onBeforeUnmount,
  onMounted,
  ref,
  shallowRef,
  watch,
} from 'vue'
import { useRoute, useRouter } from 'vue-router'

import QrcodeVue from 'qrcode.vue'
import AddressText from 'src/components/AddressText.vue'
import RenameWalletDialog from 'src/components/wallet/RenameWalletDialog.vue'
import AvuParityChart from 'src/components/wallet/AvuParityChart.vue'
import BalanceBreakdown from 'src/components/wallet/BalanceBreakdown.vue'
import DAppSwapView from 'src/components/wallet/DAppSwapView.vue'
import HeldContactPayments from 'src/components/wallet/HeldContactPayments.vue'
import { copyToClipboard } from 'quasar'
import { useActiveWallet } from 'src/composables/useActiveWallet'
import { useChainBalance } from 'src/composables/useChainBalance'
import { useBalance } from 'src/composables/useBalance'
import { useMyDrawerOpen } from 'src/composables/useMyDrawerOpen'
import { useWalletNames } from 'src/composables/useWalletNames'
import { openPage } from 'src/utils/routes'
import { addressCopiedNotify, errorNotify } from 'src/utils/notifications'
import { accountSession, accountStatus } from '../accounts/session'
import {
  inspectNativeTransferOperations,
  type NativeOperationInspection,
} from 'src/accounts/native-transfer'
import {
  activeChain,
  onActiveChainChange,
  findEvmNativeOperationStatus,
  getChainRegistryEntry,
  type EvmNativeOperationStatus,
} from '@frank/wallet/chain'
import { useSafeOracleStore } from 'src/stores/oracle'
import { useSwapActivity, type SwapActivityRow } from 'src/swap/useSwapActivity'
import { useEvmTokenBalances } from 'src/composables/useEvmTokenBalances'
import { getExplorerUrl } from 'src/utils/explorer'
import { WALLET_CONFIGS } from 'src/utils/wallet-configs'
import { nativeSendChainIdentifier } from 'src/utils/native-transfer'
import { walletSupport } from 'src/utils/wallet-support'
import { openUtxoWallet } from 'src/accounts/utxo-wallets'

type WalletHistoryRow =
  | {
      kind: 'swap'
      id: string
      swap: SwapActivityRow
      operation?: EvmNativeOperationStatus
    }
  | { kind: 'native'; id: string; operation: EvmNativeOperationStatus }

// One wallet's detail view in the main pane (#570): the Wallet rail tab's drawer shows the
// wallet list; picking a row lands here for that wallet's info and actions. Stealth payment
// initiation is deliberately absent until the stealth design (#71) lands -- no dead controls.
export default defineComponent({
  components: {
    QrcodeVue,
    AddressText,
    RenameWalletDialog,
    AvuParityChart,
    DAppSwapView,
    HeldContactPayments,
    BalanceBreakdown,
  },
  emits: ['toggleMyDrawerOpen'],
  setup() {
    const myDrawerOpen = useMyDrawerOpen()
    const route = useRoute()
    const router = useRouter()
    // The global adapter is a plain object; subscribe to its owner instead of
    // expecting Vue to observe in-place network replacement.
    const network = shallowRef({ ...activeChain })
    onBeforeUnmount(
      onActiveChainChange(chain => {
        network.value = { ...chain }
      }),
    )
    const isTestnet = computed(() => network.value.isTestnet ?? false)
    const { getCustomName, setCustomName, resetCustomName } = useWalletNames()
    const showRenameDialog = ref(false)
    const renameChain = ref('monad')
    const renameWalletConfig = computed(() =>
      WALLET_CONFIGS.find(wallet => wallet.id === renameChain.value),
    )
    function openRenameDialog() {
      renameChain.value = selectedWallet.value
      showRenameDialog.value = true
    }
    function saveWalletName(name: string) {
      setCustomName(renameChain.value, name)
    }
    const oracle = useSafeOracleStore()
    const activeTab = ref<'balance' | 'history' | 'swap' | 'parity'>('balance')

    const selectedWallet = computed<string>(() => {
      const parts = (route?.path || '').toLowerCase().split('/').filter(Boolean)
      if (parts[0] === 'wallet' && parts[1]) {
        return parts[1]
      }
      const walletParam = (route?.params?.wallet as string)?.toLowerCase()
      if (walletParam) return walletParam
      const chainParam = (route?.params?.chain as string)?.toLowerCase()
      if (chainParam) return chainParam
      const query = (
        (route?.query?.chain || route?.query?.wallet) as string
      )?.toLowerCase()
      if (query) return query
      return 'monad'
    })

    const currentWalletConfig = computed(() =>
      WALLET_CONFIGS.find(w => w.id === selectedWallet.value),
    )
    const sendChainIdentifier = computed(() =>
      nativeSendChainIdentifier(
        selectedWallet.value,
        isTestnet.value,
        network.value.chainIdentifier,
      ),
    )

    // Whether the app has a wallet for this network, from the chain registry.
    const support = computed(() =>
      walletSupport(
        selectedWallet.value,
        isTestnet.value,
        network.value.chainIdentifier,
      ),
    )
    const walletStatus = computed(() => support.value.status)
    const sendLabel = computed(() => ({
      key: 'walletPanel.sendAsset',
      params: { unit: support.value.entry?.unit ?? '' },
    }))

    // Shared with the drawer: one polling loop, so this page refreshes without a reload.
    const {
      presentation: balancePresentation,
      tokens: activeTokens,
      tokenObservation,
      refreshCordoned,
    } = useChainBalance(selectedWallet)
    // The profile address is otherwise read at a slow cadence; opening this page shows it fresh.
    onMounted(() => void refreshCordoned?.())
    // Whether the active wallet's chain answers, as the shared balance loop last found.
    const { chainUnreachable } = useBalance()
    // The breakdown reads the active (Monad) wallet's accounts; it is opened from the balance.
    const showBreakdown = ref(false)
    const canBreakDownBalance = computed(
      () => selectedWallet.value === 'monad' && !!balanceObservation.value,
    )
    watch(selectedWallet, () => (showBreakdown.value = false))
    const tokenStatusKey = computed(() => {
      const observation = tokenObservation.value
      if (!observation || observation.status === 'available') return ''
      if (observation.status === 'loading')
        return 'walletPanel.tokenBalancesLoading'
      return observation.lastKnown
        ? 'walletPanel.tokenBalancesStale'
        : 'walletPanel.tokenBalancesUnavailable'
    })
    const balanceObservation = computed(() => {
      const presentation = balancePresentation.value
      return presentation.status === 'available'
        ? presentation.observation
        : presentation.status === 'unavailable'
        ? presentation.lastKnown
        : undefined
    })
    // Every digit, on hover: the balance line itself is shortened for reading.
    const balanceTitle = computed(() => {
      const observation = balanceObservation.value
      return observation?.exactBalance ?? undefined
    })
    // No balance reader exists for this network: said once and quietly, not as a failed fetch.
    const balanceUnsupported = computed(() => {
      const presentation = balancePresentation.value
      return (
        presentation.status === 'unavailable' &&
        presentation.reason === 'unsupported' &&
        !presentation.lastKnown
      )
    })
    const currentWalletHasError = computed(
      () =>
        balancePresentation.value.status === 'unavailable' &&
        !balanceUnsupported.value,
    )

    const currentUnitRateAvu = computed(() => {
      const asset = selectedWallet.value as any
      return oracle.formatUnitRate ? oracle.formatUnitRate(asset) : ''
    })

    const currentWalletAvu = computed(() => {
      const observation = balanceObservation.value
      if (!observation?.balance) return ''
      return oracle.formatAvuAmount(
        selectedWallet.value as any,
        observation.balance,
      )
    })

    const {
      rows: evmTokens,
      status: evmTokenStatus,
      refresh: refreshEvmTokens,
    } = useEvmTokenBalances(sendChainIdentifier)
    // Asset rows are a derived view, not another balance owner. Solana's reader already
    // includes its native coin; show that coin once through the same row as other families.
    const nativeAsset = computed(() =>
      support.value.status === 'available' ? support.value.entry : undefined,
    )
    const nonNativeTokens = computed(() =>
      activeTokens.value.filter(token => !token.isNative),
    )
    const assetCount = computed(
      () =>
        (nativeAsset.value ? 1 : 0) +
        nonNativeTokens.value.length +
        evmTokens.value.length,
    )
    // Coming back from the swap tab, the token balances are read again at once.
    watch(activeTab, tab => {
      if (tab === 'balance') void refreshEvmTokens()
    })

    // The account's swaps on this network, as its own notes record them, with what each did
    // read from the chain.
    const { rows: recentSwaps } = useSwapActivity(sendChainIdentifier)

    const formatSwapTime = (timestamp: number) => {
      try {
        const diff = Date.now() - timestamp
        if (diff < 60_000) return 'Just now'
        if (diff < 3600_000) return `${Math.floor(diff / 60_000)}m ago`
        if (diff < 86400_000) return `${Math.floor(diff / 3600_000)}h ago`
        return new Date(timestamp).toLocaleDateString()
      } catch {
        return ''
      }
    }

    const transactionExplorerLink = (hash: string, chainIdentifier: string) =>
      getExplorerUrl(hash, chainIdentifier, { isTestnet: isTestnet.value })
    const getExplorerLink = (swap: SwapActivityRow) =>
      swap.txHash
        ? transactionExplorerLink(swap.txHash, swap.chainIdentifier)
        : undefined

    const nativeOperations = shallowRef<NativeOperationInspection>({
      status: 'unsupported',
    })
    // A derived view only: journal operations and swap history retain their existing owners.
    // A matching final transaction is one activity, with both the swap and transfer details.
    const historyGroups = computed(() => {
      const operations =
        nativeOperations.value.status === 'available'
          ? nativeOperations.value.operations
          : []
      const attached = new Set<string>()
      const rows: WalletHistoryRow[] = recentSwaps.value
        .filter(swap => swap.chainIdentifier === sendChainIdentifier.value)
        .sort((a, b) => b.timestamp - a.timestamp || a.id.localeCompare(b.id))
        .map(swap => {
          const operation = findEvmNativeOperationStatus(
            operations,
            swap.chainIdentifier,
            swap.txHash,
          )
          if (operation) attached.add(operation.operationId)
          return { kind: 'swap', id: `swap:${swap.id}`, swap, operation }
        })
      for (const operation of operations) {
        if (!attached.has(operation.operationId))
          rows.push({
            kind: 'native',
            id: `native:${operation.operationId}`,
            operation,
          })
      }
      const pending = (row: WalletHistoryRow) =>
        row.kind === 'swap'
          ? row.swap.status === 'pending'
          : !['included', 'reverted', 'cancelled'].includes(
              row.operation.payment,
            )
      return [
        {
          id: 'pending',
          label: 'walletPanel.historyPending',
          rows: rows.filter(pending),
        },
        {
          id: 'dated',
          label: 'walletPanel.tabHistory',
          rows: rows.filter(row => !pending(row) && row.kind === 'swap'),
        },
        // The public native inspection currently has no event/block timestamp. Keep these
        // explicitly undated, rather than assigning an invented date or older ordering.
        {
          id: 'undated',
          label: 'walletPanel.historyUndated',
          rows: rows.filter(row => !pending(row) && row.kind === 'native'),
        },
      ].filter(group => group.rows.length > 0)
    })
    const networkName = (chainIdentifier: string) =>
      getChainRegistryEntry(chainIdentifier)?.name ?? ''

    const nativePresentation = shallowRef({
      unit: '',
      toDisplayAmount: (value: bigint) => value.toString(),
    })
    const displayAddress = ref(
      accountSession.getCachedChainAddress?.(selectedWallet.value) ?? '',
    )

    const addressAvailability = ref<
      'loading' | 'ready' | 'discovery-unavailable' | 'unavailable'
    >('loading')
    const addressRetry = ref(0)
    watch(
      () => [
        accountStatus.status,
        accountStatus.revision,
        selectedWallet.value,
        network.value.chainIdentifier,
        addressRetry.value,
      ],
      async ([status, , chain], _previous, onCleanup) => {
        addressAvailability.value = 'loading'
        nativeOperations.value = {
          status: chain === 'monad' ? 'unavailable' : 'unsupported',
        }
        const capturedChain = network.value
        if (status !== 'ready') {
          displayAddress.value = ''
          return
        }
        const capability = walletSupport(
          chain,
          capturedChain.isTestnet ?? false,
          capturedChain.chainIdentifier,
        )
        if (capability.status === 'unsupported') {
          displayAddress.value = ''
          return
        }
        const utxoChain =
          capability.entry.family === 'bitcoin'
            ? capability.entry.id
            : undefined
        // A Bitcoin-family address rotates, so a cached one may already have been paid.
        displayAddress.value = utxoChain
          ? ''
          : accountSession.getCachedChainAddress?.(chain) ?? ''
        let current = true
        onCleanup(() => {
          current = false
        })
        try {
          if (chain === 'monad') {
            const address = await accountSession.getChainAddress(
              capturedChain.chainIdentifier,
            )
            if (!current) return
            displayAddress.value = address
            nativePresentation.value = capturedChain
            // Financial acquisition is separate from the local receive address. A failed
            // operation inspection must not hide an address the ready session owns.
            void useActiveWallet()
              .then(wallet => {
                if (current)
                  nativeOperations.value = inspectNativeTransferOperations(
                    wallet,
                    capturedChain.chainIdentifier,
                  )
              })
              .catch(() => undefined)
          } else if (utxoChain) {
            // The wallet's next unused receive address, never one that was already paid.
            const { wallet } = await openUtxoWallet(utxoChain)
            const address = await wallet.getReceiveAddress()
            if (current) displayAddress.value = address.raw
          } else {
            const address = await accountSession.getChainAddress(chain)
            if (current) displayAddress.value = address
          }
          if (current) addressAvailability.value = 'ready'
        } catch {
          if (current) {
            displayAddress.value = ''
            addressAvailability.value = utxoChain
              ? 'discovery-unavailable'
              : 'unavailable'
            console.error('wallet-receive-address-unavailable', {
              chainIdentifier: capability.entry.id,
              code: addressAvailability.value,
            })
          }
        }
      },
      { immediate: true, flush: 'sync' },
    )

    return {
      myDrawerOpen,
      nativeOperations,
      historyGroups,
      networkName,
      nativeUnit: computed(() => nativePresentation.value.unit),
      nativeAmount: (value: string) =>
        nativePresentation.value.toDisplayAmount(BigInt(value)),
      activeTab,
      selectedWallet,
      sendChainIdentifier,
      walletStatus,
      sendLabel,
      selectedWalletIsTestnet: computed(
        () => support.value.entry?.isTestnet ?? false,
      ),
      walletUnit: computed(() => support.value.entry?.unit ?? ''),
      selectedChain: selectedWallet,
      currentWalletConfig,
      isTestnet,
      displayAddress,
      addressAvailability,
      addressRetry,
      balancePresentation,
      balanceObservation,
      chainUnreachable,
      balanceTitle,
      showBreakdown,
      canBreakDownBalance,
      balanceUnsupported,
      currentWalletHasError,
      currentWalletAvu,
      currentUnitRateAvu,
      getCustomName,
      resetCustomName,
      showRenameDialog,
      renameChain,
      renameWalletConfig,
      openRenameDialog,
      saveWalletName,
      openAvuDetails: () => openPage(router, '/avu'),
      async copyAddress() {
        if (!displayAddress.value) return
        try {
          await copyToClipboard(displayAddress.value)
          addressCopiedNotify()
        } catch (err) {
          errorNotify(err, { fallbackKey: 'walletPanel.unableCopyAddress' })
        }
      },
      openSend() {
        if (sendChainIdentifier.value) {
          openPage(router, `/send?chainIdentifier=${sendChainIdentifier.value}`)
        }
      },
      openSendContact() {
        openPage(router, '/send-contact')
      },
      openReceive() {
        openPage(router, '/wallet')
      },
      nativeAsset,
      nonNativeTokens,
      assetCount,
      evmTokens,
      evmTokenStatus,
      tokenStatusKey,
      recentSwaps,
      formatSwapTime,
      getExplorerLink,
      transactionExplorerLink,
    }
  },
})
</script>

<style scoped>
.wallet-token-contract :deep(.address-text) {
  width: fit-content;
  max-width: 100%;
}

.wallet-header-unit {
  flex-shrink: 0;
}
.wallet-history-action {
  color: var(--q-primary);
  cursor: pointer;
  text-decoration: underline;
  text-underline-offset: 2px;
}

.wallet-scroll-content {
  width: 100%;
  min-height: 100%;
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: 16px 20px 32px;
  box-sizing: border-box;
}

.wallet-content-card {
  width: 100%;
  max-width: 680px;
  margin: 0 auto;
}

/* The bracket wraps whole under the total instead of breaking in the middle. */
.wallet-balance-bracket {
  display: inline-block;
  white-space: nowrap;
}

@media (max-width: 600px) {
  .wallet-scroll-content {
    padding: 8px 10px 24px;
  }
}
</style>
