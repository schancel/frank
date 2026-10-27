<template>
  <div class="profile-container column full-height overflow-hidden">
    <q-header>
      <q-toolbar class="q-pl-sm">
        <q-btn
          flat
          dense
          class="q-px-sm"
          icon="arrow_back"
          :aria-label="$t('settings.back')"
          data-test="profile-back"
          @click="cancel"
        />
        <q-toolbar-title class="h6">{{
          $t('profileDialog.profile')
        }}</q-toolbar-title>
        <extension-popout-btn />
        <!-- Phones: back only; the navigation menu belongs to top-level pages. -->
        <q-btn
          v-if="!narrow"
          flat
          dense
          class="q-px-sm"
          icon="menu"
          :aria-label="$t('settings.openMenu')"
          data-test="profile-menu"
          @click="$emit('toggleMyDrawerOpen')"
        />
      </q-toolbar>
    </q-header>
    <q-page-container class="col full-height overflow-hidden">
      <q-page
        class="q-ma-none q-pa-none column no-wrap col full-height overflow-hidden"
        :style-fn="pageStyle"
      >
        <q-card
          flat
          class="profile-card col column full-width full-height bg-transparent"
        >
          <own-profile-unchecked-notice save-waits />
          <profile
            v-model:name="name"
            v-model:username="username"
            :username-error="usernameError"
            :held-username="heldUsername"
            v-model:location="location"
            v-model:bio="bio"
            v-model:avatar="avatar"
            v-model:links="links"
            v-model:acceptancePrice="acceptancePrice"
            v-model:accountType="accountType"
            v-model:botRole="botRole"
            class="profile-body col"
          />
          <q-separator />
          <q-card-actions
            align="right"
            class="profile-actions q-pa-md bg-transparent"
          >
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
              :disable="profileUnchecked"
              @click="updateRelayData"
            />
          </q-card-actions>
        </q-card>
      </q-page>
    </q-page-container>
  </div>
</template>

<script lang="ts">
import {
  type AccountType,
  type BotRole,
  ACCOUNT_TYPE_PERSON,
  ACCOUNT_TYPE_BOT,
  ACCOUNT_TYPE_SERVICE,
  ACCOUNT_TYPE_ORGANIZATION,
  BOT_ROLE_GENERIC,
  BOT_ROLE_ASSISTANT,
  BOT_ROLE_FAUCET,
  BOT_ROLE_GAME,
  BOT_ROLE_BRIDGE,
  BOT_ROLE_MERCHANT,
  BOT_ROLE_MODERATOR,
  BOT_ROLE_ANNOUNCER,
} from '@frank/codec'
import { defineComponent } from 'vue'
import { accountStatus } from '../accounts/session'
import { viewportPageStyle } from 'src/utils/layout'

import { useProfileStore } from 'src/stores/my-profile'
import { useActiveWallet } from 'src/composables/useActiveWallet'
import { loadMonadChainConfigFromEnv } from '@frank/wallet/chain/evm-chain'
import {
  MonadIdentity,
  type MonadProfileFields,
  validateProfileUsername,
} from '@frank/wallet/evm-identity'

import { validateProfileDisplayName } from '@frank/wallet/profile-display-name'
import { profileNameError } from '../utils/profile-name'
import { isAvatarTooLarge, compressAvatarDataUrl } from '../utils/avatar'
import { downscaleImage } from '../utils/image-resize'
import Profile, { type ProfileLinkItem } from '../components/Profile.vue'
import { errorNotify } from '../utils/notifications'
import { goBack } from '../utils/navigation'
import { claimOwnUsername, usernameErrorKey } from '../utils/username-claim'
import { ownUsername, setOwnUsername } from '../utils/own-username'

function isAccountType(value: unknown): value is AccountType {
  return (
    value === ACCOUNT_TYPE_PERSON ||
    value === ACCOUNT_TYPE_BOT ||
    value === ACCOUNT_TYPE_SERVICE ||
    value === ACCOUNT_TYPE_ORGANIZATION
  )
}
function isBotRole(value: unknown): value is BotRole {
  return (
    value === BOT_ROLE_GENERIC ||
    value === BOT_ROLE_ASSISTANT ||
    value === BOT_ROLE_FAUCET ||
    value === BOT_ROLE_GAME ||
    value === BOT_ROLE_BRIDGE ||
    value === BOT_ROLE_MERCHANT ||
    value === BOT_ROLE_MODERATOR ||
    value === BOT_ROLE_ANNOUNCER
  )
}

type ProfileData = {
  name?: string
  username?: string
  location?: string
  bio?: string
  avatar?: string
  links?: ProfileLinkItem[]
  accountType?: number
  botRole?: number
}

/** The form's fields as one comparable value (JSON): which fields the form still shows as they
 * were loaded. */
function formFields(profile: ProfileData): string {
  return JSON.stringify({
    name: profile.name ?? '',
    username: profile.username ?? '',
    location: profile.location ?? '',
    bio: profile.bio ?? '',
    avatar: profile.avatar ?? '',
    links: (profile.links ?? []).map(link => ({
      type: link.type,
      url: link.url,
      label: link.label ?? '',
    })),
    accountType: profile.accountType ?? ACCOUNT_TYPE_PERSON,
    botRole: profile.botRole,
  })
}

