<template>
  <div
    v-if="inline && modelValue"
    class="identity-qr-inline-wrapper full-width"
    data-test="identity-qr-dialog"
  >
    <q-card
      flat
      bordered
      class="q-pa-sm identity-qr-card identity-qr-card--inline"
      data-test="identity-qr-card"
    >
      <q-card-section class="row items-center q-py-xs q-px-sm identity-qr-inline-header">
        <q-avatar
          size="32px"
          class="q-mr-sm shadow-1 cursor-pointer"
          @click="openEditProfile"
        >
          <img v-if="avatarSrc" :src="avatarSrc" />
          <q-icon v-else name="person" size="20px" color="primary" />
        </q-avatar>
        <div class="col ellipsis cursor-pointer" @click="openEditProfile">
          <div
            class="text-subtitle2 text-weight-bold ellipsis"
            data-test="identity-qr-name"
          >
            {{ displayName }}
          </div>
          <div
            v-if="displayUsername"
            class="text-caption"
            data-test="identity-qr-username"
          >
            <username-handle :username="displayUsername" />
          </div>
        </div>
        <q-btn
          outline
          dense
          no-caps
          size="sm"
          color="primary"
          icon="edit"
          :label="$t('SettingPanel.profile')"
          class="q-mr-xs"
          data-test="qr-page-edit-profile-btn"
          @click="openEditProfile"
        />
        <extension-popout-btn />
      </q-card-section>

      <!-- QR Camera Scanner (Collapsed by default in inline/extension mode) -->
      <q-card-section class="q-py-xs q-px-sm">
        <div
          v-if="scannerOpen"
          class="identity-qr-scanner-box rounded-borders overflow-hidden relative-position"
          data-test="identity-qr-scanner"
        >
          <video
            ref="scannerVideo"
            :key="cameraGeneration"
            autoplay
            muted
            playsinline
            class="identity-qr-scanner-video"
            data-test="identity-qr-scanner-video"
          />
          <div
            class="identity-qr-scanner-overlay row items-center justify-between no-wrap q-px-sm q-py-xs"
          >
            <div class="row items-center no-wrap col ellipsis">
              <q-icon
                name="qr_code_scanner"
                size="16px"
                class="q-mr-xs text-white"
              />
              <span
                role="status"
                aria-live="polite"
                class="text-caption text-white ellipsis"
                data-test="identity-qr-scanner-status"
              >
                {{ $t(`qrScanner.${scannerStatus}`) }}
              </span>
            </div>
            <div class="row items-center no-wrap q-gutter-xs">
              <q-btn
                v-if="canRetryScanner"
                flat
                dense
                no-caps
                size="sm"
                color="white"
                :label="$t('qrScanner.retry')"
                data-test="identity-qr-scanner-retry"
                @click="startScanner"
              />
              <q-btn
                flat
                dense
                no-caps
                size="sm"
                color="white"
                icon="close"
                :aria-label="claimUiLabels.stopCameraBtn"
                data-test="stop-qr-camera-btn"
                @click="closeCameraScanner"
              />
            </div>
          </div>
        </div>
        <div
          v-else
          class="row items-center justify-center"
          data-test="identity-qr-scanner"
        >
          <q-btn
            outline
            dense
            no-caps
            color="primary"
            icon="qr_code_scanner"
            class="full-width identity-qr-secondary-btn"
            :label="claimUiLabels.startCameraBtn"
            :aria-label="claimUiLabels.startCameraBtn"
            data-test="start-qr-camera-btn"
            @click="openCameraScanner"
          />
        </div>
      </q-card-section>

      <!-- Own QR Code Below Scanner -->
      <q-card-section class="row justify-center items-center q-py-xs q-px-sm">
        <div
          class="q-pa-sm bg-white rounded-borders shadow-1 text-center identity-qr-frame"
          data-test="identity-qr-container"
        >
          <qrcode-vue
            v-if="resolvedAddress"
            :value="resolvedAddress"
            :size="172"
            level="H"
            data-test="identity-qr-code"
          />
          <q-skeleton v-else size="172px" square />
          <div class="text-caption text-grey-7 q-mt-xs">
            {{ $t('profileDialog.scanPrompt') }}
          </div>
        </div>
      </q-card-section>

      <q-card-section class="q-py-xs q-px-sm">
        <q-input
          dense
          outlined
          readonly
          v-model="resolvedAddress"
          class="identity-address-field"
          data-test="identity-address-input"
        >
          <template #append>
            <q-btn
              flat
              dense
              round
              icon="content_copy"
              color="primary"
              :aria-label="$t('a11y.copyAddress')"
              :disable="!resolvedAddress"
              data-test="copy-identity-address-btn"
              @click="copyAddress"
            />
          </template>
        </q-input>
        <div class="identity-qr-action-grid q-mt-sm">
          <q-btn
            outline
            dense
            no-caps
            size="sm"
            icon="share"
            color="primary"
            class="identity-qr-secondary-btn"
            :label="claimUiLabels.copyInviteLink"
            :aria-label="claimUiLabels.copyInviteLink"
            :disable="!resolvedAddress"
            data-test="copy-invite-link-btn"
            @click="copyInviteLink"
          />
          <q-btn
            outline
            dense
            no-caps
            size="sm"
            icon="card_giftcard"
            color="primary"
            class="identity-qr-secondary-btn"
            :label="claimUiLabels.toggleClaimCreator"
            :aria-label="claimUiLabels.toggleClaimCreator"
            :disable="!resolvedAddress"
            data-test="toggle-claim-link-creator-btn"
            @click="toggleClaimLinkCreator"
          />
        </div>
        <div
          v-if="showClaimLinkCreator"
          class="q-mt-sm q-pa-sm identity-qr-panel"
          data-test="claim-link-creator-panel"
        >
          <q-input
            dense
            outlined
            v-model="claimLinkAmount"
            :label="claimUiLabels.giftAmountLabel"
            class="q-mb-xs"
            data-test="claim-link-amount-input"
          />
          <q-input
            dense
            outlined
            v-model="claimLinkNote"
            :label="claimUiLabels.welcomeNoteLabel"
            class="q-mb-xs"
            data-test="claim-link-note-input"
          />
          <div class="identity-qr-action-grid q-mt-xs">
            <q-btn
              unelevated
              dense
              no-caps
              size="sm"
              color="primary"
              class="identity-qr-primary-btn"
              :label="claimUiLabels.generateClaimLink"
              :disable="!resolvedAddress"
              data-test="generate-claim-link-btn"
              @click="generateFundedClaimLink"
            />
            <q-btn
              v-if="generatedClaimLinkUrl"
              outline
              dense
              no-caps
              size="sm"
              icon="content_copy"
              color="primary"
              class="identity-qr-secondary-btn"
              :label="claimUiLabels.copyClaimLink"
              data-test="copy-claim-link-btn"
              @click="copyGeneratedClaimLink"
            />
          </div>
          <div
            v-if="generatedClaimLinkUrl"
            class="text-caption q-mt-xs ellipsis"
            :data-value="generatedClaimLinkUrl"
            data-test="generated-claim-link-output"
          >
            {{ generatedClaimLinkUrl }}
          </div>
        </div>

        <!-- 1-Click Web App (signet.mx) <-> Browser Extension Account Sync -->
        <div
          v-if="Boolean(runtimeKindOverride)"
          class="q-mt-sm q-pa-sm identity-qr-panel"
          data-test="identity-qr-sync-section"
        >
          <div class="identity-qr-sync-grid">
            <q-btn
              unelevated
              dense
              no-caps
              size="sm"
              color="primary"
              icon="sync"
              class="identity-qr-primary-btn"
              :label="syncBridgeBtnLabel"
              :aria-label="syncBridgeBtnLabel"
              data-test="sync-account-bridge-btn"
              @click="syncAccountOverBridge"
            />
            <q-btn
              outline
              dense
              no-caps
              size="sm"
              color="primary"
              icon="hub"
              class="identity-qr-secondary-btn"
              :label="claimUiLabels.openDappBridgeBtn"
              :aria-label="claimUiLabels.openDappBridgeBtn"
              data-test="open-dapp-bridge-btn"
              @click="openDappBridge"
            />
          </div>
          <div
            v-if="syncPin"
            class="q-mt-xs"
            data-test="identity-qr-sync-pin-block"
          >
            <div class="text-caption">{{ syncPinPrompt }}</div>
            <div
              class="text-h5 text-weight-bold identity-qr-sync-pin"
              data-test="identity-qr-sync-pin"
            >
              {{ syncPin }}
            </div>
            <q-btn
              flat
              dense
              no-caps
              size="sm"
              :label="$t('accountSync.cancel')"
              data-test="identity-qr-sync-cancel"
              @click="cancelAccountSync"
            />
          </div>
          <div
            v-if="syncStatusMessage"
            class="text-caption text-positive text-weight-medium q-mt-xs"
            data-test="identity-qr-sync-status"
          >
            {{ syncStatusMessage }}
          </div>
        </div>

        <q-btn
          v-show="false"
          flat
          dense
          no-caps
          size="sm"
          color="primary"
          :label="$t('profileDialog.goToWallet')"
          data-test="identity-dialog-goto-wallet"
          @click="goToWallet"
        />
      </q-card-section>
    </q-card>
  </div>
  <q-dialog
    v-else-if="!inline"
    :model-value="modelValue"
    data-test="identity-qr-dialog"
    @update:model-value="onModelValueUpdate"
  >
    <q-card
      class="q-pa-sm identity-qr-card"
      data-test="identity-qr-card"
    >
      <q-card-section class="row items-center q-py-xs q-px-sm">
        <q-avatar size="32px" class="q-mr-sm shadow-1">
          <img v-if="avatarSrc" :src="avatarSrc" />
          <q-icon v-else name="person" size="20px" color="primary" />
        </q-avatar>
        <div class="col ellipsis">
          <div
            class="text-subtitle2 text-weight-bold ellipsis"
            data-test="identity-qr-name"
          >
            {{ displayName }}
          </div>
          <div
            v-if="displayUsername"
            class="text-caption"
            data-test="identity-qr-username"
          >
            <username-handle :username="displayUsername" />
          </div>
        </div>
        <q-space />
        <q-btn
          icon="close"
          flat
          round
          dense
          v-close-popup
          :aria-label="$t('close')"
          data-test="identity-qr-close"
          @click="closeDialog"
        />
      </q-card-section>

      <!-- Live QR Camera Scanner at Top -->
      <q-card-section class="q-py-xs q-px-sm">
        <div
          v-if="scannerOpen"
          class="identity-qr-scanner-box rounded-borders overflow-hidden relative-position"
          data-test="identity-qr-scanner"
        >
          <video
            ref="scannerVideo"
            :key="cameraGeneration"
            autoplay
            muted
            playsinline
            class="identity-qr-scanner-video"
            data-test="identity-qr-scanner-video"
          />
          <div
            class="identity-qr-scanner-overlay row items-center justify-between no-wrap q-px-sm q-py-xs"
          >
            <div class="row items-center no-wrap col ellipsis">
              <q-icon
                name="qr_code_scanner"
                size="16px"
                class="q-mr-xs text-white"
              />
              <span
                role="status"
                aria-live="polite"
                class="text-caption text-white ellipsis"
                data-test="identity-qr-scanner-status"
              >
                {{ $t(`qrScanner.${scannerStatus}`) }}
              </span>
            </div>
            <div class="row items-center no-wrap q-gutter-xs">
              <q-btn
                v-if="canRetryScanner"
                flat
                dense
                no-caps
                size="sm"
                color="white"
                :label="$t('qrScanner.retry')"
                data-test="identity-qr-scanner-retry"
                @click="startScanner"
              />
              <q-btn
                flat
                dense
                no-caps
                size="sm"
                color="white"
                icon="close"
                :aria-label="claimUiLabels.stopCameraBtn"
                data-test="stop-qr-camera-btn"
                @click="closeCameraScanner"
              />
            </div>
          </div>
        </div>
        <div
          v-else
          class="row items-center justify-center"
          data-test="identity-qr-scanner"
        >
          <q-btn
            outline
            dense
            no-caps
            color="primary"
            icon="qr_code_scanner"
            class="full-width identity-qr-secondary-btn"
            :label="claimUiLabels.startCameraBtn"
            :aria-label="claimUiLabels.startCameraBtn"
            data-test="start-qr-camera-btn"
            @click="openCameraScanner"
          />
        </div>
      </q-card-section>

      <!-- Own QR Code Below Scanner -->
      <q-card-section class="row justify-center items-center q-py-xs q-px-sm">
        <div
          class="q-pa-sm bg-white rounded-borders shadow-1 text-center identity-qr-frame"
          data-test="identity-qr-container"
        >
          <qrcode-vue
            v-if="resolvedAddress"
            :value="resolvedAddress"
            :size="172"
            level="H"
            data-test="identity-qr-code"
          />
          <q-skeleton v-else size="172px" square />
          <div class="text-caption text-grey-7 q-mt-xs">
            {{ $t('profileDialog.scanPrompt') }}
          </div>
        </div>
      </q-card-section>

      <q-card-section class="q-py-xs q-px-sm">
        <q-input
          dense
          outlined
          readonly
          v-model="resolvedAddress"
          class="identity-address-field"
          data-test="identity-address-input"
        >
          <template #append>
            <q-btn
              flat
              dense
              round
              icon="content_copy"
              color="primary"
              :aria-label="$t('a11y.copyAddress')"
              :disable="!resolvedAddress"
              data-test="copy-identity-address-btn"
              @click="copyAddress"
            />
          </template>
        </q-input>
        <div class="identity-qr-action-grid q-mt-sm">
          <q-btn
            outline
            dense
            no-caps
            size="sm"
            icon="share"
            color="primary"
            class="identity-qr-secondary-btn"
            :label="claimUiLabels.copyInviteLink"
            :aria-label="claimUiLabels.copyInviteLink"
            :disable="!resolvedAddress"
            data-test="copy-invite-link-btn"
            @click="copyInviteLink"
          />
          <q-btn
            outline
            dense
            no-caps
            size="sm"
            icon="card_giftcard"
            color="primary"
            class="identity-qr-secondary-btn"
            :label="claimUiLabels.toggleClaimCreator"
            :aria-label="claimUiLabels.toggleClaimCreator"
            :disable="!resolvedAddress"
            data-test="toggle-claim-link-creator-btn"
            @click="toggleClaimLinkCreator"
          />
        </div>
        <div
          v-if="showClaimLinkCreator"
          class="q-mt-sm q-pa-sm identity-qr-panel"
          data-test="claim-link-creator-panel"
        >
          <q-input
            dense
            outlined
            v-model="claimLinkAmount"
            :label="claimUiLabels.giftAmountLabel"
            class="q-mb-xs"
            data-test="claim-link-amount-input"
          />
          <q-input
            dense
            outlined
            v-model="claimLinkNote"
            :label="claimUiLabels.welcomeNoteLabel"
            class="q-mb-xs"
            data-test="claim-link-note-input"
          />
          <div class="identity-qr-action-grid q-mt-xs">
            <q-btn
              unelevated
              dense
              no-caps
              size="sm"
              color="primary"
              class="identity-qr-primary-btn"
              :label="claimUiLabels.generateClaimLink"
              :disable="!resolvedAddress"
              data-test="generate-claim-link-btn"
              @click="generateFundedClaimLink"
            />
            <q-btn
              v-if="generatedClaimLinkUrl"
              outline
              dense
              no-caps
              size="sm"
              icon="content_copy"
              color="primary"
              class="identity-qr-secondary-btn"
              :label="claimUiLabels.copyClaimLink"
              data-test="copy-claim-link-btn"
              @click="copyGeneratedClaimLink"
            />
          </div>
          <div
            v-if="generatedClaimLinkUrl"
            class="text-caption q-mt-xs ellipsis"
            :data-value="generatedClaimLinkUrl"
            data-test="generated-claim-link-output"
          >
            {{ generatedClaimLinkUrl }}
          </div>
        </div>

        <!-- 1-Click Web App (signet.mx) <-> Browser Extension Account Sync -->
        <div
          v-if="Boolean(runtimeKindOverride)"
          class="q-mt-sm q-pa-sm identity-qr-panel"
          data-test="identity-qr-sync-section"
        >
          <div class="identity-qr-sync-grid">
            <q-btn
              unelevated
              dense
              no-caps
              size="sm"
              color="primary"
              icon="sync"
              class="identity-qr-primary-btn"
              :label="syncBridgeBtnLabel"
              :aria-label="syncBridgeBtnLabel"
              data-test="sync-account-bridge-btn"
              @click="syncAccountOverBridge"
            />
            <q-btn
              outline
              dense
              no-caps
              size="sm"
              color="primary"
              icon="hub"
              class="identity-qr-secondary-btn"
              :label="claimUiLabels.openDappBridgeBtn"
              :aria-label="claimUiLabels.openDappBridgeBtn"
              data-test="open-dapp-bridge-btn"
              @click="openDappBridge"
            />
          </div>
          <div
            v-if="syncPin"
            class="q-mt-xs"
            data-test="identity-qr-sync-pin-block"
          >
            <div class="text-caption">{{ syncPinPrompt }}</div>
            <div
              class="text-h5 text-weight-bold identity-qr-sync-pin"
              data-test="identity-qr-sync-pin"
            >
              {{ syncPin }}
            </div>
            <q-btn
              flat
              dense
              no-caps
              size="sm"
              :label="$t('accountSync.cancel')"
              data-test="identity-qr-sync-cancel"
              @click="cancelAccountSync"
            />
          </div>
          <div
            v-if="syncStatusMessage"
            class="text-caption text-positive text-weight-medium q-mt-xs"
            data-test="identity-qr-sync-status"
          >
            {{ syncStatusMessage }}
          </div>
        </div>

        <q-btn
          v-show="false"
          flat
          dense
          no-caps
          size="sm"
          color="primary"
          :label="$t('profileDialog.goToWallet')"
          data-test="identity-dialog-goto-wallet"
          @click="goToWallet"
        />
      </q-card-section>
    </q-card>
  </q-dialog>
