<template>
  <div
    class="full-width column col"
    data-testid="contacts-panel"
    data-test="contacts-panel"
  >
    <q-scroll-area
      class="q-px-none col full-width contacts-scroll-area"
      :content-style="{ width: '100%', minWidth: '100%' }"
      :content-active-style="{ width: '100%', minWidth: '100%' }"
    >
      <q-list class="full-width">
        <q-separator />
        <q-item class="full-width">
          <q-item-section>
            <q-item-label>{{ $t('contactBookDialog.contacts') }}</q-item-label>
          </q-item-section>
          <q-space />
          <q-btn
            dense
            flat
            icon="add"
            :aria-label="$t('a11y.addContact')"
            data-test="panel-add-contact"
            @click="openAddContact"
          />
        </q-item>
        <q-separator />

        <!-- Search input -->
        <q-item class="q-px-sm q-py-xs full-width">
          <q-item-section>
            <q-input
              v-model="search"
              dense
              outlined
              rounded
              clearable
              class="full-width"
              data-test="contact-search-input"
              :placeholder="$t('contactBookDialog.search')"
            >
              <template #prepend>
                <q-icon name="search" size="xs" />
              </template>
            </q-input>
          </q-item-section>
        </q-item>

        <!-- Contacts list -->
        <template v-if="filteredContacts.length > 0">
          <q-item
            v-for="item in filteredContacts"
            :key="item.address"
            clickable
            v-ripple
            class="q-py-sm full-width"
            data-test="contact-list-row"
            @click="openProfile(item.address)"
          >
            <q-item-section avatar style="min-width: 44px; padding-right: 8px">
              <q-avatar rounded size="40px">
                <img
                  :src="
                    profileAvatar(item.contact?.profile?.avatar, item.address)
                  "
                />
              </q-avatar>
            </q-item-section>
            <q-item-section class="col" style="min-width: 0">
              <q-item-label lines="1" class="text-weight-medium ellipsis">
                {{
                  item.contact?.profile?.name || formatAddrCompact(item.address)
                }}
              </q-item-label>
              <q-item-label caption lines="1" class="ellipsis">
                {{ formatAddrCompact(item.address) }}
              </q-item-label>
            </q-item-section>
            <q-item-section side style="padding-left: 4px">
              <div class="row items-center no-wrap">
                <q-btn
                  flat
                  round
                  dense
                  size="sm"
                  icon="chat"
                  color="primary"
                  :aria-label="$t('chatList.directMessages')"
                  @click.stop="startChat(item.address)"
                />
                <q-btn
                  flat
                  round
                  dense
                  size="sm"
                  icon="delete"
                  color="grey"
                  class="q-ml-xs"
                  :aria-label="
                    $t('a11y.deleteContact', {
                      name: item.contact?.profile?.name || '',
                    })
                  "
                  @click.stop="deleteContact(item.address)"
                />
              </div>
            </q-item-section>
          </q-item>
        </template>
        <q-item v-else>
          <q-item-section class="text-grey text-center q-pa-md">
            {{
              search
                ? $t('contactItem.notFound')
                : $t('chatList.noContactMessage')
            }}
          </q-item-section>
        </q-item>
      </q-list>
    </q-scroll-area>
  </div>
</template>

<script lang="ts">
import { computed, defineComponent, ref } from 'vue'
import { useRouter } from 'vue-router'
import { storeToRefs } from 'pinia'

import { useContactStore, ContactState } from 'src/stores/contacts'
import { profileAvatar } from 'src/utils/avatar'
import { activeChain } from '@frank/wallet/chain'
import { openChat, openContactProfile, openPage } from 'src/utils/routes'

export default defineComponent({
  setup() {
    const router = useRouter()
    const contactStore = useContactStore()
    const { getContacts } = storeToRefs(contactStore)
    const search = ref('')

    const contactEntries = computed(() => {
      const contacts = getContacts.value ?? {}
      return Object.entries(contacts).filter(
        (entry): entry is [string, ContactState] => Boolean(entry[1]),
      )
    })

    const filteredContacts = computed(() => {
      const q = search.value.trim().toLowerCase()
      if (!q) {
        return contactEntries.value.map(([address, contact]) => ({
          address,
          contact,
        }))
      }
      return contactEntries.value
        .filter(([address, contact]) => {
          const name = contact.profile?.name?.toLowerCase() ?? ''
          return name.includes(q) || address.toLowerCase().includes(q)
        })
        .map(([address, contact]) => ({ address, contact }))
    })

    function formatAddr(address: string): string {
      const parsed = activeChain.parseAddress(address)
      return parsed ? activeChain.formatAddress(parsed) : address
    }

    function formatAddrCompact(address: string): string {
      if (!address) return ''
      return address.length > 13
        ? `${address.slice(0, 6)}...${address.slice(-4)}`
        : address
    }

    function openProfile(address: string) {
      openContactProfile(router, address)
    }

    function startChat(address: string) {
      openChat(router, address)
    }

    function openAddContact() {
      openPage(router, '/add-contact')
    }

    function deleteContact(address: string) {
      contactStore.deleteContact(address)
    }

    return {
      search,
      filteredContacts,
      profileAvatar,
      formatAddr,
      formatAddrCompact,
      openProfile,
      startChat,
      openAddContact,
      deleteContact,
    }
  },
})
</script>

<style scoped lang="scss">
:deep(.q-scrollarea__content) {
  width: 100% !important;
  min-width: 100% !important;
}
</style>
