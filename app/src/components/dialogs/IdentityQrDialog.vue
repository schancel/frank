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
          :aria-label="$t('close')"
          data-test="identity-qr-close"
          @click="closeDialog"
        />
      </q-card-section>

      <!-- Live QR Camera Scanner at Top -->
      <q-card-section class="q-py-xs q-px-sm">
        <div
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
          </div>
        </div>
      </q-card-section>

      <!-- Own QR Code Below Scanner -->
      <q-card-section class="row justify-center items-center q-py-xs q-px-sm">
        <div
          class="q-pa-sm bg-white rounded-borders shadow-1 text-center"
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
          </div>
        </div>
      </q-card-section>

      <!-- Own QR Code Below Scanner -->
      <q-card-section class="row justify-center items-center q-py-xs q-px-sm">
        <div
          class="q-pa-sm bg-white rounded-borders shadow-1 text-center"
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

function extractScannablePeerTarget(raw: string): string | null {
  const trimmed = raw.trim()
  if (!trimmed || trimmed.length > 256) return null
  if (isRawQrAddress(trimmed)) return trimmed
  if (/^@[a-zA-Z0-9_.-]{1,64}$/.test(trimmed)) return trimmed
  return null
}

export default defineComponent({
  name: 'IdentityQrDialog',
  components: {
    QrcodeVue,
    UsernameHandle,
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
  },
  emits: ['update:modelValue', 'go-to-wallet', 'scan'],
  setup(props, { emit }) {
    const instance = getCurrentInstance()
    const internalAddress = ref('')
    const internalProfile = ref<{
      name?: string
      avatar?: string
    }>({})

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
          void startScanner()
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

    return {
      resolvedAddress,
      displayName,
      displayUsername,
      avatarSrc,
      scannerVideo,
      cameraGeneration,
      scannerStatus,
      canRetryScanner,
      startScanner,
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

.identity-qr-scanner-box {
  background: #0f172a;
  height: clamp(168px, 28vh, 224px);
  display: flex;
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
