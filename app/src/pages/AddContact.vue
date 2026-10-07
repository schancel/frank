<template>
  <q-page-container>
    <q-page class="q-ma-none q-pa-sm">
      <q-card>
        <q-card-section>
          <div class="text-h6">
            {{ isComposeMode ? $t('newContactDialog.composeEmail') : $t('newContactDialog.newContact') }}
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
          <span v-else-if="isEmailRecipient">{{
            emailAffordanceLabel
          }}</span>
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
          <q-card-section v-else-if="contact" class="q-py-none">
            <q-item>
              <q-item-section avatar v-if="contact?.profile?.avatar">
                <q-avatar rounded>
                  <img :src="contact?.profile?.avatar" size="xl" />
                </q-avatar>
              </q-item-section>
              <q-item-section>
                <q-item-label>{{ contact?.profile?.name }}</q-item-label>
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
          <div>
            <q-btn
              label="Cancel"
              color="negative"
              flat
              class="q-mr-sm"
              @click="cancel"
            />
            <q-btn
              v-if="isEmailRecipient"
              color="primary"
              icon="mail"
              :label="emailAffordanceLabel"
              data-test="start-email-thread-btn"
              @click="startEmailThread"
            />
            <q-btn
              v-else
              :disable="!canAdd"
              label="Add"
              color="primary"
              @click="addContact()"
            />
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
  useContactStore,
} from 'src/stores/contacts'
import { useChatStore } from 'src/stores/chats'
import { activeChain } from '@frank/wallet/chain'
import { profilePubKeyFromBytes } from 'src/utils/profile-pubkey'
import { openChat } from 'src/utils/routes'
import { defaultEmailGatewayAddress } from 'src/utils/constants'

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

type ChainAddress = Parameters<typeof activeChain.fetchProfile>[0]

type AcceptedLookup = {
  resolvedAddress: string
  contact: Partial<ContactState>
}

export default defineComponent({
  components: {
    IdentityQrDialog,
  },
  data() {
    return {
      address: (this.$route?.query?.to as string) || '',
      acceptedLookup: null as AcceptedLookup | null,
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
      if (this.isComposeMode) {
        return this.$t('newContactDialog.enterAddressOrEmail')
      }
      return this.$t('newContactDialog.enterBitcoinCashAddress')
    },
    canAdd(): boolean {
      return this.acceptedLookup !== null
    },
    contact(): Partial<ContactState> | null {
      return this.acceptedLookup?.contact ?? null
    },
    showNotFound(): boolean {
      return (
        !this.lookupPending &&
        this.contact === null &&
        !this.isEmailRecipient &&
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
      this.acceptedLookup = null
      this.lookupPending = false
      this.lookupFailure = null
      if (newAddress.trim() === '') {
        return
      }
      if (EMAIL_REGEX.test(newAddress.trim())) {
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
    async lookup(
      generation: number,
      chainAddress: ChainAddress,
      resolvedAddress: string,
    ) {
      // Resolve via the active chain instead of the old Lotus-only
      // `toAPIAddress`/`RegistryHandler`/`ReadOnlyRelayClient` trio (ticket #44) -- mirrors
      // `stores/contacts.ts`'s own `fetchAndAddContact` network-resolution branch, but kept
      // local here (not committed to the store) until the user actually clicks "Add".
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
        this.acceptedLookup = {
          resolvedAddress,
          contact: {
            profile: {
              ...defaultRelayData.profile,
              name: profileInfo.name ?? '',
              signedName: profileInfo.name ?? null,
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
      } else {
        this.addContact()
      }
    },
    startEmailThread() {
      if (!this.isEmailRecipient) {
        return
      }
      const email = this.emailAddress
      let targetId = email
      try {
        const chatStore = useChatStore()
        let conv: any
        if (
          typeof (chatStore as any).createOrOpenEmailConversation === 'function'
        ) {
          conv = (chatStore as any).createOrOpenEmailConversation({
            recipientEmail: email,
            gatewayAddress: defaultEmailGatewayAddress,
          })
        } else if (typeof chatStore.createConversation === 'function') {
          conv = chatStore.createConversation({
            kind: 'email',
            topic: email,
            name: email,
            emailRecipient: email,
            address: defaultEmailGatewayAddress,
            participants: [defaultEmailGatewayAddress],
          })
        }
        if (conv?.id) {
          targetId = conv.id
        }
        if (typeof chatStore.setActiveConversation === 'function') {
          chatStore.setActiveConversation(targetId)
        }
      } catch {
        // Pinia not active in test environment
      }
      openChat(this.$router, targetId)
    },
    addContact() {
      if (!this.canAdd) {
        return
      }
      const { resolvedAddress, contact } = this.acceptedLookup as AcceptedLookup
      this.addContactToStore({ address: resolvedAddress, contact })
      openChat(this.$router, resolvedAddress)
    },
    cancel() {
      const from = this.$route?.query?.from
      if (typeof from === 'string' && from.startsWith('/chat')) {
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
