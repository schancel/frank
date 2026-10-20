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

          <div
            v-if="extensionSyncStatusText"
            class="text-caption text-positive q-mt-sm"
            data-test="welcome-extension-sync-status"
          >
            {{ extensionSyncStatusText }}
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
import {
  computed,
  defineComponent,
  getCurrentInstance,
  onBeforeUnmount,
  onMounted,
  ref,
} from 'vue'
import { useMyDrawerOpen } from '../composables/useMyDrawerOpen'
import { FRANK_PWA_EXTENSION_SYNC_CHANNEL } from '../../src-bex/content'
import {
  isBrowserExtensionRuntime,
  sendRuntimeMessage,
} from '../../src-bex/runtime-adapter'
import {
  extractValidBackupShares,
  peekPendingExtensionSyncPayload,
  restoreAccountFromExtensionBundle,
  savePendingExtensionSyncPayload,
} from '../utils/extension-account-sync'

export default defineComponent({
  name: 'WelcomePage',
  emits: ['toggleMyDrawerOpen', 'setupCompleted'],
  setup(_, { emit }) {
    const instance = getCurrentInstance()
    const syncedAddress = ref('')
    const syncedSasCode = ref('')

    const extensionUi = {
      connectExtensionBtn: 'Connect Browser Extension',
    }

    const extensionSyncStatusText = computed(() => {
      if (!syncedAddress.value) return ''
      return syncedSasCode.value
        ? `Extension Connected: ${syncedAddress.value} (SAS: ${syncedSasCode.value})`
        : `Extension Connected: ${syncedAddress.value}`
    })

    const applyIncomingSyncPayload = async (
      payload: Record<string, any> | null | undefined,
    ) => {
      const bundle = payload?.deviceSyncBundle
      if (!bundle || typeof bundle !== 'object') return
      syncedAddress.value = String(
        bundle.accountAddress || bundle.activePersonaAddress || '',
      )
      syncedSasCode.value = String(payload?.sasCode || '')
      savePendingExtensionSyncPayload({
        sasCode: syncedSasCode.value,
        deviceSyncBundle: bundle,
      })
      const router = (
        instance?.proxy as
          | { $router?: { push: (path: string) => void } }
          | undefined
      )?.$router
      const shares = extractValidBackupShares(bundle)
      if (shares.length >= 2) {
        const restored = await restoreAccountFromExtensionBundle(bundle, {
          onActivated: () => {
            emit('setupCompleted')
            if (router) {
              void router.push('/forum')
            }
          },
        })
        if (!restored && router) {
          void router.push('/onboard')
        }
      }
    }

    const onExtensionMessage = (event: MessageEvent) => {
      const data = event?.data
      if (!data || typeof data !== 'object') return
      if (
        data.channel === FRANK_PWA_EXTENSION_SYNC_CHANNEL &&
        data.direction === 'to-pwa' &&
        (data.type === 'extension-sync-push' || data.type === 'sync-response')
      ) {
        const payload = data.payload ?? data.result?.syncedState ?? data.result
        void applyIncomingSyncPayload(payload)
      }
    }

    onMounted(() => {
      if (typeof window !== 'undefined') {
        window.addEventListener('message', onExtensionMessage)
      }
      const pending = peekPendingExtensionSyncPayload()
      if (pending?.deviceSyncBundle) {
        void applyIncomingSyncPayload(pending)
      }
    })

    onBeforeUnmount(() => {
      if (typeof window !== 'undefined') {
        window.removeEventListener('message', onExtensionMessage)
      }
    })

    return {
      myDrawerOpen: useMyDrawerOpen(),
      extensionUi,
      extensionSyncStatusText,
      pageStyle(offset: number, viewportHeight: number) {
        const height = `${Math.max(0, viewportHeight - offset)}px`
        return { height, minHeight: height }
      },
      toggleSettingsDrawerOpen() {
        emit('toggleMyDrawerOpen')
      },
      async connectBrowserExtension() {
        if (
          typeof window !== 'undefined' &&
          typeof window.postMessage === 'function'
        ) {
          window.postMessage(
            {
              channel: FRANK_PWA_EXTENSION_SYNC_CHANNEL,
              direction: 'to-extension',
              type: 'pwa-request-sync',
              id: `welcome-sync-${Date.now()}`,
            },
            '*',
          )
        }
        if (isBrowserExtensionRuntime()) {
          try {
            const response = await sendRuntimeMessage<Record<string, any>, any>(
              {
                channel: FRANK_PWA_EXTENSION_SYNC_CHANNEL,
                type: 'get-synced-state',
              },
            )
            const payload =
              response?.result?.syncedState ?? response?.result ?? response
            if (payload?.deviceSyncBundle) {
              await applyIncomingSyncPayload(payload)
            }
          } catch {
            // Ignore extension runtime query errors
          }
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
