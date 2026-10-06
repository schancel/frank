<template>
  <q-card class="q-px-sm q-pb-md dialog-medium">
    <q-card-section class="row items-center q-pb-none">
      <div class="text-h6">{{ $t('chatMessage.forwardMessage') }}</div>
      <q-space />
      <q-btn flat round icon="close" color="primary" v-close-popup />
    </q-card-section>

    <!-- Message preview -->
    <q-card-section class="q-py-xs" v-if="previewText">
      <div
        class="q-pa-sm bg-grey-2 text-caption text-grey-9 rounded-borders ellipsis-2-lines"
        style="border-left: 3px solid var(--q-primary)"
      >
        {{ previewText }}
      </div>
    </q-card-section>

    <q-card-section class="q-pb-none">
      <q-input
        class="text-bold text-h6"
        v-model="search"
        filled
        dense
        :placeholder="$t('contactBookDialog.search')"
        ref="contactSearch"
      />
    </q-card-section>

    <q-card-section
      class="q-pb-none"
      style="max-height: 350px; overflow-y: auto"
    >
      <q-list separator>
        <q-item
          v-for="(contact, addr) in filteredContacts"
          :key="addr"
          clickable
          v-close-popup
          @click="handleContactClick(addr)"
        >
          <q-item-section avatar>
            <q-avatar
              color="primary"
              text-color="white"
              icon="person"
              size="42px"
            />
          </q-item-section>
          <q-item-section>
            <q-item-label class="text-weight-medium">
              {{ contact.profile?.name || addr }}
            </q-item-label>
            <q-item-label caption lines="1" class="text-grey-7">
              {{ addr }}
            </q-item-label>
          </q-item-section>
        </q-item>
        <div
          v-if="Object.keys(filteredContacts).length === 0"
          class="text-center q-pa-md text-grey"
        >
          {{ $t('contactItem.notFound') }}
        </div>
      </q-list>
    </q-card-section>

    <q-card-actions align="right">
      <q-btn flat :label="$t('close')" color="primary" v-close-popup />
    </q-card-actions>
  </q-card>
</template>

<script lang="ts">
import { defineComponent, type PropType } from 'vue'
import { ContactState, useContactStore } from 'src/stores/contacts'
import type { Message } from '@frank/cashweb/types/messages'

export default defineComponent({
  name: 'ForwardMessageDialog',
  props: {
    message: {
      type: Object as PropType<Message>,
      required: true,
    },
  },
  emits: ['forward'],
  setup() {
    const contactStore = useContactStore()
    return {
      contactStore,
    }
  },
  data() {
    return {
      search: '',
    }
  },
  computed: {
    contacts(): Record<string, ContactState> {
      return this.contactStore.getContacts || {}
    },
    previewText(): string {
      const textItem = this.message?.items?.find(it => it.type === 'text')
      if (textItem && 'text' in textItem) {
        return textItem.text
      }
      const imageItem = this.message?.items?.find(it => it.type === 'image')
      if (imageItem) {
        return 'Image'
      }
      return ''
    },
    filteredContacts(): Record<string, ContactState> {
      const contacts = this.contacts
      if (!contacts) {
        return {}
      }
      const result: Record<string, ContactState> = {}
      const lower = this.search.toLowerCase()
      for (const [address, contact] of Object.entries(contacts)) {
        if (!contact) continue
        if (
          contact.profile?.name?.toLowerCase().includes(lower) ||
          address.toLowerCase().includes(lower)
        ) {
          result[address] = contact
        }
      }
      return result
    },
  },
  methods: {
    handleContactClick(address: string) {
      this.$emit('forward', address)
    },
  },
  mounted() {
    ;(this.$refs.contactSearch as { focus?: () => void } | undefined)?.focus?.()
  },
})
</script>
