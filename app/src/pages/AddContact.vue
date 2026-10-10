<template>
  <q-page-container>
    <q-page class="q-ma-none q-pa-sm">
      <q-card>
        <q-card-section>
          <div class="text-h6">
            {{
              isComposeMode
                ? $t('newContactDialog.composeEmail')
                : isConversationMode
                ? $t('newContactDialog.startConversation')
                : $t('newContactDialog.newContact')
            }}
          </div>
        </q-card-section>
        <q-card-section>
          <q-input
            class="text-bold text-h6"
            v-model="address"
            filled
            dense
            :placeholder="inputPlaceholder"
            :aria-busy="lookupPending"
            ref="address"
            data-test="address-input"
            @keydown.enter.prevent="onEnter()"
          >
            <template v-if="selectedExistingAddress" #append>
              <q-btn
                round
                dense
                flat
                icon="close"
                size="sm"
                :title="$t('newContactDialog.clearContact')"
                data-test="clear-contact-btn"
                @click="clearSelectedContact"
              />
            </template>
          </q-input>

          <!-- Existing contact suggestions dropdown / list -->
          <div
            v-if="showSuggestions"
            class="existing-contacts-dropdown q-mt-xs rounded-borders shadow-2"
            :class="
              $q?.dark?.isActive ? 'bg-grey-9 text-white' : 'bg-white text-dark'
            "
            style="max-height: 200px; overflow-y: auto"
            data-test="existing-contacts-suggestions"
          >
            <q-list separator dense>
              <q-item-label header class="text-caption text-grey-6 q-py-xs">
                {{ $t('newContactDialog.existingContacts') }}
              </q-item-label>
              <q-item
                v-for="item in matchingExistingContacts"
                :key="item.address"
                clickable
                v-ripple
                class="q-py-sm"
                data-test="existing-contact-item"
                @click="selectExistingContact(item.address, item.contact, true)"
              >
                <q-item-section avatar>
                  <q-avatar size="32px">
                    <img
                      v-if="item.contact.profile?.avatar"
                      :src="item.contact.profile.avatar"
                    />
                    <q-icon
                      v-else
                      :name="
                        item.contact.profile?.isBot ? 'smart_toy' : 'person'
                      "
                      color="primary"
                    />
                  </q-avatar>
                </q-item-section>
                <q-item-section>
                  <q-item-label class="text-weight-bold">
                    {{
                      item.contact.profile?.name ||
                      formatShortAddress(item.address)
                    }}
                    <username-handle
                      v-if="item.contact.profile?.username"
                      :username="item.contact.profile.username"
                      class="q-ml-xs"
                    />
                  </q-item-label>
                  <q-item-label caption class="text-grey-6 font-mono">
                    {{ formatShortAddress(item.address) }}
                  </q-item-label>
                </q-item-section>
                <q-item-section side>
                  <q-icon name="arrow_forward" size="xs" color="primary" />
                </q-item-section>
              </q-item>
            </q-list>
          </div>

          <q-input
            v-if="isConversationMode"
            v-model="topic"
            filled
            dense
            class="q-mt-sm"
            :label="$t('newContactDialog.topicOptional')"
            :placeholder="$t('newContactDialog.topicPlaceholder')"
            data-test="topic-input"
            @keydown.enter.prevent="onEnter()"
          />
        </q-card-section>
        <div class="q-sr-only" role="status" aria-live="polite">
          <span v-if="lookupPending">{{ $t('newContactDialog.loading') }}</span>
          <span v-else-if="showNotFound">{{
            $t('newContactDialog.notFound')
          }}</span>
          <span v-else-if="contact">{{
            $t('newContactDialog.found', {
              name: contact.profile?.name ?? '',
            })
          }}</span>
          <span v-else-if="isEmailRecipient">{{ emailAffordanceLabel }}</span>
        </div>
        <q-slide-transition>
          <q-card-section class="q-py-none" v-if="lookupPending">
            <q-item>
              <q-item-section avatar>
                <q-skeleton
                  type="QAvatar"
                  aria-hidden="true"
                  animation="none"
                />
              </q-item-section>
              <q-item-section>
                <q-item-label>
                  <q-skeleton type="text" aria-hidden="true" animation="none" />
                </q-item-label>
                <q-item-label caption>
                  <q-skeleton type="text" aria-hidden="true" animation="none" />
                </q-item-label>
              </q-item-section>
            </q-item>
          </q-card-section>
          <q-card-section class="q-py-none" v-else-if="showNotFound">
            <q-item>
              <q-item-section avatar>
                <q-icon color="negative" name="error" size="xl" />
              </q-item-section>
              <q-item-section>
                <q-item-label>{{
                  $t('newContactDialog.notFound')
                }}</q-item-label>
                <q-item-label
                  v-if="lookupFailure"
                  caption
                  data-test="contact-lookup-reason"
                  >{{
                    $t(`newContactDialog.lookup.${lookupFailure}`)
                  }}</q-item-label
                >
              </q-item-section>
            </q-item>
          </q-card-section>
          <q-card-section
            v-else-if="contact"
            class="q-py-none"
            data-test="selected-contact-section"
          >
            <q-item>
              <q-item-section avatar v-if="contact?.profile?.avatar">
                <q-avatar rounded>
                  <img :src="contact?.profile?.avatar" size="xl" />
                </q-avatar>
              </q-item-section>
              <q-item-section avatar v-else>
                <q-avatar
                  rounded
                  color="primary"
                  text-color="white"
                  :icon="contact?.profile?.isBot ? 'smart_toy' : 'person'"
                />
              </q-item-section>
              <q-item-section>
                <q-item-label class="text-weight-bold">
                  {{
                    contact?.profile?.name ||
                    formatShortAddress(acceptedLookup?.resolvedAddress || '')
                  }}
                  <username-handle
                    v-if="contact?.profile?.username"
                    :username="contact.profile.username"
                    class="q-ml-xs"
                  />
                </q-item-label>
                <q-item-label
                  caption
                  v-if="acceptedLookup?.resolvedAddress"
                  class="font-mono"
                >
                  {{ acceptedLookup.resolvedAddress }}
                </q-item-label>
              </q-item-section>
              <q-item-section side v-if="isExistingContact">
                <q-badge
                  color="positive"
                  outline
                  :label="$t('newContactDialog.existingContact')"
                  data-test="existing-contact-badge"
                />
              </q-item-section>
            </q-item>
          </q-card-section>
          <q-card-section
            v-else-if="isEmailRecipient"
            class="q-py-none"
            data-test="email-recipient-section"
          >
            <q-item
              clickable
              @click="startEmailThread"
              class="rounded-borders bg-primary-1 text-primary q-my-sm cursor-pointer"
              data-test="email-affordance-item"
            >
              <q-item-section avatar>
                <q-avatar color="primary" text-color="white" icon="mail" />
              </q-item-section>
              <q-item-section>
                <q-item-label
                  class="text-weight-bold"
                  data-test="email-affordance-label"
                >
                  {{ emailAffordanceLabel }}
                </q-item-label>
                <q-item-label caption>
                  {{ $t('newContactDialog.sendEmailViaGateway') }}
                </q-item-label>
              </q-item-section>
              <q-item-section side>
                <q-icon name="arrow_forward" color="primary" />
              </q-item-section>
            </q-item>
          </q-card-section>
        </q-slide-transition>
        <q-card-actions align="between">
          <q-btn
            flat
            no-caps
            icon="qr_code_2"
            color="primary"
            :label="$t('newContactDialog.showMyQr')"
            data-test="add-contact-show-my-qr"
            @click="showMyQrDialog = true"
          />
          <div class="row items-center q-gutter-sm">
            <q-btn
              label="Cancel"
              color="negative"
              flat
              no-caps
              @click="cancel"
            />
            <template v-if="isEmailRecipient">
              <q-btn
                color="primary"
                no-caps
                icon="mail"
                :label="$t('newContactDialog.startEmail')"
                data-test="start-email-thread-btn"
                @click="startEmailThread"
              />
            </template>
            <template v-else-if="isConversationMode">
              <q-btn
                :disable="!canAdd"
                no-caps
                :label="$t('newContactDialog.startConversationBtn')"
                color="primary"
                data-test="start-conversation-btn"
                @click="addContactAndOpenChat()"
              />
            </template>
            <template v-else>
              <q-btn
                :disable="!canAdd"
                outline
                no-caps
                color="primary"
                :label="$t('newContactDialog.addAndChat')"
                data-test="add-and-chat-btn"
                @click="addContactAndOpenChat()"
              />
              <q-btn
                :disable="!canAdd"
                label="Add"
                no-caps
                color="primary"
                data-test="add-contact-btn"
                @click="addContactOnly()"
              />
            </template>
          </div>
        </q-card-actions>
      </q-card>
      <identity-qr-dialog v-model="showMyQrDialog" />
    </q-page>
  </q-page-container>