type RelayData = {
  profile: MonadProfileFields
  inbox: {
    acceptancePrice?: number
  }
}

import ExtensionPopoutBtn from 'src/components/navigation/ExtensionPopoutBtn.vue'
import OwnProfileUncheckedNotice from 'src/components/OwnProfileUncheckedNotice.vue'
import { ownProfileCheck, syncOwnProfileWithRelay } from 'src/utils/own-profile'
import { isNarrowWidth } from 'src/utils/layout'
import { getEffectiveScreenWidth } from 'src/utils/mobile-viewport-scale'

export default defineComponent({
  emits: ['toggleMyDrawerOpen'],
  components: {
    Profile,
    ExtensionPopoutBtn,
    OwnProfileUncheckedNotice,
  },
  setup() {
    const myProfile = useProfileStore()
    return {
      pageStyle: viewportPageStyle,
      setRelayData: myProfile.setRelayData,
      storedRelayData: myProfile,
    }
  },
  data() {
    const myProfile = useProfileStore()

    return {
      profileOwner: myProfile.owner,
      profileRevision: accountStatus.revision,
      name: myProfile.profile.name,
      username: myProfile.profile.username,
      // A saved name the relay refused to give back at startup is said so on the field.
      usernameError:
        ownUsername.problem && ownUsername.wanted === myProfile.profile.username
          ? this.$t(ownUsername.problem)
          : '',
      location: myProfile.profile.location,
      bio: myProfile.profile.bio,
      avatar: myProfile.profile.avatar,
      links: myProfile.profile.links
        ? (JSON.parse(
            JSON.stringify(myProfile.profile.links),
          ) as ProfileLinkItem[])
        : [],
      acceptancePrice: myProfile.inbox.acceptancePrice,
      accountType:
        myProfile.profile.accountType === undefined
          ? ACCOUNT_TYPE_PERSON
          : myProfile.profile.accountType,
      botRole: myProfile.profile.botRole,
      /** What the form was last loaded with (`formFields`). */
      loadedFields: formFields(myProfile.profile as ProfileData),
    }
  },
  computed: {
    narrow(): boolean {
      const raw =
        (this as { $q?: { screen?: { width?: number } } }).$q?.screen?.width ??
        (typeof window !== 'undefined' ? window.innerWidth : 1024)
      return isNarrowWidth(getEffectiveScreenWidth(raw))
    },
    /** The relay has not answered for this account's published profile yet. An edit saved now
     * would replace a profile this device has not seen, so saving waits (see own-profile.ts). */
    profileUnchecked(): boolean {
      return (
        ownProfileCheck.unchecked !== null &&
        ownProfileCheck.unchecked === this.profileOwner?.toLowerCase()
      )
    },
    /** The name the relay confirms this account holds, or '' when it holds none. */
    heldUsername(): string {
      return ownUsername.held ?? ''
    },
    profile(): ProfileData {
      return {
        name: this.name,
        username: this.username,
        location: this.location,
        bio: this.bio,
        avatar: this.avatar,
        links: this.links,
        accountType: this.accountType,
        botRole: this.botRole,
      }
    },
    relayData(): RelayData | undefined {
      const accountType =
        this.accountType === undefined ? ACCOUNT_TYPE_PERSON : this.accountType
      const botRole = this.botRole
      if (
        !isAccountType(accountType) ||
        (botRole !== undefined &&
          (!isBotRole(botRole) ||
            (accountType !== ACCOUNT_TYPE_BOT &&
              accountType !== ACCOUNT_TYPE_SERVICE)))
      )
        return undefined
      const validLinks = (this.links ?? [])
        .filter(l => l.url && l.url.trim().length > 0)
        .map(l => ({
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
          accountType,
          botRole,
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
        (this.links ?? []).filter(l => l.url && l.url.trim().length > 0),
      )
      return (
        (currentProfile.name ?? '') === (this.name ?? '') &&
        (currentProfile.username ?? '') === (this.username ?? '') &&
        (currentProfile.location ?? '') === (this.location ?? '') &&
        (currentProfile.bio ?? '') === (this.bio ?? '') &&
        (currentProfile.avatar ?? '') === (this.avatar ?? '') &&
        (currentProfile.accountType ?? 0) === (this.accountType ?? 0) &&
        (currentProfile.botRole ?? undefined) === (this.botRole ?? undefined) &&
        currentLinksJson === newLinksJson &&
        (currentInbox.acceptancePrice ?? 0) === (this.acceptancePrice ?? 0)
      )
    },
  },
  watch: {
    'profileUnchecked'(unchecked: boolean) {
      // The relay answered: show the profile it holds, which is now this device's copy.
      if (!unchecked) this.loadStoredProfile()
    },
    // The account's profile changed while the form is open (another device published a newer
    // one and this device adopted it): each field the user has not touched shows the new value.
    'storedRelayData.profile': {
      deep: true,
      handler() {
        const loaded = JSON.parse(this.loadedFields) as Record<string, unknown>
        const form = JSON.parse(formFields(this.profile)) as Record<
          string,
          unknown
        >
        const untouched = (field: string) =>
          JSON.stringify(form[field]) === JSON.stringify(loaded[field])
        const stored = this.storedRelayData.profile
        if (untouched('name')) this.name = stored.name
        if (untouched('username')) this.username = stored.username
        if (untouched('location')) this.location = stored.location
        if (untouched('bio')) this.bio = stored.bio
        if (untouched('avatar')) this.avatar = stored.avatar
        if (untouched('links'))
          this.links = stored.links
            ? (JSON.parse(JSON.stringify(stored.links)) as ProfileLinkItem[])
            : []
        if (untouched('accountType'))
          this.accountType =
            stored.accountType === undefined
              ? ACCOUNT_TYPE_PERSON
              : stored.accountType
        if (untouched('botRole')) this.botRole = stored.botRole
        this.loadedFields = formFields(stored as ProfileData)
      },
    },
  },
  methods: {
    loadStoredProfile() {
      const profile = this.storedRelayData.profile
      this.name = profile.name
      this.username = profile.username
      this.location = profile.location
      this.bio = profile.bio
      this.avatar = profile.avatar
      this.links = profile.links
        ? (JSON.parse(JSON.stringify(profile.links)) as ProfileLinkItem[])
        : []
      this.accountType =
        profile.accountType === undefined
          ? ACCOUNT_TYPE_PERSON
          : profile.accountType
      this.botRole = profile.botRole
      this.loadedFields = formFields(this.profile)
    },
    profileFormIsCurrent(): boolean {
      const current =
        !!this.profileOwner &&
        this.profileOwner === this.storedRelayData.owner &&
        this.profileRevision === accountStatus.revision
      if (!current)
        errorNotify(new Error('profile account changed'), {
          fallbackKey: 'profileDialog.accountChanged',
        })
      return current
    },
    async updateRelayData() {
      if (this.profileUnchecked || !this.profileFormIsCurrent()) return
      if (!this.relayData) {
        errorNotify(new Error('invalid profile account type or bot role'))
        return
      }
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

      // Avatar downscaling and compression before submitting
      if (this.avatar) {
        try {
          this.avatar = await downscaleImage(this.avatar)
        } catch {
          // ignore downscaling errors and proceed to size validation
        }
      }
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

      const relayData = this.relayData
      if (!relayData) {
        errorNotify(new Error('invalid profile account type or bot role'))
        return
      }
      // Claim the username last of the checks, once nothing local can still stop the save: the
      // relay gives a name to one account only, and a claim that succeeded must not be
      // followed by a local failure that leaves the profile showing the old name. A name that
      // is taken or refused stops the save here, before it is stored or published as ours.
      if (!this.profileFormIsCurrent()) return
      this.usernameError = ''
      if (this.username) {
        try {
          const held = await claimOwnUsername(this.username, this.profileOwner)
          if (!this.profileFormIsCurrent()) return
          setOwnUsername(held)
        } catch (err: unknown) {
          this.usernameError = this.$t(usernameErrorKey(err))
          errorNotify(err, { safeMessage: this.usernameError })
          return
        }
      }

      // Save locally to store first
      if (!this.profileFormIsCurrent()) return
      this.setRelayData(relayData)

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
        if (!this.profileFormIsCurrent()) return
        if (wallet && wallet.identity) {
          if (wallet.identity.address.raw.toLowerCase() !== this.profileOwner) {
            errorNotify(new Error('profile account changed'), {
              fallbackKey: 'profileDialog.accountChanged',
            })
            return
          }
          const cfg = loadMonadChainConfigFromEnv()
          // Published by the one rule every device follows (`own-profile.ts`): what the relay
          // holds is read first, and only the fields edited here are published over it, so a
          // newer edit another device made to another field is kept. Until the relay has the
          // edit it stays marked as this device's to publish, and the next poll sends it.
          const outcome = await syncOwnProfileWithRelay({
            relayBaseUrl:
              (wallet as { relayBaseUrl?: string }).relayBaseUrl ??
              cfg.relayBaseUrl,
            identity: wallet.identity as MonadIdentity,
            network: cfg.rpcChain,
          })
          if (!this.profileFormIsCurrent()) return
          if (outcome === 'unreachable')
            throw new Error('profile relay unreachable')
          this.loadStoredProfile()
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
      if (typeof this.$q.notify === 'function') {
        this.$q.notify({
          type: 'positive',
          message: this.$t('profileDialog.savedNotification'),
          timeout: 2000,
        })
      }
    },
    cancel() {
      goBack(this.$router, '/settings')
    },
  },
})
</script>

<style scoped>
.profile-container {
  width: 100%;
  max-width: 100%;
  height: 100%;
  min-height: 0;
}
.profile-card {
  min-width: 0;
  max-width: 100%;
  min-height: 0;
  overflow: hidden;
}
.profile-body {
  min-width: 0;
  max-width: 100%;
  min-height: 0;
  flex: 1 1 0%;
  overflow: hidden;
}
.profile-actions {
  flex: 0 0 auto;
  flex-shrink: 0;
}
</style>
