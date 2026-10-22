<template>
  <q-card flat bordered class="new-group-form" data-test="new-group-form">
    <q-card-section class="row items-center no-wrap q-gutter-x-sm q-pb-sm">
      <q-btn
        data-test="new-group-back"
        flat
        round
        dense
        icon="arrow_back"
        :aria-label="$t('a11y.backToChats')"
        @click="cancel"
      />
      <div class="text-h6 col">{{ $t('groupChat.createGroupTitle') }}</div>
    </q-card-section>

    <q-card-section class="q-pt-none q-gutter-sm">
      <q-input
        v-model="groupName"
        filled
        dense
        autofocus
        :label="$t('groupChat.groupNameLabel')"
        :placeholder="$t('groupChat.groupNamePlaceholder')"
        data-test="group-name-input"
        data-testid="group-name-input"
      />

      <div class="row items-center no-wrap q-gutter-xs">
        <q-input
          v-model="memberFilter"
          filled
          dense
          class="col"
          :label="$t('groupChat.selectMembersLabel')"
          :placeholder="$t('groupChat.searchContactsPlaceholder')"
          data-test="group-member-search"
          @keydown.enter.prevent="tryAddTypedAddress"
        />
        <q-btn
          v-if="canAddTypedAddress"
          dense
          unelevated
          no-caps
          color="primary"
          icon="person_add"
          :label="$t('groupChat.addByAddressBtn')"
          data-test="group-add-address-btn"
          @click="tryAddTypedAddress"
        />
      </div>

      <div
        v-if="selectedAddresses.length > 0"
        class="row items-center q-gutter-xs q-pt-xs"
        data-test="selected-group-members"
      >
        <q-chip
          v-for="addr in selectedAddresses"
          :key="addr"
          removable
          dense
          color="primary"
          text-color="white"
          data-test="selected-group-member-chip"
          @remove="toggleMember(addr)"
        >
          {{ displayMemberLabel(addr) }}
        </q-chip>
      </div>

      <q-list
        v-if="filteredContacts.length > 0"
        bordered
        separator
        dense
        class="rounded-borders"
        style="max-height: 200px; overflow-y: auto"
        data-test="group-contacts-list"
      >
        <q-item
          v-for="entry in filteredContacts"
          :key="entry.address"
          clickable
          data-test="group-contact-item"
          @click="toggleMember(entry.address)"
        >
          <q-item-section side>
            <q-checkbox
              :model-value="isSelected(entry.address)"
              dense
              @click.stop
              @update:model-value="toggleMember(entry.address)"
            />
          </q-item-section>
          <q-item-section>
            <q-item-label class="text-weight-medium">
              {{ entry.name || formatShort(entry.address) }}
            </q-item-label>
            <q-item-label caption class="font-mono">
              {{ formatShort(entry.address) }}
            </q-item-label>
          </q-item-section>
        </q-item>
      </q-list>

      <q-input
        v-model="relayBaseUrl"
        filled
        dense
        :label="$t('groupChat.hostingRelayLabel')"
        data-test="group-relay-input"
      />
    </q-card-section>

    <q-banner
      v-if="creationError"
      class="text-negative"
      role="alert"
      data-test="group-creation-error"
      >{{ creationError }}</q-banner
    >
    <q-card-actions align="right" class="q-px-md q-pb-md">
      <q-btn
        flat
        no-caps
        :label="$t('groupChat.cancel')"
        data-test="cancel-create-group"
        @click="cancel"
      />
      <q-btn
        color="primary"
        unelevated
        no-caps
        :loading="creating"
        :disable="!canSubmit || creating"
        :label="
          creating
            ? $t('groupChat.creatingGroup')
            : $t('groupChat.createGroupBtn')
        "
        data-test="create-group-submit"
        data-testid="create-group-submit"
        @click="submitCreateGroup"
      />
    </q-card-actions>
  </q-card>
</template>

<script lang="ts">
import {
  computed,
  defineComponent,
  ref,
  onBeforeUnmount,
  type PropType,
} from 'vue'
import { useRouter } from 'vue-router'
import { useChatStore } from '../../stores/chats'
import { useContactStore, type ContactState } from '../../stores/contacts'
import {
  isChainAddress,
  toChainDisplayAddress,
} from '../../utils/chain-address'
import { sameCanonicalAddress } from '../../utils/own-address'
import { openChat } from '../../utils/routes'
import { errorNotify } from '../../utils/notifications'
import { shortAddress } from '../../utils/short-address'