</template>

<script lang="ts">
import {
  computed,
  defineComponent,
  getCurrentInstance,
  nextTick,
  onBeforeUnmount,
  PropType,
  ref,
  watch,
} from 'vue'
import QrcodeVue from 'qrcode.vue'
import { copyToClipboard } from 'quasar'
import type { IScannerControls } from '@zxing/browser'
import { getOwnCanonicalAddress } from 'src/utils/own-address'
import { addressCopiedNotify, errorNotify } from 'src/utils/notifications'
import { ownUsername } from 'src/utils/own-username'
import UsernameHandle from 'src/components/contacts/UsernameHandle.vue'
import { isRawQrAddress } from 'src/components/dialogs/QrScannerDialog.vue'
import { isDevicePairingUri } from '@frank/wallet/device-pairing'
import { createClaimLink } from '../../../../packages/wallet/claim-link'
import {
  getExtensionRuntime,
  isBrowserExtensionRuntime,
  openCompanionPanel,
  openExtensionTab,
  openExtensionWindow,
  FRANK_PWA_EXTENSION_SYNC_CHANNEL,
  FRANK_WEB_APP_ORIGIN,
  isFrankWebAppOrigin,
  onRuntimeMessage,
  RuntimeEnvironmentKind,
  sendRuntimeMessage,
} from '../../../src-bex/runtime-adapter'
import {
  cancelPageSyncSender,
  pageSyncSender,
  startPageSyncSender,
  type SyncSenderView,
} from 'src/utils/extension-account-sync'
import { SYNC_PAIRING_TTL_MS } from 'src/utils/sync-pairing'
import { useTranslate } from 'src/composables/useTranslate'
import { FRANK_DAPP_BRIDGE_CHANNEL } from '../../../src-bex/inpage'

