<template>
  <div class="welcome-container column full-height overflow-hidden">
    <q-header>
      <q-toolbar class="q-pl-sm">
        <q-btn
          class="q-px-sm"
          flat
          dense
          @click="toggleSettingsDrawerOpen"
          icon="menu"
          :aria-label="$t('a11y.openNavigation')"
          :aria-expanded="myDrawerOpen"
          data-test="welcome-menu"
        />
        <q-toolbar-title class="h6">{{ $t('welcome.title') }}</q-toolbar-title>
      </q-toolbar>
    </q-header>

    <q-page-container class="col full-height overflow-hidden">
      <q-page
        class="q-pa-md welcome-page col full-height overflow-y-auto"
        :style-fn="pageStyle"
        data-test="welcome-scroll"
      >
        <!-- Hero Section -->
        <div
          class="column items-center q-mb-xl text-center welcome-hero"
          data-test="welcome-hero"
        >
          <q-avatar size="96px" class="q-mb-md shadow-3">
            <img src="@brand-hero-logo" :alt="$t('about.appName')" />
          </q-avatar>
          <div class="text-h3 text-weight-bolder tracking-tight">
            {{ $t('about.appName') }}
          </div>
          <div
            class="text-h6 text-primary text-weight-bold q-mt-xs"
            data-test="welcome-tagline"
          >
            {{ $t('welcome.tagline') }}
          </div>
          <div class="text-subtitle1 text-grey-8 q-mt-xs">
            {{ $t('welcome.subtitle') }}
          </div>
          <div class="row q-gutter-xs q-mt-sm justify-center">
            <q-chip dense outline color="primary" icon="bolt">
              {{ $t('about.badgeMonad') }}
            </q-chip>
            <q-chip dense outline color="secondary" icon="mail">
              {{ $t('about.badgeStamp') }}
            </q-chip>
            <q-chip dense outline color="accent" icon="lock">
              {{ $t('about.badgeEncrypted') }}
            </q-chip>
            <q-chip dense outline color="dark" icon="key">
              {{ $t('about.badgePermissionless') }}
            </q-chip>
          </div>

          <p class="text-body1 text-grey-9 q-mt-md welcome-intro-text">
            {{ $t('welcome.introText') }}
          </p>

          <!-- Primary Call to Actions -->
          <div class="welcome-actions q-mt-md">
            <q-btn
              color="primary"
              unelevated
              no-caps
              class="welcome-action"
              icon="login"
              :label="$t('welcome.createAccount')"
              to="/setup"
              data-test="btn-create-account"
            />
            <q-btn
              color="secondary"
              outline
              no-caps
              class="welcome-action"
              icon="extension"
              :label="extensionUi.connectExtensionBtn"
              data-test="btn-connect-extension"
              @click="connectBrowserExtension"
            />
            <q-btn
              color="primary"
              outline
              no-caps
              class="welcome-action"
              icon="dynamic_feed"
              :label="$t('welcome.browseForum')"
              to="/forum"
              data-test="btn-browse-forum"
            />
          </div>

          <!-- Bundled Browser Extension Download Card (when viewing on web/PWA) -->
          <div
            v-if="!isExtensionRuntime"
            class="welcome-extension-download q-mt-md q-pa-sm rounded-borders"
            data-test="welcome-download-extension-section"
          >
            <div class="row items-center justify-center q-gutter-xs">
              <q-btn
                color="primary"
                flat
                dense
                no-caps
                icon="download"
                :label="selectedExtensionInfo.label"
                :href="selectedExtensionInfo.url"
                :download="selectedExtensionInfo.filename"
                data-test="btn-download-extension"
                @click="selectExtensionTarget(selectedExtensionTarget)"
              />
              <q-btn
                v-for="targetItem in allExtensionTargets"
                :key="targetItem.target"
                flat
                dense
                no-caps
                size="sm"
                :color="
                  selectedExtensionTarget === targetItem.target
                    ? 'primary'
                    : 'grey-7'
                "
                :label="targetItem.shortLabel"
                :href="targetItem.url"
                :download="targetItem.filename"
                :data-test="`btn-download-extension-${targetItem.target}`"
                @click="selectExtensionTarget(targetItem.target)"
              />
            </div>
            <div
              class="text-caption text-grey-7 q-mt-xs"
              data-test="welcome-extension-install-hint"
            >
              {{ selectedExtensionInfo.installHint }}
            </div>
          </div>

          <div
            v-if="syncOffer"
            class="q-mt-sm q-pa-sm rounded-borders"
            data-test="welcome-extension-sync-offer"
          >
            <div class="text-body2">{{ syncOfferText }}</div>
            <div class="text-caption text-grey-7">
              {{ extensionUi.syncCheckCodeHint }}
              <strong data-test="welcome-extension-sync-code">{{
                syncOffer.checkCode
              }}</strong>
            </div>
            <div class="row justify-center q-gutter-xs q-mt-xs">
              <q-btn
                unelevated
                dense
                no-caps
                color="primary"
                :label="extensionUi.restoreSyncedAccountBtn"
                :loading="syncRestoring"
                data-test="btn-restore-synced-account"
                @click="restoreSyncedAccount"
              />
              <q-btn
                flat
                dense
                no-caps
                color="grey-8"
                :label="extensionUi.dismissSyncedAccountBtn"
                :disable="syncRestoring"
                data-test="btn-dismiss-synced-account"
                @click="dismissSyncOffer"
              />
            </div>
            <div
              v-if="syncRestoreFailed"
              class="text-caption text-negative q-mt-xs"
              data-test="welcome-extension-sync-failed"
            >
              {{ extensionUi.syncRestoreFailed }}
            </div>
          </div>

          <div class="q-mt-md">
            <q-btn
              flat
              dense
              no-caps
              color="grey-8"
              class="welcome-docs"
              icon="menu_book"
              :label="$t('welcome.readDocs')"
              to="/docs"
              data-test="btn-read-docs"
            />
          </div>
        </div>

        <!-- How Frank Works / Core Pillars Grid -->
        <div class="q-mb-xl" data-test="welcome-features">
          <div class="text-h5 text-weight-bold q-mb-md text-center">
            {{ $t('welcome.howItWorks') }}
          </div>

          <div class="row q-col-gutter-md">
            <!-- Pillar 1: Free Speech Is Not Free -->
            <div class="col-12 col-md-6">
              <q-card flat bordered class="feature-card full-height">
                <q-card-section>
                  <div class="row items-center q-mb-sm">
                    <q-avatar
                      color="primary"
                      text-color="white"
                      icon="payments"
                      size="40px"
                      class="q-mr-sm"
                    />
                    <div class="text-h6 text-weight-bold">
                      {{ $t('welcome.pillarFreeSpeechTitle') }}
                    </div>
                  </div>
                  <p class="text-body2 text-grey-8 q-mb-none">
                    {{ $t('welcome.pillarFreeSpeechDesc') }}
                  </p>
                </q-card-section>
              </q-card>
            </div>

            <!-- Pillar 2: Ambient Privacy & DKSAP -->
            <div class="col-12 col-md-6">
              <q-card flat bordered class="feature-card full-height">
                <q-card-section>
                  <div class="row items-center q-mb-sm">
                    <q-avatar
                      color="secondary"
                      text-color="white"
                      icon="security"
                      size="40px"
                      class="q-mr-sm"
                    />
                    <div class="text-h6 text-weight-bold">
                      {{ $t('welcome.pillarPrivacyTitle') }}
                    </div>
                  </div>
                  <p class="text-body2 text-grey-8 q-mb-none">
                    {{ $t('welcome.pillarPrivacyDesc') }}
                  </p>
                </q-card-section>
              </q-card>
            </div>

            <!-- Pillar 3: Zero-PII Sovereign Identity -->
            <div class="col-12 col-md-6">
              <q-card flat bordered class="feature-card full-height">
                <q-card-section>
                  <div class="row items-center q-mb-sm">
                    <q-avatar
                      color="dark"
                      text-color="white"
                      icon="key"
                      size="40px"
                      class="q-mr-sm"
                    />
                    <div class="text-h6 text-weight-bold">
                      {{ $t('welcome.pillarIdentityTitle') }}
                    </div>
                  </div>
                  <p class="text-body2 text-grey-8 q-mb-none">
                    {{ $t('welcome.pillarIdentityDesc') }}
                  </p>
                </q-card-section>
              </q-card>
            </div>

            <!-- Pillar 4: Federated Mailbox Relays -->
            <div class="col-12 col-md-6">
              <q-card flat bordered class="feature-card full-height">
                <q-card-section>
                  <div class="row items-center q-mb-sm">
                    <q-avatar
                      color="accent"
                      text-color="white"
                      icon="hub"
                      size="40px"
                      class="q-mr-sm"
                    />
                    <div class="text-h6 text-weight-bold">
                      {{ $t('welcome.pillarRelayTitle') }}
                    </div>
                  </div>
                  <p class="text-body2 text-grey-8 q-mb-none">
                    {{ $t('welcome.pillarRelayDesc') }}
                  </p>
                </q-card-section>
              </q-card>
            </div>
          </div>
        </div>
      </q-page>
    </q-page-container>
  </div>
