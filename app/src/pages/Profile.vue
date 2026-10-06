<template>
  <q-page-container>
    <q-page class="q-ma-none q-pa-none column full-height">
      <q-card flat class="col column full-width full-height bg-transparent">
        <q-card-section class="q-px-md q-pt-md q-pb-none">
          <div class="text-h6">
            {{ $t('profileDialog.profile') }}
          </div>
        </q-card-section>
        <profile
          v-model:name="name"
          v-model:username="username"
          v-model:location="location"
          v-model:bio="bio"
          v-model:avatar="avatar"
          v-model:links="links"
          v-model:acceptancePrice="acceptancePrice"
          class="col full-height"
        />
        <q-separator />
        <q-card-actions align="right" class="q-pa-md bg-transparent">
          <q-btn
            :label="$t('profileDialog.cancel')"
            color="negative"
            flat
            no-caps
            data-test="profile-cancel"
            class="q-mr-sm"
            @click="cancel"
          />
          <q-btn
            :label="
              identical
                ? $t('profileDialog.republish')
                : $t('profileDialog.update')
            "
            color="primary"
            unelevated
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
  validateProfileUsername,
} from '@frank/wallet/monad-identity'

import { validateProfileDisplayName } from '@frank/wallet/profile-display-name'
import { profileNameError } from '../utils/profile-name'
import { isAvatarTooLarge, compressAvatarDataUrl } from '../utils/avatar'
import Profile, { type ProfileLinkItem } from '../components/Profile.vue'
import { errorNotify } from '../utils/notifications'
import { navigateBack } from '../utils/navigate-back'

type ProfileData = {
  name?: string
  username?: string
  location?: string
  bio?: string
  avatar?: string
  links?: ProfileLinkItem[]
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
      username: myProfile.profile.username,
      location: myProfile.profile.location,
      bio: myProfile.profile.bio,
      avatar: myProfile.profile.avatar,
      links: myProfile.profile.links
        ? (JSON.parse(
            JSON.stringify(myProfile.profile.links),
          ) as ProfileLinkItem[])
        : [],
      acceptancePrice: myProfile.inbox.acceptancePrice,
    }
  },
  computed: {
    profile(): ProfileData {
      return {
        name: this.name,
        username: this.username,
        location: this.location,
        bio: this.bio,
        avatar: this.avatar,
        links: this.links,
      }
    },
    relayData(): RelayData {
      const validLinks = (this.links ?? [])
        .filter((l) => l.url && l.url.trim().length > 0)
        .map((l) => ({
          type: l.type.trim(),
          url: l.url.trim(),
          ...(l.label && l.label.trim() ? { label: l.label.trim() } : {}),
        }))

      return {
        profile: {
          name: this.name,
          username: this.username || undefined,
          location: this.location || undefined,
          bio: this.bio,
          avatar: this.avatar,
          ...(validLinks.length > 0 ? { links: validLinks } : {}),
        },
        inbox: {
          acceptancePrice: this.acceptancePrice,
        },
      }
    },
    identical(): boolean {
      const currentProfile = this.storedRelayData.profile
      const currentInbox = this.storedRelayData.inbox
      const currentLinksJson = JSON.stringify(currentProfile.links ?? [])
      const newLinksJson = JSON.stringify(
        (this.links ?? []).filter((l) => l.url && l.url.trim().length > 0),
      )
      return (
        (currentProfile.name ?? '') === (this.name ?? '') &&
        (currentProfile.username ?? '') === (this.username ?? '') &&
        (currentProfile.location ?? '') === (this.location ?? '') &&
        (currentProfile.bio ?? '') === (this.bio ?? '') &&
        (currentProfile.avatar ?? '') === (this.avatar ?? '') &&
        currentLinksJson === newLinksJson &&
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

      // Validate username if entered
      if (this.username && this.username.trim()) {
        const usernameResult = validateProfileUsername(this.username)
        if (!usernameResult.valid) {
          errorNotify(new Error('invalid username'), {
            safeMessage: this.$t('profile.invalidUsername'),
          })
          return
        }
        this.username = usernameResult.normalized
      }

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
