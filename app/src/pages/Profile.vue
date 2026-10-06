<template>
  <q-page-container>
    <q-page class="q-ma-none q-pa-sm">
      <q-card>
        <q-card-section>
          <div class="text-h6">
            {{ $t('profileDialog.profile') }}
          </div>
        </q-card-section>
        <profile
          v-model:name="name"
          v-model:bio="bio"
          v-model:avatar="avatar"
          v-model:acceptancePrice="acceptancePrice"
        />
        <q-card-actions align="right">
          <q-btn
            :label="$t('profileDialog.cancel')"
            color="negative"
            flat
            no-caps
            data-test="profile-cancel"
            @click="cancel"
          />
          <q-btn
            :label="
              identical
                ? $t('profileDialog.republish')
                : $t('profileDialog.update')
            "
            color="primary"
            no-caps
            data-test="profile-update"
            @click="updateRelayData"
          />
        </q-card-actions>
      </q-card>
    </q-page>
  </q-page-container>
</template>

<script lang="ts">
import { defineComponent } from 'vue'

import { useProfileStore } from 'src/stores/my-profile'
import { useActiveWallet } from 'src/composables/useActiveWallet'
import { loadMonadChainConfigFromEnv } from '@frank/wallet/chain/monad-chain'
import {
  MonadIdentity,
  registerMonadIdentityCbor,
} from '@frank/wallet/monad-identity'

import { validateProfileDisplayName } from '@frank/wallet/profile-display-name'
import { profileNameError } from '../utils/profile-name'
import { isAvatarTooLarge, compressAvatarDataUrl } from '../utils/avatar'
import Profile from '../components/Profile.vue'
import { errorNotify } from '../utils/notifications'
import { navigateBack } from '../utils/navigate-back'

type ProfileData = {
  name?: string
  bio?: string
  avatar?: string
}

type RelayData = {
  profile: ProfileData
  inbox: {
    acceptancePrice?: number
  }
}

export default defineComponent({
  components: {
    Profile,
  },
  setup() {
    const myProfile = useProfileStore()
    return {
      setRelayData: myProfile.setRelayData,
      storedRelayData: myProfile,
    }
  },
  data() {
    const myProfile = useProfileStore()

    return {
      name: myProfile.profile.name,
      bio: myProfile.profile.bio,
      avatar: myProfile.profile.avatar,
      acceptancePrice: myProfile.inbox.acceptancePrice,
    }
  },
  computed: {
    profile(): ProfileData {
      return {
        name: this.name,
        bio: this.bio,
        avatar: this.avatar,
      }
    },
    relayData(): RelayData {
      return {
        profile: this.profile,
        inbox: {
          acceptancePrice: this.acceptancePrice,
        },
      }
    },
    identical(): boolean {
      const currentProfile = this.storedRelayData.profile
      const currentInbox = this.storedRelayData.inbox
      return (
        (currentProfile.name ?? '') === (this.name ?? '') &&
        (currentProfile.bio ?? '') === (this.bio ?? '') &&
        (currentProfile.avatar ?? '') === (this.avatar ?? '') &&
        (currentInbox.acceptancePrice ?? 0) === (this.acceptancePrice ?? 0)
      )
    },
  },
  methods: {
    async updateRelayData() {
      // Validate before any network work so a bad name is reported as such, not as a relay failure.
      const name = validateProfileDisplayName(this.name ?? '')
      const nameError = profileNameError(this.name ?? '', (key, params) =>
        this.$t(key, params ?? {}),
      )
      if (nameError !== undefined) {
        errorNotify(new Error('invalid profile name'), {
          safeMessage: nameError,
        })
        return
      }
      this.name = name.normalized

      // Avatar validation and compression before submitting
      if (this.avatar && isAvatarTooLarge(this.avatar)) {
        try {
          this.avatar = await compressAvatarDataUrl(this.avatar)
        } catch {
          // compression failed
        }
      }
      if (this.avatar && isAvatarTooLarge(this.avatar)) {
        errorNotify(new Error('avatar too large'), {
          fallbackKey: 'profileDialog.avatarTooLarge',
        })
        return
      }

      // Save locally to store first
      this.setRelayData(this.relayData)

      // Set profile on relay if wallet is available
      this.$q.loading.show({
        delay: 100,
        message: this.$t('profileDialog.pushingProfile'),
      })

      try {
        let wallet
        try {
          wallet = await useActiveWallet()
        } catch {
          // No active wallet: local profile updated, nothing to publish to relay
        }
        if (wallet && wallet.identity) {
          const cfg = loadMonadChainConfigFromEnv()
          await registerMonadIdentityCbor({
            relayBaseUrl:
              (wallet as { relayBaseUrl?: string }).relayBaseUrl ??
              cfg.relayBaseUrl,
            identity: wallet.identity as MonadIdentity,
            profile: this.relayData.profile,
          })
        }
      } catch (err: unknown) {
        console.error(err)
        const axiosErr = err as { response?: { status?: number } }
        if (axiosErr.response?.status === 413) {
          errorNotify(err, { fallbackKey: 'profileDialog.avatarTooLarge' })
          return
        }
        errorNotify(err, { fallbackKey: 'profileDialog.unableContactRelay' })
        return
      } finally {
        this.$q.loading.hide()
      }
      navigateBack(this.$router)
    },
    cancel() {
      navigateBack(this.$router)
    },
  },
})
</script>
