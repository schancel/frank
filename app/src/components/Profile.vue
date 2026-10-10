<template>
  <div class="full-height column">
    <q-splitter
      v-model="splitterSize"
      unit="px"
      disable
      class="col full-height"
    >
      <template #before>
        <q-tabs v-model="tab" vertical class="text-primary full-height">
          <q-tab
            name="profile"
            icon="person"
            :label="$t('profileDialog.profile')"
            data-test="profile-tab-edit"
          />
          <q-tab
            name="identity"
            icon="qr_code_2"
            :label="$t('profileDialog.identityQr')"
            data-test="profile-tab-identity"
          />
        </q-tabs>
      </template>
      <template #after>
        <q-tab-panels
          v-model="tab"
          animated
          transition-prev="jump-up"
          transition-next="jump-up"
          class="full-height bg-transparent"
        >
          <q-tab-panel name="profile" class="q-pa-md">
            <div class="row">
              <div class="col">
                <div class="row q-pa-md">
                  <q-input
                    outlined
                    v-model="internalName"
                    :label="$t('profile.name')"
                    :hint="$t('profile.nameHint')"
                    lazy-rules
                    style="width: 100%"
                    :rules="[nameRule]"
                    data-test="profile-input-name"
                  />
                </div>
                <div class="row q-pa-md">
                  <q-input
                    outlined
                    v-model="internalUsername"
                    :label="$t('profile.username')"
                    :hint="$t('profile.usernameHint')"
                    prefix="@"
                    lazy-rules
                    style="width: 100%"
                    :rules="[usernameRule]"
                    :error="usernameError !== ''"
                    :error-message="usernameError"
                    data-test="profile-input-username"
                  />
                </div>
                <div class="row q-pa-md">
                  <q-input
                    outlined
                    v-model="internalLocation"
                    :label="$t('profile.location')"
                    :hint="$t('profile.locationHint')"
                    style="width: 100%"
                    maxlength="100"
                    data-test="profile-input-location"
                  >
                    <template #prepend>
                      <q-icon name="place" />
                    </template>
                  </q-input>
                </div>
                <div class="row q-pa-md">
                  <q-input
                    v-model="internalBio"
                    :label="$t('profile.bio')"
                    :hint="$t('profile.bioHint')"
                    outlined
                    style="width: 100%"
                    autogrow
                    data-test="profile-input-bio"
                  />
                </div>
                <div class="row q-pa-md">
                  <q-select
                    outlined
                    v-model="internalAccountType"
                    :options="accountTypeOptions"
                    emit-value
                    map-options
                    :label="$t('profile.accountType')"
                    :hint="$t('profile.accountTypeHint')"
                    style="width: 100%"
                    data-test="profile-select-account-type"
                  />
                </div>
                <div
                  v-if="internalAccountType === 1 || internalAccountType === 2"
                  class="row q-pa-md"
                >
                  <q-select
                    outlined
                    v-model="internalBotRole"
                    :options="botRoleOptions"
                    emit-value
                    map-options
                    clearable
                    :label="$t('profile.botRole')"
                    :hint="$t('profile.botRoleHint')"
                    style="width: 100%"
                    data-test="profile-select-bot-role"
                  />
                </div>
                <div class="q-pa-md">
                  <div class="row items-center justify-between q-mb-sm">
                    <span class="text-subtitle2 text-weight-medium">{{
                      $t('profile.links')
                    }}</span>
                    <q-btn
                      outline
                      dense
                      size="sm"
                      color="primary"
                      icon="add"
                      :label="$t('profile.addLink')"
                      no-caps
                      data-test="profile-add-link"
                      @click="addLink"
                    />
                  </div>
                  <div
                    v-for="(link, index) in internalLinks"
                    :key="index"
                    class="q-mb-sm row q-col-gutter-xs items-center"
                    data-test="profile-link-row"
                  >
                    <div class="col-12 col-sm-3">
                      <q-select
                        outlined
                        dense
                        v-model="link.type"
                        :options="linkTypeOptions"
                        emit-value
                        map-options
                        :label="$t('profile.linkType')"
                        data-test="profile-link-type"
                      />
                    </div>
                    <div class="col-12 col-sm-5">
                      <q-input
                        outlined
                        dense
                        v-model="link.url"
                        :placeholder="$t('profile.linkUrl')"
                        data-test="profile-link-url"
                      />
                    </div>
                    <div class="col-10 col-sm-3">
                      <q-input
                        outlined
                        dense
                        v-model="link.label"
                        :placeholder="$t('profile.linkLabel')"
                        data-test="profile-link-label"
                      />
                    </div>
                    <div class="col-2 col-sm-1 text-center">
                      <q-btn
                        flat
                        round
                        dense
                        color="negative"
                        icon="delete"
                        :aria-label="$t('profile.removeLink')"
                        data-test="profile-remove-link"
                        @click="removeLink(index)"
                      />
                    </div>
                  </div>
                </div>
              </div>
              <div class="col-4 q-pa-md">
                <q-toolbar
                  class="bg-primary text-white shadow-2"
                  style="border-radius: 10px 10px 0px 0px"
                >
                  <q-toolbar-title>{{
                    $t('profile.uploadAvatar')
                  }}</q-toolbar-title>
                  <q-file
                    ref="filePicker"
                    v-model="avatarPath"
                    filled
                    style="display: none"
                  />
                  <q-btn
                    type="file"
                    flat
                    round
                    dense
                    icon="add_a_photo"
                    :aria-label="$t('a11y.choosePhoto')"
                    @click="$refs.filePicker.$el.click()"
                  />
                </q-toolbar>
                <div>
                  <q-img :src="internalAvatar" spinner-color="white" />
                  <div class="text-center">
                    <q-btn
                      flat
                      icon="navigate_before"
                      :aria-label="$t('a11y.previousAvatar')"
                      color="black"
                      @click="cycleAvatarLeft"
                    />
                    <q-btn
                      flat
                      icon="navigate_next"
                      :aria-label="$t('a11y.nextAvatar')"
                      color="black"
                      @click="cycleAvatarRight"
                    />
                  </div>
                  <div class="q-mt-sm text-center">
                    <q-btn
                      outline
                      color="primary"
                      icon="qr_code_2"
                      :label="$t('profileDialog.viewIdentityQr')"
                      class="full-width"
                      data-test="profile-quick-qr-btn"
                      @click="tab = 'identity'"
                    />
                  </div>
                </div>
              </div>
            </div>
          </q-tab-panel>

          <q-tab-panel
            name="identity"
            class="q-pa-md"
            data-test="profile-panel-identity"
          >
            <div class="row q-col-gutter-lg items-center">
              <div class="col-12 col-md-5 text-center">
                <div
                  class="q-pa-md bg-white rounded-borders shadow-2 inline-block"
                  data-test="profile-identity-qr-container"
                >
                  <qrcode-vue
                    v-if="resolvedIdentityAddress"
                    :value="resolvedIdentityAddress"
                    :size="240"
                    level="H"
                    data-test="profile-identity-qr"
                  />
                  <q-skeleton v-else size="240px" square />
                </div>
                <div class="text-caption text-grey-7 q-mt-sm">
                  {{ $t('profileDialog.scanPrompt') }}
                </div>
              </div>
              <div class="col-12 col-md-7">
                <div class="text-h5 text-weight-bold text-primary q-mb-xs">
                  {{ internalName || $t('profile.unnamed') }}
                </div>
                <div
                  v-if="internalUsername"
                  class="text-subtitle1 text-grey-7 q-mb-md"
                >
                  @{{ internalUsername }}
                </div>

                <div class="q-mb-md">
                  <div class="text-subtitle2 text-weight-medium q-mb-xs">
                    {{ $t('profileDialog.identityAddressLabel') }}
                  </div>
                  <q-input
                    outlined
                    readonly
                    v-model="resolvedIdentityAddress"
                    data-test="profile-identity-address-input"
                  >
                    <template #append>
                      <q-btn
                        flat
                        round
                        dense
                        icon="content_copy"
                        color="primary"
                        :aria-label="$t('a11y.copyAddress')"
                        :disable="!resolvedIdentityAddress"
                        data-test="profile-copy-identity-btn"
                        @click="copyIdentityAddress"
                      />
                    </template>
                  </q-input>
                  <div class="text-caption text-grey-8 q-mt-xs">
                    {{ $t('profileDialog.identityExplanation') }}
                  </div>
                </div>

                <q-card flat bordered class="q-pa-sm bg-grey-1">
                  <div class="row items-center no-wrap">
                    <q-icon
                      name="account_balance_wallet"
                      color="primary"
                      size="md"
                      class="q-mr-sm"
                    />
                    <div>
                      <div class="text-caption text-weight-bold">
                        {{ $t('profileDialog.receiveVsIdentityTitle') }}
                      </div>
                      <div class="text-caption text-grey-8">
                        {{ $t('profileDialog.receiveVsIdentityBody') }}
                      </div>
                    </div>
                  </div>
                  <div class="row justify-end q-mt-xs">
                    <q-btn
                      flat
                      dense
                      no-caps
                      color="primary"
                      icon-right="arrow_forward"
                      :label="$t('profileDialog.goToWallet')"
                      data-test="profile-goto-wallet"
                      @click="navigateToWallet"
                    />
                  </div>
                </q-card>
              </div>
            </div>
          </q-tab-panel>
        </q-tab-panels>
      </template>
    </q-splitter>
  </div>
