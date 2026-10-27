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

      <q-select
        v-model="relayBaseUrl"
        :options="relayOptions"
        use-input
        fill-input
        hide-selected
        input-debounce="0"
        new-value-mode="add-unique"
        :loading="discoveringRelays"
        @new-value="addRelayOrigin"
        @input-value="relayInput = $event"
        filled
        dense
        :label="$t('groupChat.hostingRelayLabel')"
        data-test="group-relay-input"
        data-testid="group-relay-select"
      />
      <div
        v-if="discoveryFailed"
        class="text-caption"
        role="status"
        data-test="group-relay-discovery-error"
      >
        {{ $t('groupChat.discoveryFailed') }}
      </div>
      <!-- The creator sets what one write costs; members see it before they write. -->
      <q-input
        v-model="writePrice"
        filled
        dense
        inputmode="decimal"
        :loading="loadingTerms"
        :disable="!relayTerms"
        :label="$t('groupChat.writePriceInputLabel', { unit: priceUnit })"
        :hint="
          relayTerms
            ? $t('groupChat.writePriceHint', { minimum: minimumLabel })
            : termsFailed
            ? $t('groupChat.writePriceTermsFailed')
            : ''
        "
        :error="priceInvalid"
        :error-message="
          $t('groupChat.writePriceInvalid', { minimum: minimumLabel })
        "
        data-test="group-write-price-input"
        data-testid="group-write-price-input"
      />
    </q-card-section>

    <q-banner
      v-if="creationError"
      class="text-negative"
      role="alert"
      data-test="group-creation-error"
      >{{
        creationError.startsWith('groupChat.')
          ? $t(creationError)
          : creationError
      }}</q-banner
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
  onMounted,
  watch,
  type PropType,
} from 'vue'
import { useRouter } from 'vue-router'
import { activeChain } from '@frank/wallet/chain'
import {
  discoverRelayOrigins,
  isLoopbackHttpOrigin,
} from '@frank/cashweb/relay/relay-discovery'
import { normalizeGroupRelayOrigin } from '@frank/cashweb/groups'
import { accountSession } from '../../accounts/session'
import { messagingState } from '../../utils/messaging-state'
import { useChatStore } from '../../stores/chats'
import { useContactStore, type ContactState } from '../../stores/contacts'
import {
  isChainAddress,
  toChainDisplayAddress,
} from '../../utils/chain-address'
import { sameCanonicalAddress } from '../../utils/own-address'
import { openChat } from '../../utils/routes'
import { errorNotify } from '../../utils/notifications'
import { registryAmountAdapter } from '../../utils/chain-amount'
import {
  groupWritePriceLabel,
  parseGroupWritePriceInput,
} from '../../utils/group-write-price'
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
    const selectedAddresses = ref<string[]>(
      Array.from(new Set(props.initialMembers)),
    )
    const relayBaseUrl = ref('')
    const relayInput = ref('')
    const relayOptions = ref<string[]>([])
    const discoveringRelays = ref(false)
    const discoveryFailed = ref(false)
    const creating = ref(false)
    const creationError = ref('')
    const revision = accountSession.state.revision
    const account = accountSession.state.account
    const chainIdentifier = activeChain.chainIdentifier
    let installedHome = ''
    let active = true
    const discovery = new AbortController()
    const sameSession = () =>
      active &&
      accountSession.state.revision === revision &&
      accountSession.state.account === account &&
      activeChain.chainIdentifier === chainIdentifier &&
      messagingState.status === 'ready'
    const currentHome = () => {
      if (!sameSession()) return false
      try {
        return chatStore.getGroupHomeRelay() === installedHome
      } catch {
        return false
      }
    }
    try {
      installedHome = chatStore.getGroupHomeRelay()
      relayBaseUrl.value = installedHome
      relayOptions.value = [installedHome]
    } catch (error) {
      creationError.value =
        error instanceof Error ? error.message : String(error)
    }
    watch(
      () => [
        accountSession.state.revision,
        accountSession.state.account,
        activeChain.chainIdentifier,
        messagingState.status,
      ],
      () => {
        if (!sameSession()) {
          active = false
          discovery.abort()
          discoveringRelays.value = false
          relayOptions.value = []
          creationError.value = 'groupChat.sessionChanged'
        }
      },
    )
    onMounted(async () => {
      if (!installedHome) return
      discoveringRelays.value = true
      try {
        const hints = await discoverRelayOrigins({
          baseUrl: installedHome,
          fetch: (...args) => fetch(...args),
          signal: discovery.signal,
          // A home relay on loopback HTTP is a local setup (the lab, a dev relay); its own
          // origin and peers are loopback too. A public home keeps HTTPS public hints only.
          allowLoopbackHttp: isLoopbackHttpOrigin(installedHome),
        })
        if (currentHome())
          relayOptions.value = Array.from(new Set([installedHome, ...hints]))
      } catch {
        if (currentHome()) discoveryFailed.value = true
      } finally {
        if (sameSession()) discoveringRelays.value = false
      }
    })
    onBeforeUnmount(() => {
      active = false
      discovery.abort()
    })
    const addRelayOrigin = (
      value: string,
      done: (value?: string, mode?: 'add-unique') => void,
    ) => {
      try {
        const origin = normalizeGroupRelayOrigin(value.trim())
        done(origin, 'add-unique')
      } catch {
        creationError.value = 'groupChat.invalidRelay'
        done()
      }
    }

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

    // The hosting relay's network and least price, read before the creator picks a price.
    const writePrice = ref('')
    const relayTerms = ref<{
      relay: string
      network: string
      minPriceWei: bigint
    }>()
    const loadingTerms = ref(false)
    const termsFailed = ref(false)
    const chosenRelay = () => {
      try {
        return normalizeGroupRelayOrigin(
          relayInput.value.trim() || relayBaseUrl.value.trim(),
        )
      } catch {
        return ''
      }
    }
    let termsRequest = 0
    const loadTerms = async () => {
      const relay = chosenRelay()
      if (!relay || relayTerms.value?.relay === relay) return
      const request = ++termsRequest
      const previousMinimum = relayTerms.value
        ? groupWritePriceLabel(
            relayTerms.value.network,
            relayTerms.value.minPriceWei,
          )
        : undefined
      relayTerms.value = undefined
      termsFailed.value = false
      loadingTerms.value = true
      try {
        const terms = await chatStore.groupRelayWriteTerms(relay)
        if (request !== termsRequest || !sameSession()) return
        relayTerms.value = { relay, ...terms }
        const chain = registryAmountAdapter(terms.network)
        // The relay's minimum is the starting price; a price the creator typed stays unless it
        // was the previous relay's minimum.
        if (
          chain &&
          (!writePrice.value.trim() ||
            `${writePrice.value.trim()} ${chain.unit}` === previousMinimum)
        )
          writePrice.value = chain.toDisplayAmount(terms.minPriceWei)
      } catch {
        if (request === termsRequest && sameSession()) termsFailed.value = true
      } finally {
        if (request === termsRequest) loadingTerms.value = false
      }
    }
    watch([relayBaseUrl, relayInput], () => void loadTerms())
    onMounted(() => void loadTerms())
    const priceUnit = computed(() =>
      relayTerms.value
        ? registryAmountAdapter(relayTerms.value.network)?.unit ?? ''
        : '',
    )
    const minimumLabel = computed(() =>
      relayTerms.value
        ? groupWritePriceLabel(
            relayTerms.value.network,
            relayTerms.value.minPriceWei,
          )
        : '',
    )
    const writePriceWei = computed(() =>
      relayTerms.value
        ? parseGroupWritePriceInput(relayTerms.value.network, writePrice.value)
        : undefined,
    )
    const priceInvalid = computed(
      () =>
        Boolean(relayTerms.value) &&
        (writePriceWei.value === undefined ||
          writePriceWei.value < relayTerms.value!.minPriceWei),
    )

    const canSubmit = computed(() => {
      return Boolean(
        groupName.value.trim().length > 0 &&
          installedHome &&
          sameSession() &&
          relayTerms.value?.relay === chosenRelay() &&
          !priceInvalid.value,
      )
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
      discovery.abort()
      emit('cancel')
    }

    const submitCreateGroup = async () => {
      if (!canSubmit.value || creating.value) return
      if (!currentHome()) {
        creationError.value = 'groupChat.sessionChanged'
        return
      }
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
          relayUrl: normalizeGroupRelayOrigin(
            relayInput.value.trim() || relayBaseUrl.value.trim(),
          ),
          writePriceWei: writePriceWei.value,
        })
        // Leaving the page must not redirect a newer draft when creation settles.
        if (!currentHome()) return
        // The group exists, but its relay refused the creator's price: say so.
        if (conv.groupState?.writePriceRefusal)
          errorNotify(new Error('Group write price refused'), {
            fallbackKey: 'groupChat.writePriceRefusedAtCreation',
          })
        chatStore.setActiveConversation(conv.id)
        await openChat(router, conv.id, { replace: true })
      } catch (err) {
        if (currentHome()) {
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
      relayInput,
      relayOptions,
      discoveringRelays,
      discoveryFailed,
      addRelayOrigin,
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
      writePrice,
      relayTerms,
      loadingTerms,
      termsFailed,
      priceUnit,
      minimumLabel,
      priceInvalid,
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
