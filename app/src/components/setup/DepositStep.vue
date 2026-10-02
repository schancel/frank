<template>
  <div class="col q-gutter-y-md">
    <q-resize-observer @resize="setQRSize" />
    <div class="p-mx-none text-">
      <qrcode-vue
        class="center"
        :value="displayAddress"
        level="H"
        :size="150"
      />
    </div>
    <q-input class="fit" filled auto-grow v-model="displayAddress" readonly>
      <template #after>
        <q-btn
          dense
          color="primary"
          flat
          icon="swap_vert"
          :aria-label="$t('a11y.switchAddressFormat')"
          @click="toggleLegacy"
        />
        <q-btn
          dense
          color="primary"
          flat
          icon="content_copy"
          :aria-label="$t('a11y.copyAddress')"
          @click="copyAddress"
        />
      </template>
    </q-input>

    <q-linear-progress
      show-value
      stripe
      rounded
      size="20px"
      :value="percentageBalance"
      color="warning"
      class="q-mt-sm"
    />
    <span class="row q-mx-sm q-px-none"
      >Current: {{ formatBalance }}, Need: {{ formatRecommended }}</span
    >
  </div>
</template>

<script lang="ts">
import { defineComponent, computed } from 'vue'
import QrcodeVue from 'qrcode.vue'
import { copyToClipboard } from 'quasar'

import { recomendedBalance } from '../../utils/constants'
import { addressCopiedNotify } from '../../utils/notifications'
import { formatBalance } from '../../utils/formatting'
// Deliberately left on the old Lotus `toAPIAddress`/`toDisplayAddress` pair (ticket #44): this
// whole component -- and the `Setup.vue` onboarding wizard it's part of -- generates a Lotus
// `HDPrivateKey`/mnemonic and registers via the old `RegistryHandler`, never touching
// `activeChain`/`useActiveWallet`/`monad-identity.ts` at all. `this.$wallet.myAddress` here is a
// real bitcore-lib-xpi `Address`, not a Monad `0x...` string, so these calls are correct for what
// this component actually does today -- swapping them for `activeChain.formatAddress` would be
// papering over the real gap, not fixing it. The "legacy address" toggle button below
// (`toggleLegacy`) also has no Monad equivalent: there's exactly one canonical address encoding on
// an EVM chain (see `active-chain.ts`'s `ChainAddress` doc comment). Whether/how a Monad-native
// onboarding wizard needs a "deposit" concept at all is a real product question, not a find-and-
// replace -- filed as issue #47 per this ticket's own instructions rather than guessed at here.
import { toAPIAddress, toDisplayAddress } from '../../utils/address'
import { useWalletStore } from 'src/stores/wallet'

export default defineComponent({
  components: {
    QrcodeVue,
  },
  setup() {
    const walletStore = useWalletStore()

    return {
      balance: computed(() => walletStore.balance),
    }
  },
  data() {
    return {
      paymentAddrCounter: 0,
      qrSize: 300,
      legacy: false as boolean,
    }
  },
  methods: {
    toggleLegacy() {
      this.legacy = !this.legacy
    },
    copyAddress() {
      copyToClipboard(this.displayAddress)
        .then(() => {
          addressCopiedNotify()
        })
        .catch(() => {
          // fail
        })
    },
    setQRSize(size: { height: number; width: number }) {
      this.qrSize = size.height
    },
  },
  computed: {
    displayAddress(): string {
      if (!this.$wallet.myAddress) {
        return 'Error'
      }
      return this.legacy
        ? toAPIAddress(this.$wallet.myAddress)
        : toDisplayAddress(this.$wallet.myAddress)
    },
    percentageBalance(): number {
      const percentage = this.balance / recomendedBalance
      return percentage
    },
    formatRecommended(): string {
      return formatBalance(recomendedBalance)
    },
    formatBalance(): string {
      return formatBalance(this.balance)
    },
  },
})
</script>