</template>

<script lang="ts">
import { defineComponent, markRaw, ref } from 'vue'
import { QInput } from 'quasar'

import {
  ContactState,
  defaultRelayData,
  shortAddressLabel,
  useContactStore,
} from 'src/stores/contacts'
import { useChatStore } from 'src/stores/chats'
import { activeChain } from '@frank/wallet/chain'
import { profilePubKeyFromBytes } from 'src/utils/profile-pubkey'
import { openChat } from 'src/utils/routes'
import { errorNotify } from 'src/utils/notifications'
import { defaultEmailGatewayAddress } from 'src/utils/constants'
import { useSettingsStore } from 'src/stores/settings'

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

// Pastes (the usual way a complete address arrives) look up immediately; edits made while a
// lookup is scheduled, in flight, or just fired wait this long so a burst yields one fetch.
const LOOKUP_DEBOUNCE_MS = 250

import {
  contactLookupFailure,
  fetchContactProfile,
  type ContactLookupFailure,
} from 'src/utils/directory-peer'
import IdentityQrDialog from 'src/components/dialogs/IdentityQrDialog.vue'
import UsernameHandle from 'src/components/contacts/UsernameHandle.vue'
import { relayHandleOf, resolveUsername } from 'src/utils/contact-username'

type ChainAddress = Parameters<typeof activeChain.fetchProfile>[0]

