<template>
  <div
    ref="panelRoot"
    role="region"
    :aria-label="$t('SettingPanel.panelLabel')"
    class="full-width column col"
    tabindex="-1"
    data-test="settings-panel"
  >
    <contact-card
      :address="myAddress"
      :name="profile.name"
      :bio="profile.bio"
      :avatar="profile.avatar"
      :acceptance-price="inbox.acceptancePrice"
    />

    <div class="flex-break" />
    <!-- Drawer -->
    <q-scroll-area class="col">
      <q-list>
        <q-item clickable v-ripple @click="openProfile">
          <q-item-section avatar>
            <q-icon name="face" />
          </q-item-section>

          <q-item-section>{{ $t('SettingPanel.profile') }}</q-item-section>
        </q-item>

        <q-item clickable v-ripple @click="openSettings">
          <q-item-section avatar>
            <q-icon name="tune" />
          </q-item-section>

          <q-item-section>{{ $t('SettingPanel.settings') }}</q-item-section>
        </q-item>
        <q-separator />

        <q-item
          v-if="legacyLotusMode"
          clickable
          v-ripple
          @click="deleteForever"
        >
          <q-item-section avatar>
            <q-icon name="delete_forever" />
          </q-item-section>

          <q-item-section>{{ $t('SettingPanel.wipeAndSave') }}</q-item-section>
        </q-item>

        <q-item
          clickable
          v-ripple
          @click="
            $router.push('/changelog').catch(() => {
              // Don't care. Probably duplicate route
            })
          "
        >
          <q-item-section avatar>
            <q-icon name="change_history" />
          </q-item-section>

          <q-item-section>{{ $t('SettingPanel.changeLog') }}</q-item-section>
        </q-item>
      </q-list>
    </q-scroll-area>
  </div>
</template>

<script lang="ts">
import { defineComponent, onMounted, ref } from 'vue'

import ContactCard from './ContactCard.vue'
import { openPage } from '../../utils/routes'
import { useProfileStore } from 'src/stores/my-profile'
import { storeToRefs } from 'pinia'
import { useActiveWallet } from 'src/composables/useActiveWallet'
import { legacyLotusModeEnabled } from 'src/utils/runtime-mode'

export default defineComponent({
  setup() {
    const myProfile = useProfileStore()
    const { profile, inbox } = storeToRefs(myProfile)
    const myAddress = ref('')
    onMounted(async () => {
      try {
        myAddress.value = (await useActiveWallet()).identity.displayAddress
      } catch {
        // The setup route may render this panel before a seed exists.
      }
    })
    return {
      legacyLotusMode: legacyLotusModeEnabled(),
      profile,
      inbox,
      myAddress,
    }
  },
  components: {
    ContactCard,
  },
  emits: ['update:drawerOpen'],
  props: {
    drawerOpen: {
      type: Boolean,
      default: () => false,
    },
  },
  model: {
    prop: 'drawerOpen',
    event: 'update:drawerOpen',
  },
  methods: {
    openSettings() {
      openPage(this.$router, '/settings')
    },
    openProfile() {
      openPage(this.$router, '/profile')
    },
    deleteForever() {
      openPage(this.$router, '/wipe-wallet')
    },
  },
  computed: {
    drawerOpenModel: {
      get() {
        return this.drawerOpen
      },
      set(value: boolean) {
        this.$emit('update:drawerOpen', value)
      },
    },
  },
})
</script>
