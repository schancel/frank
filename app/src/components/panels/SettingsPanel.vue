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

        <!-- Network / Advanced Settings -->
        <div class="q-px-md q-py-sm" data-test="network-settings-section" data-testid="network-settings-section">
          <div class="text-caption text-weight-bold text-grey-7 q-mb-xs">
            {{ $t('settings.networkSettings', 'Network & Gateway Settings') }}
          </div>
          <q-input
            v-model="emailGatewayInput"
            :label="$t('settings.emailGatewayAddress', 'Email Gateway Address')"
            dense
            outlined
            :error="!!emailGatewayError"
            :error-message="emailGatewayError"
            hint="0x-prefixed 40-character hex address"
            data-test="email-gateway-input"
            data-testid="email-gateway-input"
            class="full-width q-mb-xs text-caption"
          />
          <div
            v-if="emailGatewayError"
            class="text-negative text-caption q-mb-xs error-msg"
            data-test="email-gateway-error"
          >
            {{ emailGatewayError }}
          </div>
          <div class="row items-center justify-end q-gutter-x-sm q-mt-xs">
            <q-btn
              flat
              dense
              no-caps
              size="sm"
              color="grey-7"
              :label="$t('settings.resetDefault', 'Reset to Default')"
              data-test="reset-email-gateway-btn"
              data-testid="reset-email-gateway-btn"
              @click="resetEmailGateway"
            />
            <q-btn
              unelevated
              dense
              no-caps
              size="sm"
              color="primary"
              :label="$t('settings.save', 'Save')"
              data-test="save-email-gateway-btn"
              data-testid="save-email-gateway-btn"
              @click="saveEmailGateway"
            />
          </div>
        </div>
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
  watch,
} from 'vue'
import { useRouter } from 'vue-router'
import { useQuasar } from 'quasar'

import ContactCard from './ContactCard.vue'
import { openPage } from '../../utils/routes'
import { useProfileStore } from 'src/stores/my-profile'
import { useSettingsStore } from 'src/stores/settings'
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

    const settingsStore = useSettingsStore()
    const emailGatewayInput = ref(settingsStore.emailGatewayAddress)
    const emailGatewayError = ref('')

    watch(
      () => settingsStore.emailGatewayAddress,
      newVal => {
        emailGatewayInput.value = newVal
      },
    )

    function saveEmailGateway() {
      emailGatewayError.value = ''
      try {
        settingsStore.setEmailGatewayAddress(emailGatewayInput.value.trim())
        emailGatewayInput.value = settingsStore.emailGatewayAddress
      } catch (err: any) {
        emailGatewayError.value = err?.message || 'Invalid Ethereum address format'
      }
    }

    function resetEmailGateway() {
      emailGatewayError.value = ''
      settingsStore.resetEmailGatewayAddress()
      emailGatewayInput.value = settingsStore.emailGatewayAddress
    }

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
      drawerOpenModel,
      emailGatewayInput,
      emailGatewayError,
      saveEmailGateway,
      resetEmailGateway,
    }
  },
})
</script>