function parseGiftAmountAtomic(raw: string): bigint {
  const trimmed = String(raw ?? '').trim()
  if (!trimmed) return BigInt(0)
  const match = /^(\d+)(?:\.(\d+))?$/.exec(trimmed)
  if (!match) return BigInt(0)
  const fracStr = (match[2] ?? '').slice(0, 18).padEnd(18, '0')
  return BigInt(match[1] + fracStr)
}

function extractScannablePeerTarget(raw: string): string | null {
  const trimmed = raw.trim()
  if (!trimmed || trimmed.length > 512) return null
  if (isDevicePairingUri(trimmed)) return trimmed
  if (trimmed.length > 256) return null
  if (isRawQrAddress(trimmed)) return trimmed
  if (/^@[a-zA-Z0-9_.-]{1,64}$/.test(trimmed)) return trimmed
  return null
}

function detectExtensionProtocol(): boolean {
  if (typeof window === 'undefined' || !window.location) return false
  const proto = String(window.location.protocol || '')
  return (
    proto === 'chrome-extension:' ||
    proto === 'safari-web-extension:' ||
    proto === 'moz-extension:'
  )
}

import ExtensionPopoutBtn from 'src/components/navigation/ExtensionPopoutBtn.vue'

export default defineComponent({
  name: 'IdentityQrDialog',
  components: {
    QrcodeVue,
    UsernameHandle,
    ExtensionPopoutBtn,
  },
  props: {
    modelValue: {
      type: Boolean,
      required: true,
    },
    address: {
      type: String,
      default: '',
    },
    name: {
      type: String,
      default: '',
    },
    avatar: {
      type: String,
      default: '',
    },
    inline: {
      type: Boolean,
      default: false,
    },
    runtimeKindOverride: {
      type: String as PropType<RuntimeEnvironmentKind | ''>,
      default: '',
    },
  },
  emits: ['update:modelValue', 'go-to-wallet', 'scan'],
  setup(props, { emit }) {
    const instance = getCurrentInstance()
    const internalAddress = ref('')
    const internalProfile = ref<{
      name?: string
      avatar?: string
    }>({})

    const showClaimLinkCreator = ref(false)
    const claimLinkAmount = ref('0.05')
    const claimLinkNote = ref('')
    const generatedClaimLinkUrl = ref('')
    const alwaysOpenInSidePanel = ref(false)
    const t = useTranslate()
    const syncError = ref('')
    // The extension's sending session lives in its background; this is what
    // the background last told this page about it.
    const extSyncSender = ref<SyncSenderView | null>(null)
    let extSyncExpiry: ReturnType<typeof setTimeout> | null = null

    const detectedRuntimeKind = computed<RuntimeEnvironmentKind>(() => {
      if (props.runtimeKindOverride) {
        return props.runtimeKindOverride
      }
      return getExtensionRuntime().kind
    })

    const isExtensionMode = computed<boolean>(() => {
      if (props.runtimeKindOverride) {
        return props.runtimeKindOverride !== 'pwa'
      }
      return isBrowserExtensionRuntime() || detectExtensionProtocol()
    })

    const claimUiLabels = {
      copyInviteLink: 'Copy Invite Link',
      toggleClaimCreator: 'Create Funded Claim Link',
      giftAmountLabel: 'Gift Amount',
      welcomeNoteLabel: 'Welcome Note',
      generateClaimLink: 'Generate Claim Link',
      copyClaimLink: 'Copy Claim Link',
      startCameraBtn: 'Scan QR Code with Camera',
      stopCameraBtn: 'Hide Camera',
      extViewLabel: 'View:',
      extSidePanelBtn: 'Side Panel',
      extPopOutBtn: 'Pop Out',
      extFullTabBtn: 'Full Tab',
      openDappBridgeBtn: 'Companion & Bridge',
    }

    const alwaysSidePanelBtnLabel = computed(() =>
      alwaysOpenInSidePanel.value
        ? 'Toolbar: Side Panel'
        : 'Toolbar: Popup',
    )

    const syncBridgeBtnLabel = computed(() =>
      isExtensionMode.value
        ? 'Sync Account to signet.mx Tab'
        : 'Sync Account with Extension',
    )

    // Do not auto-open camera on inline pages or inside the browser extension popup
    const shouldAutoStartScanner = () => !props.inline && !isExtensionMode.value
    const scannerOpen = ref(shouldAutoStartScanner())

    const scannerVideo = ref<HTMLVideoElement>()
    const cameraGeneration = ref(0)
    const scannerStatus = ref('starting')
    const canRetryScanner = ref(false)
    let generation = 0
    let controls: IScannerControls | undefined
    let stream: MediaStream | undefined
    let disposed = false

    const stopScanner = () => {
      ++generation
      controls?.stop()
      controls = undefined
      stream?.getTracks().forEach(track => track.stop())
      stream = undefined
      if (scannerVideo.value) {
        scannerVideo.value.srcObject = null
      }
    }

    const closeDialog = () => {
      stopScanner()
      emit('update:modelValue', false)
    }

    const onModelValueUpdate = (val: boolean) => {
      if (!val) {
        stopScanner()
      }
      emit('update:modelValue', val)
    }

    const startScanner = async () => {
      stopScanner()
      if (
        disposed ||
        !props.modelValue ||
        !scannerOpen.value ||
        typeof document === 'undefined' ||
        document.hidden
      ) {
        return
      }
      ++cameraGeneration.value
      const token = generation
      const current = () =>
        !disposed &&
        props.modelValue &&
        scannerOpen.value &&
        typeof document !== 'undefined' &&
        !document.hidden &&
        generation === token

      scannerStatus.value = 'starting'
      canRetryScanner.value = false

      if (
        typeof window === 'undefined' ||
        !window.isSecureContext ||
        typeof navigator === 'undefined' ||
        !navigator.mediaDevices?.getUserMedia
      ) {
        scannerStatus.value = 'unavailable'
        canRetryScanner.value = true
        return
      }

      try {
        const { BrowserQRCodeReader } = await import('@zxing/browser')
        if (!current()) return
        const acquired = await navigator.mediaDevices.getUserMedia({
          audio: false,
          video: { facingMode: { ideal: 'environment' } },
        })
        if (!current()) {
          acquired.getTracks().forEach(track => track.stop())
          return
        }
        stream = acquired
        await nextTick()
        if (!current() || !scannerVideo.value) {
          acquired.getTracks().forEach(track => track.stop())
          return
        }
        const reader = new BrowserQRCodeReader()
        const started = await reader.decodeFromStream(
          acquired,
          scannerVideo.value,
          result => {
            if (!result || !current()) return
            const target = extractScannablePeerTarget(result.getText())
            if (!target) {
              scannerStatus.value = 'invalid'
              return
            }
            stopScanner()
            emit('scan', target)
            emit('update:modelValue', false)
          },
        )
        if (!current()) {
          started.stop()
          return
        }
        controls = started
        scannerStatus.value = 'scanning'
      } catch (error) {
        if (!current()) return
        stopScanner()
        scannerStatus.value =
          typeof DOMException !== 'undefined' &&
          error instanceof DOMException &&
          error.name === 'NotAllowedError'
            ? 'denied'
            : 'unavailable'
        canRetryScanner.value = true
      }
    }

    const openCameraScanner = async () => {
      scannerOpen.value = true
      await nextTick()
      await startScanner()
    }

    const closeCameraScanner = () => {
      scannerOpen.value = false
      stopScanner()
    }

    watch(
      () => [props.modelValue, props.address],
      async ([isOpen, directAddr]) => {
        if (directAddr && typeof directAddr === 'string') {
          internalAddress.value = directAddr
        }
        if (isOpen) {
          if (!directAddr && !internalAddress.value) {
            try {
              const canonical = await getOwnCanonicalAddress()
              if (canonical) {
                internalAddress.value = canonical
              }
            } catch {
              // ignore
            }
          }
          if (!props.name && !props.avatar) {
            try {
              const { useProfileStore } = await import('src/stores/my-profile')
              const p = useProfileStore()?.profile
              if (p) {
                internalProfile.value = {
                  name: p.name,
                  avatar: p.avatar,
                }
              }
            } catch {
              // ignore
            }
          }
        }
      },
      { immediate: true },
    )

    watch(
      () => props.modelValue,
      open => {
        if (open) {
          if (shouldAutoStartScanner()) {
            scannerOpen.value = true
            void startScanner()
          }
        } else {
          stopScanner()
        }
      },
      { immediate: true, flush: 'post' },
    )

    const onVisibilityChange = () => {
      if (typeof document !== 'undefined' && document.hidden) {
        stopScanner()
      }
    }
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', onVisibilityChange)
    }
    onBeforeUnmount(() => {
      disposed = true
      stopScanner()
      if (typeof document !== 'undefined') {
        document.removeEventListener('visibilitychange', onVisibilityChange)
      }
    })

    const resolvedAddress = computed(
      () => props.address || internalAddress.value,
    )

    const displayName = computed(() => {
      return props.name || internalProfile.value.name || 'You'
    })

    // Only the name the relay confirms this account holds, never the one merely saved.
    const displayUsername = computed(() => ownUsername.held ?? '')

    const avatarSrc = computed(
      () => props.avatar || internalProfile.value.avatar || '',
    )

    const inviteLinkUrl = computed(() => {
      if (!resolvedAddress.value) return ''
      const peer = encodeURIComponent(resolvedAddress.value)
      const peerName = encodeURIComponent(displayName.value || '')
      return peerName
        ? `https://signet.mx/#/onboard?peer=${peer}&peerName=${peerName}`
        : `https://signet.mx/#/onboard?peer=${peer}`
    })

    const toggleClaimLinkCreator = () => {
      showClaimLinkCreator.value = !showClaimLinkCreator.value
    }

    const generateFundedClaimLink = () => {
      if (!resolvedAddress.value) return
      const amountAtomic = parseGiftAmountAtomic(claimLinkAmount.value)
      const trimmedNote = claimLinkNote.value.trim()
      const created = createClaimLink({
        baseUrl: 'https://signet.mx/#/onboard',
        senderAddress: resolvedAddress.value,
        senderName: displayName.value || undefined,
        amountAtomic,
        ...(trimmedNote ? { note: trimmedNote } : {}),
      })
      generatedClaimLinkUrl.value = created.url
    }

    const openInSidePanel = async () => {
      await openCompanionPanel()
    }

    const openInPopoutWindow = async () => {
      await openExtensionWindow()
    }

    const openInFullTab = async () => {
      await openExtensionTab()
    }

    const toggleAlwaysOpenSidePanel = async () => {
      const nextVal = !alwaysOpenInSidePanel.value
      alwaysOpenInSidePanel.value = nextVal
      await sendRuntimeMessage({
        channel: FRANK_DAPP_BRIDGE_CHANNEL,
        type: 'set-sidepanel-behavior',
        openPanelOnActionClick: nextVal,
      })
    }

    const syncSenderView = computed(() =>
      isExtensionMode.value ? extSyncSender.value : pageSyncSender.value,
    )
    const syncPin = computed(() => syncSenderView.value?.pin ?? '')
    const syncPinPrompt = computed(() =>
      syncSenderView.value?.status === 'new-pin'
        ? t('accountSync.newPinAfterMismatch')
        : t('accountSync.showPin'),
    )
    const syncStatusMessage = computed(() => {
      if (syncError.value) return syncError.value
      const status = syncSenderView.value?.status
      return status === 'sent' || status === 'ended' || status === 'expired'
        ? t(`accountSync.${status}`)
        : ''
    })

    const stopSyncSenderUpdates = onRuntimeMessage((message: any) => {
      if (
        message?.channel !== FRANK_PWA_EXTENSION_SYNC_CHANNEL ||
        message.type !== 'sync-sender-update' ||
        !extSyncSender.value
      ) {
        return undefined
      }
      extSyncSender.value = {
        pin: message.status === 'new-pin' ? String(message.pin ?? '') : '',
        status: message.status,
      }
      return undefined
    })
    onBeforeUnmount(() => {
      stopSyncSenderUpdates()
      if (extSyncExpiry) clearTimeout(extSyncExpiry)
    })

    const showExtSyncSender = (
      view: SyncSenderView | null,
      expiresAt?: number,
    ) => {
      extSyncSender.value = view
      if (extSyncExpiry) clearTimeout(extSyncExpiry)
      extSyncExpiry = null
      if (!view) return
      extSyncExpiry = setTimeout(() => {
        const status = extSyncSender.value?.status
        if (status === 'waiting' || status === 'new-pin') {
          extSyncSender.value = { pin: '', status: 'expired' }
        }
      }, Math.max(0, (expiresAt ?? Date.now() + SYNC_PAIRING_TTL_MS) - Date.now()))
    }

    // A popup that closed and reopened still shows the session's current PIN.
    if (isExtensionMode.value) {
      void sendRuntimeMessage<
        Record<string, unknown>,
        {
          result?: {
            ok?: boolean
            pin?: string
            status?: string
            expiresAt?: number
          }
        }
      >({
        channel: FRANK_PWA_EXTENSION_SYNC_CHANNEL,
        type: 'extension-sync-status',
      })
        .then(response => {
          const current = response?.result
          if (!current?.ok || typeof current.pin !== 'string') return
          if (extSyncSender.value) return
          showExtSyncSender(
            {
              pin: current.pin,
              status: current.status === 'new-pin' ? 'new-pin' : 'waiting',
            },
            current.expiresAt,
          )
        })
        .catch(() => undefined)
    }

    /** Ends this side's sending session now and wipes it. */
    const cancelAccountSync = () => {
      syncError.value = ''
      if (isExtensionMode.value) {
        showExtSyncSender(null)
        void sendRuntimeMessage({
          channel: FRANK_PWA_EXTENSION_SYNC_CHANNEL,
          type: 'extension-sync-cancel',
        }).catch(() => undefined)
      } else {
        cancelPageSyncSender()
      }
    }

    // Hands this account to the other Frank surface (extension or web app) by
    // PIN pairing: this side shows a PIN, the user types it in the other
    // window, and the account goes out only to the side that proves the PIN.
    const syncAccountOverBridge = async () => {
      syncError.value = ''
      let backupShares: string[] = []
      try {
        const { accountSession, accountStatus } = await import(
          'src/accounts/session'
        )
        if (accountStatus.status !== 'ready') {
          await accountSession.initialize().catch(() => {})
        }
        if (accountStatus.status === 'ready') {
          const exported = await accountSession.backupCodex32(2, 3)
          backupShares = exported.slice(0, 2)
        }
      } catch {
        // No account custody available
      }
      if (backupShares.length < 2) {
        syncError.value = t('accountSync.noAccount')
        return
      }

      const deviceSyncBundle = {
        version: 1,
        exportedAtMs: Date.now(),
        accountAddress: resolvedAddress.value,
        displayName: displayName.value,
        username: displayUsername.value,
        backupShares,
      }

      if (isExtensionMode.value) {
        // The background holds the session so it outlives a closing popup.
        const response = await sendRuntimeMessage<
          Record<string, unknown>,
          { result?: { ok?: boolean; pin?: string; expiresAt?: number } }
        >({
          channel: FRANK_PWA_EXTENSION_SYNC_CHANNEL,
          type: 'extension-sync-offer',
          payload: { deviceSyncBundle },
        }).catch(() => null)
        const pin = response?.result?.pin
        if (!response?.result?.ok || typeof pin !== 'string') {
          showExtSyncSender(null)
          syncError.value = t('accountSync.failed')
          return
        }
        showExtSyncSender({ pin, status: 'waiting' }, response.result.expiresAt)
      } else if (
        typeof window !== 'undefined' &&
        isFrankWebAppOrigin(window.location.origin)
      ) {
        startPageSyncSender(deviceSyncBundle)
      } else {
        syncError.value = t('accountSync.unsupported', {
          origin: FRANK_WEB_APP_ORIGIN,
        })
      }
    }

    const openDappBridge = () => {
      stopScanner()
      emit('update:modelValue', false)
      const router = (
        instance?.proxy as
          | { $router?: { push: (path: string) => void } }
          | undefined
      )?.$router
      if (router) {
        void router.push('/dapp-bridge')
      }
    }

    const openEditProfile = () => {
      stopScanner()
      if (!props.inline) {
        emit('update:modelValue', false)
      }
      const router = (
        instance?.proxy as
          | { $router?: { push: (path: string) => void } }
          | undefined
      )?.$router
      if (router) {
        void router.push('/profile')
      }
    }

    return {
      resolvedAddress,
      displayName,
      displayUsername,
      avatarSrc,
      inviteLinkUrl,
      showClaimLinkCreator,
      claimLinkAmount,
      claimLinkNote,
      generatedClaimLinkUrl,
      claimUiLabels,
      detectedRuntimeKind,
      isExtensionMode,
      alwaysOpenInSidePanel,
      alwaysSidePanelBtnLabel,
      syncBridgeBtnLabel,
      syncStatusMessage,
      syncPin,
      syncPinPrompt,
      cancelAccountSync,
      toggleClaimLinkCreator,
      generateFundedClaimLink,
      openInSidePanel,
      openInPopoutWindow,
      openInFullTab,
      toggleAlwaysOpenSidePanel,
      syncAccountOverBridge,
      openDappBridge,
      openEditProfile,
      scannerOpen,
      scannerVideo,
      cameraGeneration,
      scannerStatus,
      canRetryScanner,
      startScanner,
      openCameraScanner,
      closeCameraScanner,
      closeDialog,
      onModelValueUpdate,
      async copyAddress() {
        if (!resolvedAddress.value) return
        try {
          await copyToClipboard(resolvedAddress.value)
          addressCopiedNotify()
        } catch (err) {
          errorNotify(err, {
            fallbackKey: 'receiveBitcoinDialog.unableCopyAddress',
          })
        }
      },
      async copyInviteLink() {
        if (!inviteLinkUrl.value) return
        try {
          await copyToClipboard(inviteLinkUrl.value)
          addressCopiedNotify()
        } catch (err) {
          errorNotify(err, {
            fallbackKey: 'receiveBitcoinDialog.unableCopyAddress',
          })
        }
      },
      async copyGeneratedClaimLink() {
        if (!generatedClaimLinkUrl.value) return
        try {
          await copyToClipboard(generatedClaimLinkUrl.value)
          addressCopiedNotify()
        } catch (err) {
          errorNotify(err, {
            fallbackKey: 'receiveBitcoinDialog.unableCopyAddress',
          })
        }
      },
      goToWallet() {
        stopScanner()
        emit('update:modelValue', false)
        emit('go-to-wallet')
        const router = (
          instance?.proxy as
            | { $router?: { push: (path: string) => void } }
            | undefined
        )?.$router
        if (router) {
          void router.push('/wallet')
        }
      },
    }
  },
})
</script>

