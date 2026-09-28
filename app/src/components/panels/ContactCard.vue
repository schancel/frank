<template>
  <q-card
    class="bg-secondary q-pa-sm full-width"
    style="height: 130px"
    flat
    square
  >
    <q-list class="bg-transparent q-pa-none">
      <q-item>
        <q-item-section>
          <q-avatar rounded>
            <img :src="profileAvatar(avatar, address)" />
          </q-avatar>
        </q-item-section>
      </q-item>

      <q-item>
        <q-item-section>
          <q-item-label class="text-weight-bold text-white" lines="1">{{
            name
          }}</q-item-label>
          <q-item-label class="text-white" caption lines="1">{{
            displayAddress
          }}</q-item-label>
        </q-item-section>
        <q-item-section side>
          <q-btn
            flat
            dense
            color="white"
            icon="file_copy"
            size="sm"
            @click="copyAddress()"
          />
        </q-item-section>
      </q-item>
    </q-list>
  </q-card>
</template>

<script lang="ts">
import { defineComponent } from 'vue'
import { copyToClipboard } from 'quasar'

import { addressCopiedNotify } from '../../utils/notifications'
import { activeChain } from '@frank/wallet/chain'
import { profileAvatar } from 'src/utils/avatar'

export default defineComponent({
  setup() {
    return { profileAvatar }
  },
  props: {
    name: {
      type: String,
      default: () => '',
    },
    address: {
      type: String,
      default: () => '',
    },
    bio: {
      type: String,
      default: () => '',
    },
    avatar: {
      type: String,
      default: () => '',
    },
  },
  methods: {
    copyAddress() {
      copyToClipboard(this.displayAddress)
        .then(() => {
          addressCopiedNotify()
        })
        .catch(() => {
          // fail
        })
    },
  },
  computed: {
    displayAddress(): string {
      // Was hardcoded to Lotus's bitcore `Address`/`Networks` (crashed on any Monad `0x...`
      // address with "Invalid Argument: Mixed case" -- EIP-55 checksums are deliberately mixed
      // case, which bitcore's base58 address parser rejects outright). Found live tonight
      // (autonomous overnight session, 2026-09-27) by actually driving a browser to a real chat
      // route -- missed by ticket #44's earlier audit since this file imported `Address`/
      // `Networks` directly rather than through `utils/address.ts`'s named helpers.
      const parsed = activeChain.parseAddress(this.address)
      return parsed ? activeChain.formatAddress(parsed) : this.address
    },
  },
})
</script>
