<template>
  <div
    ref="panelRoot"
    role="region"
    :aria-label="$t('SettingPanel.panelLabel')"
    class="full-width column col"
    tabindex="-1"
    data-test="settings-panel"
  >
    <q-separator />
    <q-item>
      <q-item-section>
        <q-item-label>{{ $t('leftDrawer.settings') }}</q-item-label>
      </q-item-section>
    </q-item>
    <q-separator />

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

        <q-item
          clickable
          v-ripple
          data-test="backup-codex32-button"
          @click="openBackup"
        >
          <q-item-section avatar>
            <q-icon name="security" />
          </q-item-section>

          <q-item-section>
            {{ $t('accountRecovery.backup_account_codex32') }}
          </q-item-section>
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

        <q-item clickable v-ripple @click="openChangelog">
          <q-item-section avatar>
            <q-icon name="change_history" />
          </q-item-section>

          <q-item-section>{{ $t('SettingPanel.changeLog') }}</q-item-section>
        </q-item>

        <q-item clickable v-ripple data-test="open-docs" @click="openDocs">
          <q-item-section avatar>
            <q-icon name="menu_book" />
          </q-item-section>

          <q-item-section>{{ $t('docs.title') }}</q-item-section>
        </q-item>

        <q-item
          clickable
          v-ripple
          data-test="open-about"
          @click="
            $router.push('/about').catch(() => {
              // Don't care. Probably duplicate route
            })
          "
        >
          <q-item-section avatar>
            <q-icon name="info" />
          </q-item-section>

          <q-item-section>{{ $t('about.menu') }}</q-item-section>
        </q-item>
      </q-list>
    </q-scroll-area>
  </div>
</template>

<script lang="ts">
import {
  computed,
  defineComponent,
  getCurrentInstance,
  onMounted,
  ref,
} from 'vue'
import { useRouter } from 'vue-router'
import { useQuasar } from 'quasar'

import ContactCard from './ContactCard.vue'
import { openPage } from '../../utils/routes'
import { useProfileStore } from 'src/stores/my-profile'
import { storeToRefs } from 'pinia'
import { useActiveWallet } from 'src/composables/useActiveWallet'
import { legacyLotusModeEnabled } from 'src/utils/runtime-mode'
import { isNarrowWidth } from '../../utils/layout'

export default defineComponent({
  components: {
    ContactCard,
  },
  props: {
    drawerOpen: {
      type: Boolean,
      default: () => false,
    },
  },
  emits: ['update:drawerOpen', 'closeDrawer'],
  model: {
    prop: 'drawerOpen',
    event: 'update:drawerOpen',
  },
  setup(props, { emit }) {
    const myProfile = useProfileStore()
    const { profile, inbox } = storeToRefs(myProfile)
    const myAddress = ref('')
    const router = useRouter()
    const $q = useQuasar()
    const instance = getCurrentInstance()

    function getRouter() {
      return (
        (router && router.push ? router : null) ||
        (instance?.proxy as any)?.$router
      )
    }

    function maybeCloseDrawer(target: string) {
      const current = getRouter()?.currentRoute?.value?.path
      if (current === target) return
      const width =
        $q?.screen?.width ?? (instance?.proxy as any)?.$q?.screen?.width
      if (width !== undefined && isNarrowWidth(width)) {
        emit('closeDrawer')
      }
    }

    function openSettings() {
      const r = getRouter()
      maybeCloseDrawer('/settings')
      if (r) {
        return openPage(r, '/settings')
      }
    }

    function openBackup() {
      const r = getRouter()
      maybeCloseDrawer('/backup')
      if (r) {
        return openPage(r, '/backup')
      }
    }

    function openProfile() {
      const r = getRouter()
      maybeCloseDrawer('/profile')
      if (r) {
        return openPage(r, '/profile')
      }
    }

    function deleteForever() {
      const r = getRouter()
      maybeCloseDrawer('/wipe-wallet')
      if (r) {
        return openPage(r, '/wipe-wallet')
      }
    }

    function openChangelog() {
      const r = getRouter()
      maybeCloseDrawer('/changelog')
      if (r) {
        return r.push('/changelog').catch(() => {
          // Don't care. Probably duplicate route
        })
      }
    }

    function openDocs() {
      const r = getRouter()
      maybeCloseDrawer('/docs')
      if (r) {
        return r.push('/docs').catch(() => {
          // Don't care. Probably duplicate route
        })
      }
    }

    onMounted(async () => {
      try {
        myAddress.value = (await useActiveWallet()).identity.displayAddress
      } catch {
        // The setup route may render this panel before a seed exists.
      }
    })

    const drawerOpenModel = computed({
      get: () => props.drawerOpen,
      set: (value: boolean) => emit('update:drawerOpen', value),
    })

    return {
      legacyLotusMode: legacyLotusModeEnabled(),
      profile,
      inbox,
      myAddress,
      openSettings,
      openBackup,
      openBackupDialog: openBackup,
      openProfile,
      deleteForever,
      openChangelog,
      openDocs,
      drawerOpenModel,
    }
  },
})
</script>
