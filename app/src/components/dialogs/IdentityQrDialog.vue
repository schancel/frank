<template>
  <q-dialog
    :model-value="modelValue"
    data-test="identity-qr-dialog"
    @update:model-value="$emit('update:modelValue', $event)"
  >
    <q-card
      style="min-width: 320px; max-width: 440px"
      class="q-pa-sm"
      data-test="identity-qr-card"
    >
      <q-card-section class="row items-center q-pb-none">
        <div class="text-h6 text-weight-bold">
          {{ $t('profileDialog.identityHeading') }}
        </div>
        <q-space />
        <q-btn
          icon="close"
          flat
          round
          dense
          v-close-popup
          :aria-label="$t('close')"
          data-test="identity-qr-close"
        />
      </q-card-section>

      <q-card-section class="text-center q-py-sm">
        <q-avatar size="64px" class="q-mb-xs shadow-1">
          <img v-if="avatarSrc" :src="avatarSrc" />
          <q-icon v-else name="person" size="40px" color="primary" />
        </q-avatar>
        <div
          class="text-subtitle1 text-weight-bold"
          data-test="identity-qr-name"
        >
          {{ displayName }}
        </div>
        <div v-if="displayUsername" data-test="identity-qr-username">
          <username-handle :username="displayUsername" />
        </div>
        <div class="text-caption text-grey-8 q-mt-xs">
          {{ $t('profileDialog.identitySubheading') }}
        </div>
      </q-card-section>

      <q-card-section class="row justify-center items-center q-py-sm">
        <div
          class="q-pa-sm bg-white rounded-borders shadow-1 text-center"
          data-test="identity-qr-container"
        >
          <qrcode-vue
            v-if="resolvedAddress"
            :value="resolvedAddress"
            :size="220"
            level="H"
            data-test="identity-qr-code"
          />
          <q-skeleton v-else size="220px" square />
          <div class="text-caption text-grey-6 q-mt-xs">
            {{ $t('profileDialog.scanPrompt') }}
          </div>
        </div>
      </q-card-section>

      <q-card-section class="q-py-xs">
        <div class="text-caption text-weight-medium text-grey-8 q-mb-xs">
          {{ $t('profileDialog.identityAddressLabel') }}
        </div>
        <q-input
          dense
          outlined
          readonly
          v-model="resolvedAddress"
          data-test="identity-address-input"
        >
          <template #append>
            <q-btn
              flat
              dense
              round
              icon="content_copy"
              color="primary"
              :aria-label="$t('a11y.copyAddress')"
              :disable="!resolvedAddress"
              data-test="copy-identity-address-btn"
              @click="copyAddress"
            />
          </template>
        </q-input>
      </q-card-section>

      <q-card-section class="q-py-xs">
        <q-banner rounded dense class="bg-grey-2 text-grey-8 text-caption">
          <template #avatar>
            <q-icon name="info" color="primary" size="sm" />
          </template>
          {{ $t('profileDialog.receiveAddressHint') }}
          <div class="q-mt-xs">
            <q-btn
              flat
              dense
              no-caps
              size="sm"
              color="primary"
              :label="$t('profileDialog.goToWallet')"
              data-test="identity-dialog-goto-wallet"
              @click="goToWallet"
            />
          </div>
        </q-banner>
      </q-card-section>

      <q-card-actions align="right" class="q-pt-sm">
        <q-btn flat :label="$t('close')" color="primary" v-close-popup />
      </q-card-actions>
    </q-card>
  </q-dialog>
</template>

<script lang="ts">
import { computed, defineComponent, getCurrentInstance, ref, watch } from 'vue'
import QrcodeVue from 'qrcode.vue'
import { copyToClipboard } from 'quasar'
import { getOwnCanonicalAddress } from 'src/utils/own-address'
import { addressCopiedNotify, errorNotify } from 'src/utils/notifications'
import { ownUsername } from 'src/utils/own-username'
import UsernameHandle from 'src/components/contacts/UsernameHandle.vue'

export default defineComponent({
  name: 'IdentityQrDialog',
  components: {
    QrcodeVue,
    UsernameHandle,
  },
  props: {
    modelValue: {
      type: Boolean,
      required: true,
    },
    address: {
      type: String,
      default: '',
    },
    name: {
      type: String,
      default: '',
    },
    avatar: {
      type: String,
      default: '',
    },
  },
  emits: ['update:modelValue', 'go-to-wallet'],
  setup(props, { emit }) {
    const instance = getCurrentInstance()
    const internalAddress = ref('')
    const internalProfile = ref<{
      name?: string
      avatar?: string
    }>({})

    watch(
      () => [props.modelValue, props.address],
      async ([isOpen, directAddr]) => {
        if (directAddr && typeof directAddr === 'string') {
          internalAddress.value = directAddr
          return
        }
        if (isOpen) {
          if (!internalAddress.value) {
            try {
              const canonical = await getOwnCanonicalAddress()
              if (canonical) {
                internalAddress.value = canonical
              }
            } catch {
              // ignore
            }
          }
          if (!props.name && !props.avatar) {
            try {
              const { useProfileStore } = await import('src/stores/my-profile')
              const p = useProfileStore()?.profile
              if (p) {
                internalProfile.value = {
                  name: p.name,
                  avatar: p.avatar,
                }
              }
            } catch {
              // ignore
            }
          }
        }
      },
      { immediate: true },
    )

    const resolvedAddress = computed(
      () => props.address || internalAddress.value,
    )

    const displayName = computed(() => {
      return props.name || internalProfile.value.name || 'You'
    })

    // Only the name the relay confirms this account holds, never the one merely saved.
    const displayUsername = computed(() => ownUsername.held ?? '')

    const avatarSrc = computed(
      () => props.avatar || internalProfile.value.avatar || '',
    )

    return {
      resolvedAddress,
      displayName,
      displayUsername,
      avatarSrc,
      async copyAddress() {
        if (!resolvedAddress.value) return
        try {
          await copyToClipboard(resolvedAddress.value)
          addressCopiedNotify()
        } catch (err) {
          errorNotify(err, {
            fallbackKey: 'receiveBitcoinDialog.unableCopyAddress',
          })
        }
      },
      goToWallet() {
        emit('update:modelValue', false)
        emit('go-to-wallet')
        const router = (
          instance?.proxy as
            | { $router?: { push: (path: string) => void } }
            | undefined
        )?.$router
        if (router) {
          void router.push('/wallet')
        }
      },
    }
  },
})
</script>
