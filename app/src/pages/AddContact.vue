<template>
  <q-page-container>
    <q-page class="q-ma-none q-pa-sm">
      <q-card>
        <q-card-section>
          <div class="text-h6">{{ $t('newContactDialog.newContact') }}</div>
        </q-card-section>
        <q-card-section>
          <q-input
            class="text-bold text-h6"
            v-model="address"
            filled
            dense
            :placeholder="$t('newContactDialog.enterBitcoinCashAddress')"
            :aria-busy="loading"
            ref="address"
            @keydown.enter.prevent="addContact()"
          />
        </q-card-section>
        <div class="q-sr-only" role="status" aria-live="polite">
          <span v-if="loading">{{ $t('newContactDialog.loading') }}</span>
          <span v-else-if="showNotFound">{{
            $t('newContactDialog.notFound')
          }}</span>
          <span v-else-if="contact">{{
            $t('newContactDialog.found', {
              name: contact.profile?.name ?? '',
            })
          }}</span>
        </div>
        <q-slide-transition>
          <q-card-section class="q-py-none" v-if="loading">
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
                <!-- TODO: Error information here -->
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
        </q-slide-transition>
        <q-card-actions align="right">
          <q-btn label="Cancel" color="negative" @click="cancel" />
          <q-btn
            :disable="!canAdd"
            label="Add"
            color="primary"
            @click="addContact()"
          />
        </q-card-actions>
      </q-card>
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
import { activeChain } from '@frank/wallet/chain'
import { PublicKey } from 'bitcore-lib-xpi'
import { openChat } from 'src/utils/routes'

// Delay between the last keystroke and the network lookup.
const LOOKUP_DEBOUNCE_MS = 250

type ChainAddress = Parameters<typeof activeChain.fetchProfile>[0]

type AcceptedLookup = {
  resolvedAddress: string
  contact: Partial<ContactState>
}

export default defineComponent({
  data() {
    return {
      address: '',
      acceptedLookup: null as AcceptedLookup | null,
      // Bumped on every address change; a lookup may only publish a result while its own
      // generation is still the latest, which is the single staleness mechanism.
      lookupGeneration: 0,
      lookupPending: false,
      lookupTimer: null as ReturnType<typeof setTimeout> | null,
    }
  },
  setup() {
    const contactStore = useContactStore()

    return {
      addressRef: ref<QInput | null>(null),
      addContactToStore: contactStore.addContact,
    }
  },
  computed: {
    canAdd(): boolean {
      return this.acceptedLookup !== null
    },
    contact(): Partial<ContactState> | null {
      return this.acceptedLookup?.contact ?? null
    },
    loading(): boolean {
      return this.lookupPending
    },
    showNotFound(): boolean {
      return (
        !this.loading && this.contact === null && this.address.trim() !== ''
      )
    },
  },
  watch: {
    address(newAddress: string) {
      const generation = ++this.lookupGeneration
      this.cancelScheduledLookup()
      this.acceptedLookup = null
      this.lookupPending = false
      if (newAddress.trim() === '') {
        return
      }
      const normalizedAddress = this.canonicalizeAddress(newAddress)
      if (!normalizedAddress) {
        return
      }
      this.lookupPending = true
      this.lookupTimer = setTimeout(() => {
        this.lookupTimer = null
        void this.lookup(
          generation,
          normalizedAddress.chainAddress,
          normalizedAddress.resolvedAddress,
        )
      }, LOOKUP_DEBOUNCE_MS)
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
      if (this.lookupTimer !== null) {
        clearTimeout(this.lookupTimer)
        this.lookupTimer = null
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
        const profileInfo = await activeChain.fetchProfile(chainAddress)
        if (generation !== this.lookupGeneration) {
          return
        }
        this.lookupPending = false
        if (!profileInfo) {
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
              bio: profileInfo.bio ?? '',
              avatar: profileInfo.avatar ?? '',
              pubKey: markRaw(PublicKey.fromBuffer(profileInfo.pubKey)),
            },
          },
        }
      } catch {
        if (generation === this.lookupGeneration) {
          this.lookupPending = false
        }
      }
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
      window.history.length > 1 ? this.$router.go(-1) : this.$router.push('/')
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