type AcceptedLookup = {
  resolvedAddress: string
  contact: Partial<ContactState>
}

export default defineComponent({
  components: {
    IdentityQrDialog,
    UsernameHandle,
  },
  data() {
    return {
      address: (this.$route?.query?.to as string) || '',
      topic: (this.$route?.query?.topic as string) || '',
      acceptedLookup: null as AcceptedLookup | null,
      selectedExistingAddress: null as string | null,
      showMyQrDialog: false,
      // Bumped on every address change; a lookup may only publish a result while its own
      // generation is still the latest, which is the single staleness mechanism.
      lookupGeneration: 0,
      lookupPending: false,
      // Why the directory has no usable entry for the typed address, when it said so.
      lookupFailure: null as ContactLookupFailure | null,
    }
  },
  setup() {
    const contactStore = useContactStore()

    return {
      contactStore,
      addressRef: ref<QInput | null>(null),
      // Plain (non-reactive) bookkeeping: setup state is not deeply reactive.
      lookupSchedule: {
        timer: null as ReturnType<typeof setTimeout> | null,
        lastFiredAt: -Infinity,
      },
      addContactToStore: contactStore.addContact,
    }
  },
  computed: {
    isComposeMode(): boolean {
      return this.$route?.query?.compose === 'email'
    },
    isConversationMode(): boolean {
      return Boolean(
        this.$route?.query?.mode === 'conversation' || this.isComposeMode,
      )
    },
    isContactMode(): boolean {
      return !this.isConversationMode
    },
    isEmailRecipient(): boolean {
      return EMAIL_REGEX.test(this.address.trim())
    },
    emailAddress(): string {
      return this.address.trim()
    },
    emailAffordanceLabel(): string {
      return `Start Email Thread to ${this.emailAddress} (via Frank Email Gateway)`
    },
    inputPlaceholder(): string {
      return this.$t('newContactDialog.enterAddressOrEmail')
    },
    allContacts(): Record<string, ContactState | undefined> {
      try {
        const store = this.contactStore || useContactStore()
        if (
          typeof store.getContacts === 'object' &&
          store.getContacts !== null
        ) {
          return store.getContacts
        }
        if (typeof store.contacts === 'object' && store.contacts !== null) {
          return store.contacts
        }
      } catch {
        // Pinia not active
      }
      return {}
    },
    matchingExistingContacts(): Array<{
      address: string
      contact: ContactState
    }> {
      const q = this.address.trim().toLowerCase()
      // "@name" is a username: who holds it is the relay's answer (see the address watcher),
      // never a guess from the names saved contacts happen to carry.
      if (!q || EMAIL_REGEX.test(q) || q.startsWith('@')) {
        return []
      }
      const entries = Object.entries(this.allContacts)
      const matches: Array<{ address: string; contact: ContactState }> = []

      for (const [addr, contact] of entries) {
        if (!contact) continue
        const name = contact.profile?.name?.toLowerCase() || ''
        const signedName = contact.profile?.signedName?.toLowerCase() || ''
        const addressLower = addr.toLowerCase()

        if (
          name.includes(q) ||
          signedName.includes(q) ||
          addressLower.includes(q)
        ) {
          matches.push({ address: addr, contact })
        }
      }
      return matches
    },
    showSuggestions(): boolean {
      return (
        !this.selectedExistingAddress &&
        this.matchingExistingContacts.length > 0 &&
        !this.isEmailRecipient &&
        this.address.trim() !== ''
      )
    },
    isExistingContact(): boolean {
      if (!this.acceptedLookup?.resolvedAddress) return false
      return Boolean(this.allContacts[this.acceptedLookup.resolvedAddress])
    },
    canAdd(): boolean {
      return (
        this.acceptedLookup !== null ||
        this.matchingExistingContacts.length === 1
      )
    },
    contact(): Partial<ContactState> | null {
      return this.acceptedLookup?.contact ?? null
    },
    showNotFound(): boolean {
      return (
        !this.lookupPending &&
        this.contact === null &&
        !this.isEmailRecipient &&
        this.matchingExistingContacts.length === 0 &&
        this.address.trim() !== ''
      )
    },
  },
  watch: {
    address(newAddress: string) {
      const generation = ++this.lookupGeneration
      const busy =
        this.lookupPending ||
        Date.now() - this.lookupSchedule.lastFiredAt < LOOKUP_DEBOUNCE_MS
      this.cancelScheduledLookup()

      if (this.selectedExistingAddress) {
        const selected = this.allContacts[this.selectedExistingAddress]
        const text = newAddress.trim().toLowerCase()
        const matchesSelected =
          text === this.selectedExistingAddress.toLowerCase() ||
          (selected?.profile?.name &&
            text === selected.profile.name.toLowerCase()) ||
          (selected?.profile?.username &&
            text.replace(/^@/, '') === selected.profile.username.toLowerCase())
        if (!matchesSelected) {
          this.selectedExistingAddress = null
          this.acceptedLookup = null
        } else {
          return
        }
      }

      this.acceptedLookup = null
      this.lookupPending = false
      this.lookupFailure = null

      if (newAddress.trim() === '') {
        return
      }
      if (EMAIL_REGEX.test(newAddress.trim())) {
        return
      }

      // "@name": ask the relay who holds the name. The answer is an address; from there on the
      // contact is that address, whatever the name points to later.
      if (newAddress.trim().startsWith('@')) {
        this.lookupPending = true
        const fireUsername = () => {
          this.lookupSchedule.timer = null
          this.lookupSchedule.lastFiredAt = Date.now()
          void this.lookupByUsername(generation, newAddress.trim())
        }
        if (busy) {
          this.lookupSchedule.timer = setTimeout(
            fireUsername,
            LOOKUP_DEBOUNCE_MS,
          )
        } else {
          fireUsername()
        }
        return
      }

      // Check if it's an exact match for an existing contact
      const exactContact = this.findExactExistingContact(newAddress)
      if (exactContact) {
        this.selectExistingContact(
          exactContact.address,
          exactContact.contact,
          false,
        )
        return
      }

      const normalizedAddress = this.canonicalizeAddress(newAddress)
      if (!normalizedAddress) {
        return
      }
      this.lookupPending = true
      const fire = () => {
        this.lookupSchedule.timer = null
        this.lookupSchedule.lastFiredAt = Date.now()
        void this.lookup(
          generation,
          normalizedAddress.chainAddress,
          normalizedAddress.resolvedAddress,
        )
      }
      if (busy) {
        this.lookupSchedule.timer = setTimeout(fire, LOOKUP_DEBOUNCE_MS)
      } else {
        fire()
      }
    },
  },
  methods: {
    findExactExistingContact(
      query: string,
    ): { address: string; contact: ContactState } | null {
      const q = query.trim().toLowerCase()
      if (!q || EMAIL_REGEX.test(q) || q.startsWith('@')) return null

      for (const [addr, contact] of Object.entries(this.allContacts)) {
        if (!contact) continue
        const name = contact.profile?.name?.toLowerCase()
        const signedName = contact.profile?.signedName?.toLowerCase()
        const addressLower = addr.toLowerCase()

        if (
          (name && name === q) ||
          (signedName && signedName === q) ||
          addressLower === q
        ) {
          return { address: addr, contact }
        }
      }
      return null
    },
    selectExistingContact(
      resolvedAddress: string,
      contact: ContactState,
      updateInput = true,
    ) {
      this.cancelScheduledLookup()
      this.lookupPending = false
      this.lookupFailure = null
      this.selectedExistingAddress = resolvedAddress
      this.acceptedLookup = {
        resolvedAddress,
        contact: {
          profile: {
            ...defaultRelayData.profile,
            ...contact.profile,
          },
        },
      }
      if (updateInput) {
        this.address =
          contact.profile?.name ||
          (contact.profile?.username
            ? `@${contact.profile.username}`
            : resolvedAddress)
      }
    },
    clearSelectedContact() {
      this.selectedExistingAddress = null
      this.acceptedLookup = null
      this.address = ''
    },
    formatShortAddress(addr: string): string {
      if (!addr) return ''
      if (typeof shortAddressLabel === 'function') {
        return shortAddressLabel(addr)
      }
      return addr.length > 12 ? `${addr.slice(0, 6)}…${addr.slice(-4)}` : addr
    },
    canonicalizeAddress(address: string) {
      try {
        const chainAddress = activeChain.parseAddress(address.trim())
        if (!chainAddress) {
          return null
        }
        return {
          chainAddress,
          resolvedAddress: activeChain.formatAddress(chainAddress),
        }
      } catch {
        return null
      }
    },
    cancelScheduledLookup() {
      if (this.lookupSchedule.timer !== null) {
        clearTimeout(this.lookupSchedule.timer)
        this.lookupSchedule.timer = null
      }
    },
    /** Resolve a typed "@name" through the relay's name store, then look that address up. */
    async lookupByUsername(generation: number, typed: string) {
      try {
        const holder = await resolveUsername(typed)
        if (generation !== this.lookupGeneration) {
          return
        }
        const normalized = holder && this.canonicalizeAddress(holder.address)
        if (!holder || !normalized) {
          this.lookupPending = false
          return
        }
        const existing = this.allContacts[normalized.resolvedAddress]
        if (existing) {
          // Already a contact: it stays as it was added.
          this.selectExistingContact(
            normalized.resolvedAddress,
            existing,
            false,
          )
          return
        }
        await this.lookup(
          generation,
          normalized.chainAddress,
          normalized.resolvedAddress,
          holder.username,
        )
      } catch {
        if (generation === this.lookupGeneration) {
          this.lookupPending = false
        }
      }
    },
    /** `resolvedUsername`: the name the relay resolved to this address, when the user typed
     * one. It is recorded as the name the contact was added by. */
    async lookup(
      generation: number,
      chainAddress: ChainAddress,
      resolvedAddress: string,
      resolvedUsername?: string,
    ) {
      try {
        if (generation !== this.lookupGeneration) {
          return
        }
        const profileInfo = await fetchContactProfile(chainAddress)
        if (generation !== this.lookupGeneration) {
          return
        }
        this.lookupPending = false
        if (!profileInfo) {
          this.lookupFailure = contactLookupFailure(chainAddress)
          return
        }
        const returnedProfileAddress = activeChain.formatAddress(
          profileInfo.address,
        )
        if (returnedProfileAddress !== resolvedAddress) {
          return
        }
        // The handle shown is the one the relay says this address holds, never the one its
        // profile declares.
        const username =
          resolvedUsername ??
          (await relayHandleOf(resolvedAddress))?.username ??
          null
        if (generation !== this.lookupGeneration) {
          return
        }
        this.acceptedLookup = {
          resolvedAddress,
          contact: {
            profile: {
              ...defaultRelayData.profile,
              name: profileInfo.name ?? '',
              signedName: profileInfo.name ?? null,
              username,
              addedByUsername: resolvedUsername ?? null,
              bio: profileInfo.bio ?? '',
              avatar: profileInfo.avatar ?? '',
              isBot: profileInfo.bot === true,
              pubKey: markRaw(profilePubKeyFromBytes(profileInfo.pubKey)),
            },
          },
        }
      } catch {
        if (generation === this.lookupGeneration) {
          this.lookupPending = false
        }
      }
    },
    onEnter() {
      if (this.isEmailRecipient) {
        this.startEmailThread()
      } else if (this.canAdd) {
        if (this.isConversationMode) {
          this.addContactAndOpenChat()
        } else {
          this.addContactOnly()
        }
      } else if (this.matchingExistingContacts.length > 0) {
        const first = this.matchingExistingContacts[0]
        this.selectExistingContact(first.address, first.contact, true)
        if (this.isConversationMode) {
          this.addContactAndOpenChat()
        } else {
          this.addContactOnly()
        }
      }
    },
    startEmailThread() {
      if (!this.isEmailRecipient) {
        return
      }
      try {
        const settingsStore = useSettingsStore()
        const chatStore = useChatStore()
        const conversation = chatStore.createEmailConversation({
          recipientEmail: this.emailAddress,
          gatewayAddress:
            settingsStore.emailGatewayAddress || defaultEmailGatewayAddress,
          subject: this.topic.trim() || undefined,
        })
        chatStore.setActiveConversation(conversation.id)
        openChat(this.$router, conversation.id)
      } catch (err) {
        errorNotify(err instanceof Error ? err : new Error(String(err)))
      }
    },
    addContactOnly() {
      if (!this.acceptedLookup && this.matchingExistingContacts.length === 1) {
        const single = this.matchingExistingContacts[0]
        this.selectExistingContact(single.address, single.contact, true)
      }
      if (!this.canAdd || !this.acceptedLookup) {
        return
      }
      const { resolvedAddress, contact } = this.acceptedLookup as AcceptedLookup
      this.addContactToStore({ address: resolvedAddress, contact })
      if (typeof (this as any).$q?.notify === 'function') {
        ;(this as any).$q.notify({
          type: 'positive',
          message: this.$t('newContactDialog.contactAdded'),
          timeout: 2000,
        })
      }
      this.cancel()
    },
    addContactAndOpenChat() {
      if (!this.acceptedLookup && this.matchingExistingContacts.length === 1) {
        const single = this.matchingExistingContacts[0]
        this.selectExistingContact(single.address, single.contact, true)
      }
      if (!this.canAdd || !this.acceptedLookup) {
        return
      }
      const { resolvedAddress, contact } = this.acceptedLookup as AcceptedLookup
      this.addContactToStore({ address: resolvedAddress, contact })
      if (this.isConversationMode) {
        const chatStore = useChatStore()
        const conversation = chatStore.createConversation({
          kind: 'direct',
          name: this.topic.trim() || undefined,
          participants: [resolvedAddress],
          address: resolvedAddress,
        })
        chatStore.setActiveConversation(conversation.id)
        openChat(this.$router, conversation.id)
        return
      }
      openChat(this.$router, resolvedAddress)
    },
    addContact() {
      if (this.isConversationMode) {
        this.addContactAndOpenChat()
      } else {
        this.addContactOnly()
      }
    },
    cancel() {
      const from = this.$route?.query?.from
      if (typeof from === 'string' && from.length > 0) {
        void this.$router.push(from)
        return
      }
      const previous = (window.history.state as { back?: unknown } | null)?.back
      if (typeof previous === 'string' && previous.startsWith('/chat')) {
        this.$router.back()
        return
      }
      let address: string | undefined
      try {
        const chatStore = useChatStore()
        address =
          chatStore.activeChatAddr ?? chatStore.getSortedChatOrder[0]?.address
      } catch {
        // Pinia not active in test environment
      }
      if (address) {
        void this.$router.push(`/chat/${address}`)
        return
      }
      if (
        typeof previous === 'string' &&
        previous.length > 0 &&
        previous !== '/' &&
        previous !== '/forum'
      ) {
        this.$router.back()
        return
      }
      void this.$router.push('/chat')
    },
  },
  mounted() {
    this.addressRef?.$el.focus()
  },
  beforeUnmount() {
    this.cancelScheduledLookup()
  },
})
</script>
