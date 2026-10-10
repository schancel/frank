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
            icon="qr_code"
            :aria-label="$t('contactBookDialog.myQrCode')"
            data-test="panel-my-qr"
            @click="showMyQrDialog = true"
          />
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
          <q-item-label
            header
            class="text-caption text-uppercase q-py-xs q-px-sm text-grey-7"
            v-if="search && (networkResults.length > 0 || isSearchingNetwork)"
          >
            {{ $t('contactBookDialog.contacts') }}
          </q-item-label>
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
              <div class="row items-center no-wrap">
                <q-item-label lines="1" class="text-weight-medium ellipsis">
                  {{ contactDisplayName(item) }}
                </q-item-label>
                <account-badge
                  :address="item.address"
                  :name="contactDisplayName(item)"
                  :account-type="item.contact?.profile?.accountType"
                  :bot-role="item.contact?.profile?.botRole"
                  :is-bot="item.contact?.profile?.isBot"
                />
              </div>
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
                      name: contactDisplayName(item),
                    })
                  "
                  @click.stop="deleteContact(item.address)"
                />
              </div>
            </q-item-section>
          </q-item>
        </template>

        <!-- Directory Search Loading -->
        <q-item v-if="isSearchingNetwork" class="q-py-xs full-width">
          <q-item-section avatar style="min-width: 44px; padding-right: 8px">
            <q-spinner size="24px" color="primary" />
          </q-item-section>
          <q-item-section>
            <q-item-label caption>{{
              $t('newContactDialog.loading')
            }}</q-item-label>
          </q-item-section>
        </q-item>

        <!-- Directory Search Results -->
        <template v-if="networkResults.length > 0">
          <q-separator v-if="filteredContacts.length > 0" class="q-my-xs" />
          <q-item-label
            header
            class="text-caption text-uppercase q-py-xs q-px-sm text-grey-7"
          >
            Directory
          </q-item-label>
          <q-item
            v-for="res in networkResults"
            :key="res.address"
            clickable
            v-ripple
            class="q-py-sm full-width"
            data-test="directory-search-result"
            @click="addAndOpenProfile(res)"
          >
            <q-item-section avatar style="min-width: 44px; padding-right: 8px">
              <q-avatar rounded size="40px">
                <img :src="profileAvatar(res.avatar, res.address)" />
              </q-avatar>
            </q-item-section>
            <q-item-section class="col" style="min-width: 0">
              <div class="row items-center no-wrap">
                <q-item-label lines="1" class="text-weight-medium ellipsis">
                  {{ res.name || formatAddrCompact(res.address) }}
                </q-item-label>
                <account-badge
                  :address="res.address"
                  :name="res.name"
                  :account-type="res.accountType"
                  :bot-role="res.botRole"
                  :is-bot="res.bot"
                />
              </div>
              <q-item-label caption lines="1" class="ellipsis">
                <username-handle
                  v-if="res.username"
                  :username="res.username"
                  class="q-mr-xs"
                />{{ formatAddrCompact(res.address) }}
              </q-item-label>
            </q-item-section>
            <q-item-section side style="padding-left: 4px">
              <div class="row items-center no-wrap">
                <q-btn
                  flat
                  round
                  dense
                  size="sm"
                  icon="person_add"
                  color="primary"
                  :aria-label="$t('a11y.addContact')"
                  @click.stop="addNetworkContact(res)"
                />
                <q-btn
                  flat
                  round
                  dense
                  size="sm"
                  icon="chat"
                  color="primary"
                  class="q-ml-xs"
                  :aria-label="$t('chatList.directMessages')"
                  @click.stop="addAndStartChat(res)"
                />
              </div>
            </q-item-section>
          </q-item>
        </template>

        <q-item
          v-if="
            filteredContacts.length === 0 &&
            networkResults.length === 0 &&
            !isSearchingNetwork
          "
        >
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
    <identity-qr-dialog v-model="showMyQrDialog" />
  </div>
</template>

<script lang="ts">
import {
  computed,
  defineComponent,
  inject,
  onBeforeUnmount,
  onMounted,
  ref,
  watch,
} from 'vue'
import { useRouter } from 'vue-router'
import { storeToRefs } from 'pinia'
import { useQuasar } from 'quasar'