<style scoped>
.identity-qr-inline-wrapper {
  display: flex;
  justify-content: center;
}

.identity-qr-card {
  width: 100%;
  max-width: 440px;
  margin: 0 auto;
  border-radius: 14px;
}

.identity-qr-card--inline {
  max-width: 500px;
}

.identity-qr-panel {
  border-radius: 10px;
  background: rgba(15, 23, 42, 0.04);
  border: 1px solid rgba(15, 23, 42, 0.08);
}

body.body--dark .identity-qr-panel {
  background: rgba(255, 255, 255, 0.05);
  border-color: rgba(255, 255, 255, 0.1);
}

.identity-qr-view-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 6px;
}

.identity-qr-action-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 8px;
}

.identity-qr-sync-pin {
  font-variant-numeric: tabular-nums;
  letter-spacing: 0.2em;
}
.identity-qr-sync-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(156px, 1fr));
  gap: 8px;
}

.identity-qr-view-btn,
.identity-qr-secondary-btn,
.identity-qr-primary-btn {
  width: 100%;
  min-height: 34px;
  padding: 4px 10px !important;
  border-radius: 8px !important;
  font-size: 12px;
  font-weight: 600;
}

.identity-qr-view-btn,
.identity-qr-secondary-btn {
  background: rgba(234, 88, 12, 0.06);
}

body.body--dark .identity-qr-view-btn,
body.body--dark .identity-qr-secondary-btn {
  background: rgba(234, 88, 12, 0.12);
}

.identity-qr-scanner-box {
  background: #0f172a;
  width: 204px;
  max-width: 100%;
  aspect-ratio: 1 / 1;
  height: auto;
  margin: 0 auto;
  border-radius: 12px;
  overflow: hidden;
  display: flex;
  align-items: center;
  justify-content: center;
}

.identity-qr-frame {
  width: 204px;
  max-width: 100%;
  margin: 0 auto;
  border-radius: 12px;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
}

.identity-qr-scanner-video {
  display: block;
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.identity-qr-scanner-overlay {
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  background: rgba(15, 23, 42, 0.72);
  backdrop-filter: blur(4px);
}

.identity-address-field :deep(input) {
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  font-size: 12px;
  text-overflow: ellipsis;
}
</style>


