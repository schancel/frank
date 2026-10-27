<template>
  <q-dialog :model-value="modelValue" @update:model-value="close">
    <q-card class="qr-scanner-card">
      <q-card-section class="row items-center">
        <div class="text-h6">{{ $t('qrScanner.title') }}</div>
        <q-space />
        <q-btn
          flat
          round
          icon="close"
          :aria-label="$t('close')"
          @click="close"
        />
      </q-card-section>
      <q-card-section class="q-pt-none">
        <p>{{ $t('qrScanner.network', { network: networkName }) }}</p>
        <p>{{ $t('qrScanner.addressOnly') }}</p>
        <video
          ref="video"
          :key="cameraGeneration"
          autoplay
          muted
          playsinline
          class="qr-scanner-video"
        />
        <p role="status" aria-live="polite">{{ $t(`qrScanner.${status}`) }}</p>
      </q-card-section>
      <q-card-actions align="right">
        <q-btn
          v-if="canRetry"
          flat
          :label="$t('qrScanner.retry')"
          @click="start"
        />
        <q-btn flat :label="$t('qrScanner.manual')" @click="close" />
      </q-card-actions>
    </q-card>
  </q-dialog>
</template>

<script lang="ts">
import {
  defineComponent,
  nextTick,
  onBeforeUnmount,
  ref,
  watch,
  watchEffect,
} from 'vue'
import type { PropType } from 'vue'
import type { IScannerControls } from '@zxing/browser'

// Only raw addresses are accepted. Cashaddr's protocol address prefix is part of the
// address; payment URIs, parameters, URLs, structured data and scripts are not.
export function isRawQrAddress(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= 256 &&
    /^(?:(?:ecash|ectest|bitcoincash|bchtest|bchreg):)?[a-zA-Z0-9]+$/.test(
      value,
    )
  )
}

export default defineComponent({
  name: 'QrScannerDialog',
  props: {
    modelValue: { type: Boolean, required: true },
    networkName: { type: String, required: true },
    // Read-only session/network identity. Undefined means this task is no longer active.
    context: {
      type: Function as PropType<() => string | undefined>,
      required: true,
    },
    validateAddress: {
      type: Function as PropType<(value: string) => boolean>,
      required: true,
    },
  },
  emits: ['update:modelValue', 'scan'],
  setup(props, { emit }) {
    const video = ref<HTMLVideoElement>()
    const cameraGeneration = ref(0)
    const status = ref('starting')
    const canRetry = ref(false)
    let generation = 0
    let controls: IScannerControls | undefined
    let stream: MediaStream | undefined
    let capturedContext: string | undefined
    let disposed = false
    const stop = () => {
      ++generation
      capturedContext = undefined
      controls?.stop()
      controls = undefined
      stream?.getTracks().forEach(track => track.stop())
      stream = undefined
      if (video.value) video.value.srcObject = null
    }
    const close = () => {
      stop()
      emit('update:modelValue', false)
    }
    const start = async () => {
      stop()
      if (disposed || !props.modelValue || document.hidden) return
      capturedContext = props.context()
      if (!capturedContext) {
        close()
        return
      }
      ++cameraGeneration.value
      const token = generation
      const current = () =>
        !disposed &&
        props.modelValue &&
        !document.hidden &&
        generation === token &&
        props.context() === capturedContext
      status.value = 'starting'
      canRetry.value = false
      if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
        status.value = 'unavailable'
        canRetry.value = true
        return
      }
      try {
        // Bundle the JavaScript QR decoder locally; do not depend on BarcodeDetector.
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
        if (!current() || !video.value) {
          acquired.getTracks().forEach(track => track.stop())
          return
        }
        const reader = new BrowserQRCodeReader()
        const started = await reader.decodeFromStream(
          acquired,
          video.value,
          result => {
            if (!result || !current()) return
            const value = result.getText()
            let valid = false
            try {
              valid = isRawQrAddress(value) && props.validateAddress(value)
            } catch {
              /* invalid address */
            }
            if (!valid) {
              status.value = 'invalid'
              return
            }
            // Invalidate before publishing so duplicate frames cannot fill the task twice.
            stop()
            emit('scan', value)
            emit('update:modelValue', false)
          },
        )
        if (!current()) {
          started.stop()
          return
        }
        controls = started
        status.value = 'scanning'
      } catch (error) {
        if (!current()) return
        stop()
        status.value =
          error instanceof DOMException && error.name === 'NotAllowedError'
            ? 'denied'
            : 'unavailable'
        canRetry.value = true
      }
    }
    watch(
      () => props.modelValue,
      open => {
        if (open) void start()
        else stop()
      },
      { flush: 'post' },
    )
    watchEffect(() => {
      if (!props.modelValue) return
      const context = props.context()
      if (capturedContext && context !== capturedContext) close()
    })
    const hidden = () => {
      if (document.hidden && props.modelValue) close()
    }
    document.addEventListener('visibilitychange', hidden)
    onBeforeUnmount(() => {
      disposed = true
      stop()
      document.removeEventListener('visibilitychange', hidden)
    })
    return { video, cameraGeneration, status, canRetry, close, start }
  },
})
</script>

<style scoped>
.qr-scanner-card {
  width: 420px;
  max-width: calc(100vw - 32px);
}
.qr-scanner-video {
  display: block;
  width: 100%;
  max-height: 50vh;
  object-fit: contain;
}
</style>