export default defineComponent({
  name: 'NewGroupForm',
  props: {
    initialMembers: { type: Array as PropType<string[]>, default: () => [] },
  },
  emits: ['cancel'],
  setup(props, { emit }) {
    const chatStore = useChatStore()
    let contactStore: ReturnType<typeof useContactStore> | null = null
    try {
      contactStore = useContactStore()
    } catch {
      contactStore = null
    }
    const router = useRouter()
    const groupName = ref('')
    const memberFilter = ref('')
    const selectedAddresses = ref<string[]>([...new Set(props.initialMembers)])
    const relayBaseUrl = ref('')
    const creating = ref(false)
    const creationError = ref('')
    try {
      relayBaseUrl.value = chatStore.getGroupHomeRelay()
    } catch (error) {
      creationError.value =
        error instanceof Error ? error.message : String(error)
    }
    let active = true
    onBeforeUnmount(() => {
      active = false
    })

    const allContacts = computed<Array<{ address: string; name: string }>>(
      () => {
        if (!contactStore) return []
        const map = (contactStore.contacts ??
          contactStore.getContacts ??
          {}) as Record<string, ContactState | undefined>
        return Object.entries(map)
          .filter(([, contact]) => Boolean(contact))
          .map(([address, contact]) => ({
            address,
            name: contact?.profile?.name ?? '',
          }))
      },
    )

    const filteredContacts = computed(() => {
      const q = memberFilter.value.trim().toLowerCase()
      if (!q) return allContacts.value
      return allContacts.value.filter(
        c =>
          c.name.toLowerCase().includes(q) ||
          c.address.toLowerCase().includes(q),
      )
    })

    const isSelected = (address: string): boolean =>
      selectedAddresses.value.some(a => sameCanonicalAddress(a, address))

    const toggleMember = (address: string) => {
      const canonical = isChainAddress(address)
        ? toChainDisplayAddress(address)
        : address.trim()
      if (!canonical) return
      const idx = selectedAddresses.value.findIndex(a =>
        sameCanonicalAddress(a, canonical),
      )
      if (idx >= 0) {
        selectedAddresses.value.splice(idx, 1)
      } else {
        selectedAddresses.value.push(canonical)
      }
    }

    const canAddTypedAddress = computed(() => {
      const candidate = memberFilter.value.trim()
      return Boolean(
        candidate && isChainAddress(candidate) && !isSelected(candidate),
      )
    })

    const tryAddTypedAddress = () => {
      const candidate = memberFilter.value.trim()
      if (!candidate || !isChainAddress(candidate)) return
      toggleMember(candidate)
      memberFilter.value = ''
    }

    const canSubmit = computed(() => {
      return Boolean(groupName.value.trim().length > 0)
    })

    const formatShort = (addr: string) => {
      try {
        return shortAddress(addr)
      } catch {
        return addr.length > 12
          ? `${addr.slice(0, 6)}...${addr.slice(-4)}`
          : addr
      }
    }

    const displayMemberLabel = (addr: string) => {
      const found = allContacts.value.find(c =>
        sameCanonicalAddress(c.address, addr),
      )
      return found?.name || formatShort(addr)
    }

    const cancel = () => {
      active = false
      emit('cancel')
    }

    const submitCreateGroup = async () => {
      if (!canSubmit.value || creating.value) return
      creating.value = true
      creationError.value = ''
      try {
        const members = [...selectedAddresses.value]
        if (canAddTypedAddress.value) {
          members.push(toChainDisplayAddress(memberFilter.value.trim()))
        }
        const conv = await chatStore.createGroupConversation({
          groupName: groupName.value.trim(),
          memberAddresses: members,
          relayUrl: relayBaseUrl.value.trim() || undefined,
        })
        // Leaving the page must not redirect a newer draft when creation settles.
        if (!active) return
        chatStore.setActiveConversation(conv.id)
        await openChat(router, conv.id, { replace: true })
      } catch (err) {
        if (active) {
          creationError.value = err instanceof Error ? err.message : String(err)
          errorNotify(err instanceof Error ? err : new Error(String(err)))
        }
      } finally {
        creating.value = false
      }
    }

    return {
      groupName,
      memberFilter,
      selectedAddresses,
      relayBaseUrl,
      creating,
      filteredContacts,
      isSelected,
      toggleMember,
      canAddTypedAddress,
      tryAddTypedAddress,
      canSubmit,
      formatShort,
      displayMemberLabel,
      cancel,
      creationError,
      submitCreateGroup,
    }
  },
})
</script>

<style scoped>
.new-group-form {
  width: 100%;
  max-width: 560px;
  margin: 0 auto;
}
.new-group-form :deep(.q-btn) {
  min-height: 44px;
}
.new-group-form :deep(.q-btn--round) {
  min-width: 44px;
}
.new-group-form :deep(.q-item) {
  min-height: 44px;
}
.new-group-form :deep(.q-field),
.new-group-form :deep(.q-item__section) {
  min-width: 0;
}
.new-group-form :deep(.q-chip) {
  max-width: 100%;
}
.new-group-form :deep(.q-chip__content) {
  overflow: hidden;
  text-overflow: ellipsis;
}
</style>