</template>

<script lang="ts">
import { defineComponent, type PropType } from 'vue'
import QrcodeVue from 'qrcode.vue'
import { copyToClipboard } from 'quasar'

import { normalizedProfileName, profileNameRule } from '../utils/profile-name'
import { defaultAvatars } from '../utils/constants'
import { resizeAndCompressImage, compressAvatarDataUrl } from '../utils/avatar'
import { downscaleImage } from '../utils/image-resize'
import { validateProfileUsername } from '@frank/wallet/monad-identity'
import { getOwnCanonicalAddress } from '../utils/own-address'
import { addressCopiedNotify, errorNotify } from '../utils/notifications'

export type ProfileLinkItem = {
  type: string
  url: string
  label?: string
}

export default defineComponent({
  components: {
    QrcodeVue,
  },
  setup() {
    return {}
  },
  props: {
    name: {
      type: String,
      default: () => '',
    },
    username: {
      type: String,
      default: () => '',
    },
    /** Why the relay refused this username (taken, not valid), shown under the field. */
    usernameError: {
      type: String,
      default: '',
    },
    location: {
      type: String,
      default: () => '',
    },
    bio: {
      type: String,
      default: () => '',
    },
    avatar: {
      type: String,
      default: () => '',
    },
    acceptancePrice: {
      type: Number,
      default: () => 0,
    },
    links: {
      type: Array as PropType<ProfileLinkItem[]>,
      default: () => [],
    },
    identityAddress: {
      type: String,
      default: '',
    },
    accountType: {
      type: Number,
      default: 0,
    },
    botRole: {
      type: Number,
      default: undefined,
    },
  },
  emits: [
    'update:name',
    'update:username',
    'update:location',
    'update:bio',
    'update:avatar',
    'update:acceptancePrice',
    'update:links',
    'update:accountType',
    'update:botRole',
  ],
  data() {
    return {
      splitterSize: 110,
      internalAvatar: this.avatar as string | ArrayBuffer,
      internalBio: this.bio,
      internalName: this.name,
      internalUsername: this.username,
      internalLocation: this.location,
      internalLinks: (this.links
        ? JSON.parse(JSON.stringify(this.links))
        : []) as ProfileLinkItem[],
      internalAcceptancePrice: this.acceptancePrice,
      internalIdentityAddress: this.identityAddress,
      internalAccountType: this.accountType ?? 0,
      internalBotRole: this.botRole,
      avatarPath: null,
      tab: 'profile',
      defaultAvatarIndex: Math.floor(Math.random() * defaultAvatars.length),
    }
  },
  computed: {
    resolvedIdentityAddress(): string {
      return this.identityAddress || this.internalIdentityAddress
    },
    accountTypeOptions(): Array<{ label: string; value: number }> {
      return [
        { value: 0, label: this.$t('profile.accountTypePerson') },
        { value: 1, label: this.$t('profile.accountTypeBot') },
        { value: 2, label: this.$t('profile.accountTypeService') },
        { value: 3, label: this.$t('profile.accountTypeOrganization') },
      ]
    },
    botRoleOptions(): Array<{ label: string; value: number }> {
      return [
        { value: 0, label: this.$t('profile.botRoleGeneric') },
        { value: 1, label: this.$t('profile.botRoleAssistant') },
        { value: 2, label: this.$t('profile.botRoleFaucet') },
        { value: 3, label: this.$t('profile.botRoleGame') },
        { value: 4, label: this.$t('profile.botRoleBridge') },
        { value: 5, label: this.$t('profile.botRoleMerchant') },
        { value: 6, label: this.$t('profile.botRoleModerator') },
        { value: 7, label: this.$t('profile.botRoleAnnouncer') },
      ]
    },
    linkTypeOptions(): Array<{ label: string; value: string }> {
      return [
        { value: 'website', label: this.$t('profile.linkTypeWebsite') },
        { value: 'x', label: this.$t('profile.linkTypeX') },
        { value: 'github', label: this.$t('profile.linkTypeGithub') },
        { value: 'nostr', label: this.$t('profile.linkTypeNostr') },
        { value: 'telegram', label: this.$t('profile.linkTypeTelegram') },
        { value: 'discord', label: this.$t('profile.linkTypeDiscord') },
        { value: 'other', label: this.$t('profile.linkTypeOther') },
      ]
    },
  },
  methods: {
    selectLocalAvatar(name: string) {
      const img = new Image()
      img.crossOrigin = 'Anonymous'
      img.onload = (e: Event) => {
        const target = e.target as HTMLImageElement
        if (!target) {
          console.error(
            'err finding target in Profile.vue image onload handler',
          )
          return
        }
        const dataURL = resizeAndCompressImage(target)
        if (dataURL) {
          this.internalAvatar = dataURL
        }
      }
      img.onerror = () => {
        console.warn('Failed to load local avatar image', name)
      }
      // Ticket #51's Vite migration missed this: webpack's dynamic `require()` for a resolved
      // asset URL has no equivalent under Vite (no global `require` exists in dev at all) --
      // `new URL(..., import.meta.url)` is Vite's native replacement, statically analyzable
      // for a bounded-directory template literal like this one.
      img.src = new URL(`../assets/avatars/${name}`, import.meta.url).href
      if (img.complete && (img.naturalWidth !== 0 || img.width !== 0)) {
        const dataURL = resizeAndCompressImage(img)
        if (dataURL) {
          this.internalAvatar = dataURL
        }
      }
    },
    cycleAvatarLeft() {
      this.defaultAvatarIndex =
        (this.defaultAvatarIndex - 1 + defaultAvatars.length) %
        defaultAvatars.length
      this.selectLocalAvatar(defaultAvatars[this.defaultAvatarIndex])
    },
    nameRule(val: string): true | string {
      return profileNameRule(val, (key, params) => this.$t(key, params ?? {}))
    },
    usernameRule(val: string): true | string {
      if (!val || !val.trim()) {
        return true
      }
      const res = validateProfileUsername(val)
      if (!res.valid) {
        return this.$t('profile.invalidUsername')
      }
      return true
    },
    addLink() {
      this.internalLinks = [
        ...this.internalLinks,
        {
          type: 'website',
          url: '',
          label: '',
        },
      ]
      this.$emit('update:links', this.internalLinks)
    },
    removeLink(index: number) {
      this.internalLinks = this.internalLinks.filter((_, i) => i !== index)
      this.$emit('update:links', this.internalLinks)
    },
    cycleAvatarRight() {
      this.defaultAvatarIndex =
        (this.defaultAvatarIndex + 1) % defaultAvatars.length
      this.selectLocalAvatar(defaultAvatars[this.defaultAvatarIndex])
    },
    async copyIdentityAddress() {
      if (!this.resolvedIdentityAddress) return
      try {
        await copyToClipboard(this.resolvedIdentityAddress)
        addressCopiedNotify()
      } catch (err) {
        errorNotify(err, {
          fallbackKey: 'receiveBitcoinDialog.unableCopyAddress',
        })
      }
    },
    navigateToWallet() {
      if (this.$router) {
        void this.$router.push('/wallet')
      }
    },
  },
  watch: {
    internalName(value: string) {
      this.$emit('update:name', normalizedProfileName(value))
    },
    internalUsername(value: string) {
      const res = validateProfileUsername(value)
      this.$emit('update:username', res.normalized ?? value.trim())
    },
    internalLocation(value: string) {
      this.$emit('update:location', value)
    },
    internalBio(value: string) {
      this.$emit('update:bio', value)
    },
    internalAvatar(value) {
      this.$emit('update:avatar', value)
    },
    internalAcceptancePrice(value) {
      this.$emit('update:acceptancePrice', value)
    },
    internalLinks: {
      handler(value) {
        this.$emit('update:links', value)
      },
      deep: true,
    },
    name(val: string) {
      if (val !== this.internalName) this.internalName = val
    },
    username(val: string) {
      if (val !== this.internalUsername) this.internalUsername = val
    },
    location(val: string) {
      if (val !== this.internalLocation) this.internalLocation = val
    },
    bio(val: string) {
      if (val !== this.internalBio) this.internalBio = val
    },
    avatar(val: string) {
      if (val !== this.internalAvatar) this.internalAvatar = val
    },
    links: {
      handler(val: ProfileLinkItem[] | undefined) {
        if (JSON.stringify(val ?? []) !== JSON.stringify(this.internalLinks)) {
          this.internalLinks = val ? JSON.parse(JSON.stringify(val)) : []
        }
      },
      deep: true,
    },
    internalAccountType(newVal: number) {
      this.$emit('update:accountType', newVal)
      if (newVal !== 1 && newVal !== 2) {
        this.internalBotRole = undefined
        this.$emit('update:botRole', undefined)
      }
    },
    internalBotRole(newVal: number | undefined) {
      this.$emit('update:botRole', newVal)
    },
    accountType(newVal: number) {
      if (newVal !== this.internalAccountType) {
        this.internalAccountType = newVal ?? 0
      }
    },
    botRole(newVal: number | undefined) {
      if (newVal !== this.internalBotRole) {
        this.internalBotRole = newVal
      }
    },
    async avatarPath(val: File | null) {
      if (val == null) {
        return
      }
      try {
        const downscaled = await downscaleImage(val)
        if (downscaled) {
          try {
            const compressed = await compressAvatarDataUrl(downscaled)
            this.internalAvatar = compressed || downscaled
          } catch {
            this.internalAvatar = downscaled
          }
        }
      } catch (err) {
        console.error('Failed to process avatar file upload', err)
      }
    },
  },
  created() {
    if (!this.avatar) {
      this.selectLocalAvatar(defaultAvatars[this.defaultAvatarIndex])
    }
    if (!this.internalIdentityAddress) {
      void getOwnCanonicalAddress().then(addr => {
        if (addr) {
          this.internalIdentityAddress = addr
        }
      })
    }
  },
})
</script>
