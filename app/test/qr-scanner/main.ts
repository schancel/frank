// Browser proof uses the same qrcode.vue writer as IdentityQrDialog/Receive/Wallet.
import { createApp, defineComponent, nextTick, ref } from 'vue'
import {
  Quasar,
  QDialog,
  QCard,
  QCardSection,
  QCardActions,
  QBtn,
  QSpace,
} from 'quasar'
import 'quasar/dist/quasar.css'
import QrcodeVue from 'qrcode.vue'
import QrScannerDialog from '../../src/components/dialogs/QrScannerDialog.vue'
const App = defineComponent({
  components: { QrcodeVue, QrScannerDialog },
  setup() {
    const open = ref(false),
      payload = ref(''),
      scanned = ref(''),
      session = ref(1)
    let lastStream: MediaStream | undefined
    Object.defineProperty(window, 'BarcodeDetector', {
      value: undefined,
      configurable: true,
    })
    Object.defineProperty(navigator.mediaDevices, 'getUserMedia', {
      value: async () => {
        await nextTick()
        const source = document.querySelector('canvas')!
        const frames = document.createElement('canvas')
        frames.width = source.width
        frames.height = source.height
        const paint = () => frames.getContext('2d')!.drawImage(source, 0, 0)
        paint()
        lastStream = frames.captureStream(15)
        const active = lastStream
        const timer = setInterval(() => {
          if (active.getTracks().every(t => t.readyState === 'ended'))
            clearInterval(timer)
          else paint()
        }, 60)
        return lastStream
      },
    })
    Object.assign(window, {
      qrFixture: {
        async scan(value: string) {
          payload.value = value
          scanned.value = ''
          await nextTick()
          open.value = true
        },
        stopped: () =>
          lastStream?.getTracks().every(t => t.readyState === 'ended'),
      },
    })
    return {
      open,
      payload,
      scanned,
      context: () => String(session.value),
      validate: () => true,
    }
  },
  template: `<qrcode-vue :value="payload || 'initial'" :size="360" :margin="4" level="H" />
    <output id="scanned">{{ scanned }}</output>
    <qr-scanner-dialog v-model="open" network-name="Fixture network" :context="context" :validate-address="validate" @scan="scanned = $event" />`,
})
const app = createApp(App)
app.config.globalProperties.$t = (key: string) => key
app.use(Quasar, {
  components: { QDialog, QCard, QCardSection, QCardActions, QBtn, QSpace },
})
app.mount('#app')
