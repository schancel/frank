<template>
  <q-card class="contact-book-card q-px-sm dialog-medium">
    <q-card-section class="row items-center q-pb-none">
      <div class="text-h6">{{ $t('contactBookDialog.contacts') }}</div>
      <q-space />
    </q-card-section>

    <q-card-section class="q-pb-none">
      <q-input
        class="text-bold text-h6"
        v-model="search"
        filled
        dense
        autofocus
        :placeholder="$t('contactBookDialog.search')"
      />
    </q-card-section>
    <q-card-section class="contact-book-list q-pb-none">
      <contact-list
        :contacts="searchContacts(search)"
        :contact-click="contactClick"
      />
    </q-card-section>
    <q-card-actions align="right" class="contact-book-actions">
      <q-btn flat :label="$t('close')" color="primary" v-close-popup />
    </q-card-actions>
  </q-card>
</template>

<script lang="ts">
import { defineComponent } from 'vue'
import { storeToRefs } from 'pinia'

import ContactList from '../contacts/ContactList.vue'
import { ContactState, useContactStore } from 'src/stores/contacts'

export default defineComponent({
  props: {
    contactClick: {
      type: Function,
      required: true,
    },
  },
  setup() {
    const contactStore = useContactStore()
    const { getContacts } = storeToRefs(contactStore)
    return {
      contacts: getContacts,
    }
  },
  components: {
    ContactList,
  },
  methods: {
    searchContacts(searchPrefix: string) {
      const contacts = this.contacts
      if (!contacts) {
        return
      }
      const sortedContacts = Object.entries(contacts).sort((e1, e2) => {
        return Number(e1[0]) - Number(e2[0])
      })

      const result = {} as Record<string, ContactState>
      for (const [address, contact] of sortedContacts) {
        const lowerSearch = searchPrefix.toLowerCase()
        if (!contact) {
          continue
        }
        if (
          contact?.profile.name?.toLowerCase().includes(lowerSearch) ||
          address.toLowerCase().includes(lowerSearch)
        ) {
          result[address] = contact
        }
      }

      return result
    },
  },
  data() {
    return {
      search: '',
    }
  },
})
</script>

<style scoped>
.contact-book-card {
  display: flex;
  flex-direction: column;
  max-height: calc(100dvh - 48px);
  width: min(560px, calc(100vw - 32px));
  overflow: hidden;
}
.contact-book-list {
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
}
.contact-book-actions {
  flex: 0 0 auto;
}
/* Keep this density local to the picker; full contact panels keep their layout. */
.contact-book-list :deep(.q-list) {
  padding-block: 0;
}
.contact-book-list :deep(.q-item) {
  padding: 10px 4px;
}
.contact-book-list :deep(.q-item__section--avatar) {
  min-width: 48px;
  padding-right: 12px;
}
.contact-book-list :deep(.q-avatar) {
  font-size: 36px !important;
}
.contact-book-list :deep(.q-item__section--side:last-child) {
  padding-left: 8px;
}
</style>