</template>

<script lang="ts">
import { computed, defineComponent, getCurrentInstance, ref } from 'vue'
import { useMyDrawerOpen } from '../composables/useMyDrawerOpen'
import {
  FRANK_PWA_EXTENSION_SYNC_CHANNEL,
  isBrowserExtensionRuntime,
  sendRuntimeMessage,
} from '../../src-bex/runtime-adapter'
import {
  clearExtensionSyncOffer,
  offerExtensionSyncBundle,
  pendingExtensionSyncOffer,
  restoreAccountFromExtensionBundle,
} from '../utils/extension-account-sync'
import {
  detectPreferredExtensionTarget,
  EXTENSION_DOWNLOAD_TARGETS,
  type ExtensionTargetBrowser,
  getExtensionDownloadInfo,
} from '../utils/extension-download'

export default defineComponent({
  name: 'WelcomePage',
  emits: ['toggleMyDrawerOpen', 'setupCompleted'],
  setup(_, { emit }) {
    const instance = getCurrentInstance()
    const syncRestoring = ref(false)
    const syncRestoreFailed = ref(false)
    const selectedExtensionTarget = ref<ExtensionTargetBrowser>(
      detectPreferredExtensionTarget(),
    )
    const isExtensionRuntime = computed(() => isBrowserExtensionRuntime())
    const selectedExtensionInfo = computed(() =>
      getExtensionDownloadInfo(selectedExtensionTarget.value),
    )
    const allExtensionTargets = [
      EXTENSION_DOWNLOAD_TARGETS.chrome,
      EXTENSION_DOWNLOAD_TARGETS.firefox,
      EXTENSION_DOWNLOAD_TARGETS.safari,
    ]

    const extensionUi = {
      connectExtensionBtn: 'Connect Browser Extension',
      syncOfferTitle: 'Restore the account sent from your other Frank device',
      syncCheckCodeHint:
        'Continue only if the sending device shows the same code:',
      restoreSyncedAccountBtn: 'Restore this account',
      dismissSyncedAccountBtn: 'Dismiss',
      syncRestoreFailed: 'Could not restore the account. Try syncing again.',
    }

    const syncOffer = pendingExtensionSyncOffer
    const syncOfferText = computed(() => {
      const name = syncOffer.value?.deviceSyncBundle.displayName
      return typeof name === 'string' && name.trim()
        ? `${extensionUi.syncOfferTitle} (${name.trim()})?`
        : `${extensionUi.syncOfferTitle}?`
    })

    const restoreSyncedAccount = async () => {
      const offer = syncOffer.value
      if (!offer || syncRestoring.value) return
      syncRestoring.value = true
      syncRestoreFailed.value = false
      const router = (
        instance?.proxy as
          | { $router?: { push: (path: string) => void } }
          | undefined
      )?.$router
      try {
        const restored = await restoreAccountFromExtensionBundle(
          offer.deviceSyncBundle,
          {
            onActivated: () => {
              emit('setupCompleted')
              if (router) {
                void router.push('/forum')
              }
            },
          },
        )
        syncRestoreFailed.value = !restored
      } finally {
        syncRestoring.value = false
      }
    }

    const dismissSyncOffer = () => {
      syncRestoreFailed.value = false
      clearExtensionSyncOffer()
    }

    return {
      myDrawerOpen: useMyDrawerOpen(),
      extensionUi,
      syncOffer,
      syncOfferText,
      syncRestoring,
      syncRestoreFailed,
      restoreSyncedAccount,
      dismissSyncOffer,
      isExtensionRuntime,
      selectedExtensionTarget,
      selectedExtensionInfo,
      allExtensionTargets,
      selectExtensionTarget(target: ExtensionTargetBrowser) {
        selectedExtensionTarget.value = target
      },
      pageStyle(offset: number, viewportHeight: number) {
        const height = `${Math.max(0, viewportHeight - offset)}px`
        return { height, minHeight: height }
      },
      toggleSettingsDrawerOpen() {
        emit('toggleMyDrawerOpen')
      },
      async connectBrowserExtension() {
        if (isBrowserExtensionRuntime()) {
          // Collect an account the Frank web app handed to the extension.
          try {
            const response = await sendRuntimeMessage<Record<string, any>, any>(
              {
                channel: FRANK_PWA_EXTENSION_SYNC_CHANNEL,
                type: 'get-synced-state',
              },
            )
            offerExtensionSyncBundle(response?.result?.deviceSyncBundle)
          } catch {
            // Ignore extension runtime query errors
          }
        } else if (typeof window !== 'undefined') {
          // Ask the extension's content script for an account it is holding;
          // AppRuntime receives the reply.
          window.postMessage(
            {
              channel: FRANK_PWA_EXTENSION_SYNC_CHANNEL,
              direction: 'to-extension',
              type: 'pwa-request-sync',
              id: `welcome-sync-${Date.now()}`,
            },
            window.location.origin,
          )
        }
      },
    }
  },
})
</script>

