<template>
  <div class="column full-height">
    <!-- TODO: Renable these features at a later data. They don't work correctly, but were only for demo purposes. -->

    <!-- Clear history dialog -->
    <!-- <q-dialog v-model="confirmClearOpen">
      <clear-history-dialog
        :address="address"
        :name="contact.profile.name"
      />
    </q-dialog>-->

    <!-- Delete chat dialog -->
    <!-- <q-dialog v-model="confirmDeleteOpen">
      <delete-chat-dialog
        :address="address"
        :name="contact.profile.name"
      />
    </q-dialog>
    -->

    <!-- Contact card -->
    <contact-card
      :address="address"
      :name="contact.profile.name"
      :avatar="contact.profile.avatar"
      :acceptance-price="contact.inbox.acceptancePrice"
    />

    <!-- Scroll area -->
    <q-scroll-area class="col">
      <q-list padding>
        <q-item
          clickable
          v-ripple
          @click="() => (notifications = !notifications)"
        >
          <q-item-section avatar>
            <q-icon name="notifications_none" />
          </q-item-section>
          <q-item-section>
            {{ $t('chatRightDrawer.notifications') }}
          </q-item-section>
          <q-item-section side>
            <q-toggle v-model="notifications" />
          </q-item-section>
        </q-item>
      </q-list>
    </q-scroll-area>
  </div>
</template>

<script lang="ts">
import { defineComponent } from 'vue'

import ContactCard from './ContactCard.vue'
import { useContactStore } from 'src/stores/contacts'

export default defineComponent({
  setup() {
    const contactStore = useContactStore()

    return {
      setNotify: contactStore.setNotify,
      getNotify: contactStore.getNotify,
    }
  },
  components: {
    ContactCard,
  },
  props: {
    address: {
      type: String,
      default: () => '',
    },
    contact: {
      type: Object,
      default: () => ({
        profile: { name: 'Unknown', avatar: '' },
      }),
    },
  },
  computed: {
    notifications: {
      get(): boolean {
        return this.getNotify(this.address) ?? false
      },
      set(value: string) {
        this.setNotify({ address: this.address, value: Boolean(value) })
      },
    },
  },
  data: function () {
    return {
      confirmClearOpen: false,
      confirmDeleteOpen: false,
    }
  },
})
</script>
