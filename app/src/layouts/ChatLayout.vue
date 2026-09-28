<template>
  <div>
    <q-drawer v-model="contactDrawerOpen" side="right" :breakpoint="800">
      <right-drawer
        v-if="address"
        :address="address"
        :contact="getContact(address)"
      />
    </q-drawer>

    <!-- Send file dialog -->
    <!-- TODO: Move this up.  We don't need a copy of this dialog for each address (likely) -->
    <q-dialog v-model="sendFileOpen">
      <send-file-dialog :address="address" :file="image" />
    </q-dialog>

    <q-header>
      <q-toolbar class="q-pl-sm">
        <q-btn
          class="q-px-sm"
          flat
          dense
          @click="() => $emit('toggleMyDrawerOpen')"
          icon="menu"
        />
        <q-avatar rounded :style="contactColorStyle">
          <img :src="profileAvatar(contactProfile?.avatar, address)" />
        </q-avatar>
        <q-toolbar-title class="h6">{{ contactProfile.name }}</q-toolbar-title>
        <q-space />
        <q-btn
          class="q-px-sm"
          flat
          dense
          @click="contactDrawerOpen = !contactDrawerOpen"
          icon="manage_accounts"
        />
      </q-toolbar>
    </q-header>

    <router-view @sendFileClicked="toSendFileDialog" />
  </div>
</template>

<script lang="ts">
import { defineComponent } from 'vue'
import { RouteLocationNormalized } from 'vue-router'

import RightDrawer from '../components/panels/ChatRightDrawer.vue'
import SendFileDialog from '../components/dialogs/SendFileDialog.vue'
import { useContactStore } from 'src/stores/contacts'
import { pubKeyToColor } from 'src/utils/formatting'
import { profileAvatar } from 'src/utils/avatar'

export default defineComponent({
  emits: ['toggleMyDrawerOpen'],
  components: {
    RightDrawer,
    SendFileDialog,
  },
  setup() {
    const contactStore = useContactStore()

    return {
      getContact: contactStore.getContact,
      profileAvatar,
    }
  },
  data() {
    return {
      sendFileOpen: false as boolean,
      address: this.$route.params.address as string,
      contactDrawerOpen: false,
      image: null as unknown | null,
    }
  },
  beforeRouteUpdate(
    to: RouteLocationNormalized,
    from: RouteLocationNormalized,
    next: () => void,
  ) {
    this.address = to.params.address as string
    next()
  },
  methods: {
    toSendFileDialog(args: unknown) {
      this.image = args
      this.sendFileOpen = true
    },
  },
  computed: {
    contactProfile() {
      return this.getContact(this.address)?.profile
    },
    // Ticket #50: a spoofing/impersonation cue -- a colored ring around the contact's avatar,
    // derived from their public key. Same name/avatar with a suddenly-different ring color is
    // the tell that the underlying key changed (a genuine key rotation, #46, or someone spoofing
    // this contact's identity). No ring at all just means no pubkey is known yet for this
    // contact (e.g. a pending/unconfirmed add) -- not itself suspicious.
    contactColorStyle() {
      const pubKey = this.contactProfile?.pubKey
      if (!pubKey) {
        return {}
      }
      return { boxShadow: `0 0 0 3px ${pubKeyToColor(pubKey.toBuffer())}` }
    },
  },
})
</script>

<style lang="scss" scoped>
.reply {
  padding: 5px 0;
  color: var(--q-color-text);
  background: var(--q-color-background);
  padding-left: 8px;
  border-left: 3px;
  border-left-style: solid;
  border-left-color: $primary;
}

.scroll-area-bordered {
  border-right: 1px;
  border-right-style: solid;
  border-right-color: $separator-color;
  border-bottom: 1px;
  border-bottom-style: solid;
  border-bottom-color: $separator-color;
}
</style>