<style lang="scss" scoped>
.welcome-container {
  height: 100%;
  min-height: 0;
}
.welcome-page {
  // Keep the document and its desktop drawer anchored while this page scrolls.
  overflow-y: auto;
  overscroll-behavior-y: contain;
  height: 100%;
  min-height: 0 !important;
}
.welcome-page > div {
  max-width: 56rem;
  margin-inline: auto;
}
.welcome-intro-text {
  max-width: 42rem;
  line-height: 1.6;
}
.welcome-actions {
  display: flex;
  flex-wrap: wrap;
  justify-content: center;
  gap: 12px;
  max-width: 100%;
}
.welcome-extension-download {
  max-width: 38rem;
  margin-inline: auto;
  border: 1px dashed rgba(128, 128, 128, 0.35);
}
.welcome-action,
.welcome-docs {
  max-width: 100%;
  font-size: 14px;
  font-weight: 400;
  line-height: 1.4;
  :deep(.q-btn__content) {
    flex-wrap: nowrap;
  }
  :deep(.q-icon) {
    flex-shrink: 0;
    font-size: 20px;
  }
}
.welcome-action {
  min-height: 40px;
  padding: 8px 14px;
}
.welcome-docs {
  min-height: 32px;
}
.feature-card {
  transition: transform 0.15s ease, box-shadow 0.15s ease;
  border-radius: 8px;
  &:hover {
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.08);
  }
}
</style>
