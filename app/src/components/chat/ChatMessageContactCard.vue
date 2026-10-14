<template>
  <div
    class="contact-card q-pa-sm rounded-borders"
    data-test="contact-card"
    data-testid="contact-card"
  >
    <div class="row items-center no-wrap q-gutter-sm">
      <q-avatar
        size="40px"
        color="primary"
        text-color="white"
        data-test="contact-card-avatar"
      >
        <img v-if="safeAvatar" :src="safeAvatar" alt="" />
        <span v-else class="text-weight-bold">{{ initials }}</span>
      </q-avatar>
      <div class="col">
        <div
          class="text-subtitle2 text-weight-bold"
          data-test="contact-card-fullname"
        >
          {{ item.fullName }}
        </div>
        <div
          v-if="subtitleText"
          class="text-caption"
          data-test="contact-card-org-title"
        >
          {{ subtitleText }}
        </div>
        <div
          v-if="item.username"
          class="text-caption"
          data-test="contact-card-username"
        >
          @{{ item.username }}
        </div>
      </div>
    </div>

    <div class="q-mt-xs">
      <div
        v-if="item.frankAddress"
        class="text-caption ellipsis"
        data-test="contact-card-address"
      >
        <q-icon name="account_balance_wallet" size="14px" class="q-mr-xs" />
        <span
          >{{ $t('contactCard.frankAddress') }}: {{ item.frankAddress }}</span
        >
      </div>

      <div
        v-for="(email, idx) in item.emails ?? []"
        :key="`email-${idx}`"
        class="text-caption"
        data-test="contact-card-email"
      >
        <q-icon name="email" size="14px" class="q-mr-xs" />
        <span>{{ $t('contactCard.email') }}: {{ email }}</span>
      </div>

      <div
        v-for="(phone, idx) in item.phones ?? []"
        :key="`phone-${idx}`"
        class="text-caption"
        data-test="contact-card-phone"
      >
        <q-icon name="phone" size="14px" class="q-mr-xs" />
        <span>{{ $t('contactCard.phone') }}: {{ phone }}</span>
      </div>

      <div v-if="safeUrl" class="text-caption" data-test="contact-card-url">
        <q-icon name="language" size="14px" class="q-mr-xs" />
        <a
          :href="safeUrl"
          target="_blank"
          rel="noopener noreferrer"
          class="contact-card-link"
        >
          {{ safeUrl }}
        </a>
      </div>

      <div
        v-if="item.note"
        class="text-caption q-mt-xs"
        data-test="contact-card-note"
      >
        {{ item.note }}
      </div>
    </div>

    <!-- 1-Click Actions -->
    <div class="row items-center q-gutter-xs q-mt-sm">
      <q-btn
        v-if="canAddToFrankContacts"
        dense
        no-caps
        size="sm"
        :unelevated="isSavedContact"
        :outline="!isSavedContact"
        color="primary"
        icon="person_add"
        :label="
          isSavedContact
            ? $t('contactCard.addedToContacts')
            : $t('contactCard.addToContacts')
        "
        data-test="contact-card-add"
        data-testid="contact-card-add"
        @click="addToContacts"
      />
      <q-btn
        flat
        dense
        no-caps
        size="sm"
        icon="download"
        :label="$t('contactCard.saveVcf')"
        data-test="contact-card-download-vcf"
        data-testid="contact-card-download-vcf"
        @click="saveVcf"
      />
    </div>
  </div>
</template>

<script lang="ts">
import { defineComponent, type PropType } from 'vue'
import type { ContactCardItem } from '@frank/cashweb/types/messages'
import { downloadContactCardVcf } from '../../utils/calendar-vcard'
import { useContactStore } from '../../stores/contacts'

export default defineComponent({
  name: 'ChatMessageContactCard',
  props: {
    item: {
      type: Object as PropType<ContactCardItem>,
      required: true,
    },
    address: {
      type: String,
      default: '',
    },
  },
  emits: ['addedToContacts', 'savedVcf'],
  data() {
    return {
      addedLocally: false,
    }
  },
  computed: {
    initials(): string {
      const parts = (this.item.fullName || '')
        .trim()
        .split(/\s+/)
        .filter(Boolean)
      if (parts.length === 0) return '?'
      if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase()
      return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase()
    },
    subtitleText(): string {
      return [this.item.title, this.item.organization]
        .filter(Boolean)
        .join(' · ')
    },
    safeAvatar(): string {
      const av = this.item.avatarDataUrl?.trim() ?? ''
      return av.startsWith('data:image/') ? av : ''
    },
    safeUrl(): string {
      const u = this.item.url?.trim() ?? ''
      return /^https?:\/\//i.test(u) ? u : ''
    },
    targetFrankAddress(): string {
      return (this.item.frankAddress || this.address || '').trim()
    },
    canAddToFrankContacts(): boolean {
      return Boolean(this.targetFrankAddress)
    },
    isSavedContact(): boolean {
      if (this.addedLocally) return true
      if (!this.targetFrankAddress) return false
      try {
        const contactStore = useContactStore()
        return Boolean(contactStore.haveContact?.(this.targetFrankAddress))
      } catch {
        return false
      }
    },
  },
  methods: {
    addToContacts() {
      const addr = this.targetFrankAddress
      if (!addr) return
      const bioParts = [
        this.subtitleText,
        this.item.note,
        ...(this.item.emails ?? []),
        ...(this.item.phones ?? []),
      ].filter(Boolean)
      try {
        const contactStore = useContactStore()
        contactStore.addContact({
          address: addr,
          contact: {
            profile: {
              name: this.item.fullName,
              username: this.item.username ?? null,
              bio: bioParts.join(' | ') || null,
              avatar: this.safeAvatar || null,
              pubKey: null,
            },
          },
        })
      } catch {
        // Ignore if Pinia is not active in isolated environment
      }
      this.addedLocally = true
      this.$emit('addedToContacts', {
        address: addr,
        fullName: this.item.fullName,
      })
    },
    saveVcf() {
      const vcf = downloadContactCardVcf(this.item)
      this.$emit('savedVcf', vcf)
    },
  },
})
</script>

<style lang="scss" scoped>
.contact-card {
  min-width: 220px;
  max-width: 380px;
  border: 1px solid rgba(128, 128, 128, 0.25);
  background: rgba(255, 255, 255, 0.06);
}

.contact-card-link {
  color: inherit;
  text-decoration: underline;
}
</style>