import {
  useContactStore,
  ContactState,
  pendingRelayData,
} from 'src/stores/contacts'
import { profileAvatar } from 'src/utils/avatar'
import { activeChain } from '@frank/wallet/chain'
import { openChat, openContactProfile, openPage } from 'src/utils/routes'
import { isNarrowWidth } from 'src/utils/layout'
import IdentityQrDialog from 'src/components/dialogs/IdentityQrDialog.vue'
import { isOwnAddress } from 'src/utils/own-address'
import {
  searchMonadProfiles,
  decodeProfileBytes,
} from '@frank/wallet/monad-identity'
import { loadMonadChainConfigFromEnv } from '@frank/wallet/chain/monad-chain'
import {
  searchUsernames,
  usernamesOfAddresses,
} from '@frank/cashweb/relay/username-client'
import AccountBadge from 'src/components/contacts/AccountBadge.vue'
import UsernameHandle from 'src/components/contacts/UsernameHandle.vue'

interface NetworkSearchResult {
  address: string
  name: string
  username?: string
  avatar?: string
  bio?: string
  bot?: boolean
  accountType?: number
  botRole?: number
}

export default defineComponent({
  components: {
    IdentityQrDialog,
    AccountBadge,
    UsernameHandle,
  },
  emits: ['closeDrawer'],
  setup(props, { emit }) {
    const router = useRouter()
    const contactStore = useContactStore()
    const { getContacts } = storeToRefs(contactStore)
    const search = ref('')
    const showMyQrDialog = ref(false)
    const networkResults = ref<NetworkSearchResult[]>([])
    const isSearchingNetwork = ref(false)
    let searchTimer: ReturnType<typeof setTimeout> | null = null

    const qInject = inject<{ screen?: { width?: number } } | null>('_q_', null)
    let qHook: { screen?: { width?: number } } | null = null
    try {
      qHook = useQuasar()
    } catch {
      // ignore
    }
    const q = qHook ?? qInject

    function isNarrow(): boolean {
      const width =
        q?.screen?.width ??
        (typeof window !== 'undefined' ? window.innerWidth : 1024)
      return isNarrowWidth(width)
    }

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
          const rawName = contact.profile?.name?.toLowerCase() ?? ''
          const name =
            rawName === 'loading...' ||
            rawName === pendingRelayData.profile.name.toLowerCase()
              ? ''
              : rawName
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

    function contactDisplayName(item: {
      address: string
      contact?: ContactState
    }): string {
      const name = item.contact?.profile?.name
      if (
        !name ||
        name === 'Loading...' ||
        name === pendingRelayData.profile.name ||
        name.trim() === ''
      ) {
        return formatAddrCompact(item.address)
      }
      return name
    }

    onMounted(() => {
      for (const [address, contact] of contactEntries.value) {
        if (
          !contact.profile?.name ||
          contact.profile.name === 'Loading...' ||
          contact.profile.name === pendingRelayData.profile.name
        ) {
          if (typeof contactStore.refresh === 'function') {
            void contactStore.refresh(address)
          }
        }
      }
    })

    function isContact(addr: string): boolean {
      if (typeof contactStore.isContact === 'function') {
        return contactStore.isContact(addr)
      }
      const contacts = getContacts.value ?? {}
      return Boolean(contacts[addr] || contacts[addr.toLowerCase()])
    }

    watch(search, (newVal: string) => {
      if (searchTimer) {
        clearTimeout(searchTimer)
        searchTimer = null
      }
      const rawQ = (newVal ?? '').trim()
      const cleanQ = rawQ.startsWith('@') ? rawQ.slice(1) : rawQ
      if (cleanQ.length < 2) {
        networkResults.value = []
        isSearchingNetwork.value = false
        return
      }
      isSearchingNetwork.value = true
      searchTimer = setTimeout(async () => {
        try {
          let relayBaseUrl: string | undefined
          try {
            relayBaseUrl = loadMonadChainConfigFromEnv()?.relayBaseUrl
          } catch {
            // fallback
          }
          if (!relayBaseUrl) return

          // Two searches: unique usernames (the relay gives a name to one account only), and
          // display names, which are free text anyone can set.
          const [named, entries] = await Promise.all([
            searchUsernames({ relayBaseUrl, prefix: cleanQ, limit: 10 }).catch(
              () => [],
            ),
            searchMonadProfiles({
              relayBaseUrl,
              prefix: cleanQ,
              limit: 10,
            }).catch(() => []),
          ])
          // The username shown for an account is only ever the one the relay says it holds,
          // never the one a profile claims for itself.
          const usernameOf = new Map<string, string>(
            named.map(user => [user.address, user.username]),
          )
          const unnamed = entries
            .map(entry => entry.address.toLowerCase())
            .filter(address => !usernameOf.has(address))
          if (unnamed.length > 0) {
            const held = await usernamesOfAddresses({
              relayBaseUrl,
              addresses: unnamed,
            }).catch(() => [])
            for (const user of held) usernameOf.set(user.address, user.username)
          }
          const allEntries: { address: string; rawBytes: Uint8Array }[] = [
            ...named.map(user => ({
              address: user.address,
              rawBytes: user.profile ?? new Uint8Array(),
            })),
            ...entries.filter(
              entry =>
                !named.some(
                  user => user.address === entry.address.toLowerCase(),
                ),
            ),
          ]

          const results: NetworkSearchResult[] = []
          for (const entry of allEntries) {
            let name = formatAddrCompact(entry.address)
            const username = usernameOf.get(entry.address.toLowerCase())
            let avatar: string | undefined
            let bio: string | undefined
            let bot = false
            let accountType: number | undefined
            let botRole: number | undefined
            if (entry.rawBytes && entry.rawBytes.length > 0) {
              try {
                const decoded = decodeProfileBytes(entry.rawBytes, {
                  expectedAddress: entry.address,
                })
                if (decoded.name) name = decoded.name
                avatar = decoded.avatar
                bio = decoded.bio
                bot = Boolean(decoded.bot)
                accountType = decoded.accountType
                botRole = decoded.botRole
              } catch {
                // Ignore profile decode errors
              }
            }
            const isLocal = isContact(entry.address)
            let isSelf = false
            try {
              isSelf = await isOwnAddress(entry.address)
            } catch {
              // Ignore
            }
            if (!isLocal && !isSelf) {
              results.push({
                address: entry.address,
                name,
                username,
                avatar,
                bio,
                bot,
                accountType,
                botRole,
              })
            }
          }
          if (search.value.trim() === rawQ) {
            networkResults.value = results
          }
        } catch (err) {
          console.warn('Network contact search error', err)
          if (search.value.trim() === rawQ) {
            networkResults.value = []
          }
        } finally {
          if (search.value.trim() === rawQ) {
            isSearchingNetwork.value = false
          }
        }
      }, 300)
    })

    onBeforeUnmount(() => {
      if (searchTimer) {
        clearTimeout(searchTimer)
        searchTimer = null
      }
    })

    function openProfile(address: string) {
      openContactProfile(router, address)
      if (isNarrow()) {
        emit('closeDrawer')
      }
    }

    function startChat(address: string) {
      openChat(router, address)
      if (isNarrow()) {
        emit('closeDrawer')
      }
    }

    function addNetworkContact(item: NetworkSearchResult) {
      if (typeof contactStore.addContact === 'function') {
        contactStore.addContact({
          address: item.address,
          contact: {
            ...pendingRelayData,
            profile: {
              ...(pendingRelayData?.profile ?? {}),
              name: item.name,
              username: item.username,
              // Pinned: this contact is this address from now on, whoever holds the name later.
              addedByUsername: item.username ?? null,
              bio: item.bio ?? '',
              avatar: item.avatar ?? null,
              pubKey: null,
              isBot: item.bot ?? false,
              accountType: item.accountType,
              botRole: item.botRole,
            },
          },
        })
      }
      if (typeof contactStore.refresh === 'function') {
        void contactStore.refresh(item.address)
      }
      networkResults.value = networkResults.value.filter(
        r => r.address.toLowerCase() !== item.address.toLowerCase(),
      )
    }

    function addAndStartChat(item: NetworkSearchResult) {
      addNetworkContact(item)
      openChat(router, item.address)
      if (isNarrow()) {
        emit('closeDrawer')
      }
    }

    function addAndOpenProfile(item: NetworkSearchResult) {
      addNetworkContact(item)
      openProfile(item.address)
    }

    function openAddContact() {
      const from =
        router.currentRoute?.value?.fullPath ||
        router.currentRoute?.value?.path ||
        ''
      const target = from
        ? `/add-contact?mode=contact&from=${encodeURIComponent(from)}`
        : '/add-contact?mode=contact'
      openPage(router, target)
    }

    function deleteContact(address: string) {
      contactStore.deleteContact(address)
    }

    return {
      search,
      filteredContacts,
      networkResults,
      isSearchingNetwork,
      profileAvatar,
      formatAddr,
      formatAddrCompact,
      openProfile,
      startChat,
      addNetworkContact,
      addAndStartChat,
      addAndOpenProfile,
      openAddContact,
      deleteContact,
      showMyQrDialog,
      contactDisplayName,
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
