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
          <span v-else-if="contact === null && address.trim() !== ''">{{
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
          <q-card-section
            class="q-py-none"
            v-else-if="contact === null && address !== ''"
          >
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

type AcceptedLookup = {
  resolvedAddress: string
  contact: Partial<ContactState>
}

export default defineComponent({
  data() {
    return {
      address: '',
      acceptedLookup: null as AcceptedLookup | null,
      currentCanonicalAddress: null as string | null,
      lookupGeneration: 0,
      lookupPending: false,
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
      const currentAddress = this.canonicalizeAddress(this.address)
      return Boolean(
        this.acceptedLookup &&
          this.acceptedLookup.resolvedAddress ===
            this.currentCanonicalAddress &&
          currentAddress?.resolvedAddress ===
            this.acceptedLookup.resolvedAddress,
      )
    },
    contact(): Partial<ContactState> | null {
      return this.canAdd ? this.acceptedLookup?.contact ?? null : null
    },
    loading(): boolean {
      return this.lookupPending
    },
  },
  watch: {
    address: async function (newAddress) {
      const generation = ++this.lookupGeneration
      const trimmedAddress = newAddress.trim()
      this.acceptedLookup = null
      this.currentCanonicalAddress = null
      this.lookupPending = false
      if (trimmedAddress === '') {
        return
      }
      try {
        // Resolve via the active chain instead of the old Lotus-only
        // `toAPIAddress`/`RegistryHandler`/`ReadOnlyRelayClient` trio (ticket #44) -- mirrors
        // `stores/contacts.ts`'s own `fetchAndAddContact` network-resolution branch, but kept
        // local here (not committed to the store) until the user actually clicks "Add".
        const normalizedAddress = this.canonicalizeAddress(trimmedAddress)
        if (!normalizedAddress) {
          return
        }
        const { chainAddress, resolvedAddress } = normalizedAddress
        this.currentCanonicalAddress = resolvedAddress
        this.lookupPending = true
        const profileInfo = await activeChain.fetchProfile(chainAddress)
        const currentAddress = this.canonicalizeAddress(this.address)
        if (
          generation !== this.lookupGeneration ||
          resolvedAddress !== this.currentCanonicalAddress ||
          currentAddress?.resolvedAddress !== resolvedAddress
        ) {
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
    addContact() {
      const acceptedLookup = this.acceptedLookup
      const currentAddress = this.canonicalizeAddress(this.address)
      if (
        !acceptedLookup ||
        acceptedLookup.resolvedAddress !== this.currentCanonicalAddress ||
        currentAddress?.resolvedAddress !== acceptedLookup.resolvedAddress
      ) {
        return
      }
      this.addContactToStore({
        address: acceptedLookup.resolvedAddress,
        contact: acceptedLookup.contact,
      })
      openChat(this.$router, acceptedLookup.resolvedAddress)
    },
    cancel() {
      window.history.length > 1 ? this.$router.go(-1) : this.$router.push('/')
    },
  },
  mounted() {
    this.addressRef?.$el.focus()
  },
})
</script>
