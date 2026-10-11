<template>
  <span class="address-text">
    <span
      ref="container"
      class="address-value"
      :title="address"
      :aria-label="address"
    >
      <span ref="measure" class="address-measure" aria-hidden="true">{{
        address
      }}</span>
      <span data-test="address-text">{{ displayed }}</span>
      <q-tooltip>{{ address }}</q-tooltip>
    </span>
    <q-btn
      v-if="copyable"
      flat
      dense
      round
      size="sm"
      icon="content_copy"
      :aria-label="$t('a11y.copyAddress')"
      data-test="address-copy"
      @click.stop="copyAddress"
    />
  </span>
</template>

<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { copyToClipboard } from 'quasar'
import { addressCopiedNotify, errorNotify } from '../utils/notifications'

const props = withDefaults(
  defineProps<{ address: string; copyable?: boolean }>(),
  { copyable: false },
)
const container = ref<HTMLElement>()
const measure = ref<HTMLElement>()
const displayed = ref(props.address)
let observer: ResizeObserver | undefined
let active = true

function fitAddress() {
  const box = container.value
  const probe = measure.value
  if (!box || !probe || box.clientWidth <= 0) return
  const address = props.address
  probe.textContent = address
  if (probe.getBoundingClientRect().width <= box.clientWidth) {
    displayed.value = address
    return
  }
  // Both ends identify an address. Measure with the actual font and available width instead
  // of assuming a character count or hiding the suffix with CSS end ellipsis.
  let low = 2
  let high = Math.max(2, address.length - 1)
  let fitted = `${address.slice(0, 1)}…${address.slice(-1)}`
  while (low <= high) {
    const count = Math.floor((low + high) / 2)
    const candidate = `${address.slice(
      0,
      Math.ceil(count / 2),
    )}…${address.slice(-Math.floor(count / 2))}`
    probe.textContent = candidate
    if (probe.getBoundingClientRect().width <= box.clientWidth) {
      fitted = candidate
      low = count + 1
    } else high = count - 1
  }
  probe.textContent = address
  displayed.value = fitted
}
watch(
  () => props.address,
  async address => {
    displayed.value = address
    await nextTick()
    if (active) fitAddress()
  },
)
onMounted(() => {
  fitAddress()
  if (typeof ResizeObserver !== 'undefined') {
    observer = new ResizeObserver(fitAddress)
    if (container.value) observer.observe(container.value)
    if (measure.value) observer.observe(measure.value)
  }
})
onBeforeUnmount(() => {
  active = false
  observer?.disconnect()
})
async function copyAddress() {
  try {
    await copyToClipboard(props.address)
    addressCopiedNotify()
  } catch (error) {
    errorNotify(error, { fallbackKey: 'walletPanel.unableCopyAddress' })
  }
}
</script>

<style scoped>
.address-text {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  width: 100%;
  max-width: 100%;
  min-width: 0;
  vertical-align: middle;
}
.address-value {
  flex: 1 1 auto;
  min-width: 0;
  position: relative;
  overflow: hidden;
  white-space: nowrap;
}
.address-measure {
  position: absolute;
  visibility: hidden;
  pointer-events: none;
  white-space: pre;
}
</style>
