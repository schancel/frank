<template>
  <div
    @mouseenter="$emit('mouseover-contact', address)"
    @mouseleave="$emit('mouseleave-contact', address)"
  >
    <q-item v-if="contact === null">
      <q-item-section avatar>
        <q-icon color="negative" name="error" size="xl" />
      </q-item-section>
      <q-item-section>
        <q-item-label>{{ $t('contactItem.notFound') }}</q-item-label>
        <!-- TODO: Error information here -->
      </q-item-section>
    </q-item>
    <q-item v-else-if="contact === 'loading'">
      <q-item-section avatar>
        <q-skeleton type="QAvatar" />
      </q-item-section>
      <q-item-section>
        <q-item-label>
          <q-skeleton type="text" />
        </q-item-label>
        <q-item-label caption>
          <q-skeleton type="text" />
        </q-item-label>
      </q-item-section>
    </q-item>
    <q-item v-ripple v-else-if="contact">
      <q-item-section
        avatar
        v-close-popup
        @click="contactClick(address, contact)"
      >
        <q-avatar rounded size="55px" :style="contactColorStyle">
          <img :src="profileAvatar(contact.profile.avatar, address)" />
        </q-avatar>
      </q-item-section>
      <q-item-section v-close-popup @click="contactClick(address, contact)">
        <div class="name-with-badge">
          <q-item-label lines="1">{{ contact.profile.name }}</q-item-label>
          <account-badge
            :address="address"
            :account-type="contact.profile.accountType"
            :bot-role="contact.profile.botRole"
            :is-bot="contact.profile.isBot"
          />
        </div>
        <q-item-label lines="1" caption>
          <span class="text-weight-bold">{{ $t('contactItem.address') }}:</span>
          {{ address }}
        </q-item-label>
        <!-- Only when the contact actually advertises a price: a Monad contact has none, and the
        label used to render with nothing after it (ticket #368). -->
        <q-item-label v-if="hasInboxPrice" caption data-testid="inbox-price">
          <span class="text-weight-bold"
            >{{ $t('contactItem.inboxPrice') }}:</span
          >
          {{ contact.inbox.acceptancePrice }}
        </q-item-label>
      </q-item-section>
      <q-item-section side>
        <q-btn
          flat
          round
          dense
          icon="more_vert"
          :aria-label="
            $t('a11y.contactActions', { name: contact.profile.name })
          "
          aria-haspopup="menu"
          data-test="contact-item-actions"
          @click.stop
        >
          <q-menu @click.stop @keydown.stop>
            <q-list dense>
              <q-item
                clickable
                v-close-popup
                role="menuitem"
                data-test="contact-item-delete"
                @click.stop="confirmDeleteOpen = true"
              >
                <q-item-section avatar
                  ><q-icon name="delete" color="negative"
                /></q-item-section>
                <q-item-section>{{
                  $t('a11y.deleteContact', { name: contact.profile.name })
                }}</q-item-section>
              </q-item>
            </q-list>
          </q-menu>
        </q-btn>
      </q-item-section>
    </q-item>
    <q-dialog v-model="confirmDeleteOpen" persistent>
      <delete-contact-dialog
        v-if="confirmDeleteOpen"
        :address="address"
        :name="contact?.profile?.name || address"
        @cancel="confirmDeleteOpen = false"
        @deleted="confirmDeleteOpen = false"
      />
    </q-dialog>
  </div>
</template>

<script lang="ts">
import { defineComponent } from 'vue'
import type { ProfilePubKey } from 'src/utils/profile-pubkey'
import { pubKeyToColor } from 'src/utils/formatting'
import { profileAvatar } from 'src/utils/avatar'
import AccountBadge from './AccountBadge.vue'
import DeleteContactDialog from '../dialogs/DeleteContactDialog.vue'

export default defineComponent({
  components: {
    AccountBadge,
    DeleteContactDialog,
  },
  props: {
    address: {
      type: String,
      default: () => '',
    },
    contact: {
      type: Object,
      default: () => ({}),
    },
    contactClick: {
      type: Function,
      default: () => '',
    },
  },
  emits: ['mouseover-contact', 'mouseleave-contact'],
  data() {
    return { confirmDeleteOpen: false }
  },
  setup() {
    return { profileAvatar }
  },
  computed: {
    hasInboxPrice() {
      const price = (this.contact as { inbox?: { acceptancePrice?: unknown } })
        ?.inbox?.acceptancePrice
      return typeof price === 'number' && Number.isFinite(price)
    },
    // Ticket #50: same spoofing/impersonation cue as ChatLayout.vue's chat header -- see that
    // file's own comment for the full rationale.
    contactColorStyle() {
      const pubKey = (
        this.contact as { profile?: { pubKey?: ProfilePubKey | null } }
      )?.profile?.pubKey
      if (!pubKey) {
        return {}
      }
      return { boxShadow: `0 0 0 3px ${pubKeyToColor(pubKey.toBuffer())}` }
    },
  },
})
</script>
