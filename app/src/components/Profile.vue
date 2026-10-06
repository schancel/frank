<template>
  <div class="full-height column">
    <q-splitter v-model="splitterSize" unit="px" disable class="col full-height">
      <template #before>
        <q-tabs v-model="tab" vertical class="text-primary full-height">
          <q-tab
            name="profile"
            icon="person"
            :label="$t('profileDialog.profile')"
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
                <div class="q-pa-md">
                  <div
                    class="text-subtitle2 text-weight-medium q-mb-sm row items-center justify-between"
                  >
                    <span>{{ $t('profile.links') }}</span>
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
                </div>
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

import { normalizedProfileName, profileNameRule } from '../utils/profile-name'
import { defaultAvatars } from '../utils/constants'
import { resizeAndCompressImage, compressAvatarFile } from '../utils/avatar'
import { validateProfileUsername } from '@frank/wallet/monad-identity'

export type ProfileLinkItem = {
  type: string
  url: string
  label?: string
}

export default defineComponent({
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
  },
  emits: [
    'update:name',
    'update:username',
    'update:location',
    'update:bio',
    'update:avatar',
    'update:acceptancePrice',
    'update:links',
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
      avatarPath: null,
      tab: 'profile',
      defaultAvatarIndex: Math.floor(Math.random() * defaultAvatars.length),
    }
  },
  computed: {
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
      // Ticket #51's Vite migration missed this: webpack's dynamic `require()` for a resolved
      // asset URL has no equivalent under Vite (no global `require` exists in dev at all) --
      // `new URL(..., import.meta.url)` is Vite's native replacement, statically analyzable
      // for a bounded-directory template literal like this one.
      img.src = new URL(`../assets/avatars/${name}`, import.meta.url).href
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
      this.internalLinks.push({
        type: 'website',
        url: '',
        label: '',
      })
    },
    removeLink(index: number) {
      this.internalLinks.splice(index, 1)
    },
    cycleAvatarRight() {
      this.defaultAvatarIndex =
        (this.defaultAvatarIndex + 1) % defaultAvatars.length
      this.selectLocalAvatar(defaultAvatars[this.defaultAvatarIndex])
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
        this.internalLinks = val ? JSON.parse(JSON.stringify(val)) : []
      },
      deep: true,
    },
    async avatarPath(val: File | null) {
      if (val == null) {
        return
      }
      try {
        const compressed = await compressAvatarFile(val)
        if (compressed) {
          this.internalAvatar = compressed
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
  },
})
</script>
