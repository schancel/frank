<template>
  <q-dialog
    :model-value="modelValue"
    @update:model-value="$emit('update:modelValue', $event)"
  >
    <q-card
      v-if="conversation"
      style="min-width: 360px; max-width: 540px; width: 100%"
      data-test="group-info-dialog"
    >
      <q-card-section class="row items-center justify-between q-pb-sm">
        <div class="row items-center q-gutter-sm">
          <q-avatar
            rounded
            color="primary"
            text-color="white"
            icon="group"
            size="36px"
          />
          <div>
            <div class="text-h6" data-test="group-info-name">
              {{ conversation.name || $t('groupChat.groupInfoTitle') }}
            </div>
            <q-badge
              color="primary"
              outline
              :label="$t('groupChat.epochBadge', { epoch: currentEpoch })"
              data-test="group-info-epoch"
            />
          </div>
        </div>
        <q-btn
          flat
          round
          dense
          icon="close"
          :aria-label="$t('groupChat.close')"
          @click="closeDialog"
        />
      </q-card-section>

      <q-separator />
      <q-banner
        v-if="conversation.membershipStatus === 'removed'"
        class="q-pa-sm"
        role="status"
        data-test="group-info-removed"
      >
        {{ $t('groupChat.removedBanner') }}
      </q-banner>
      <q-banner
        v-else-if="
          conversation.groupState?.pendingEpoch ||
          conversation.groupState?.syncFailed
        "
        class="q-pa-sm"
        role="status"
      >
        {{
          conversation.groupState?.pendingEpoch
            ? $t('groupChat.epochPending')
            : $t('groupChat.syncFailed')
        }}
      </q-banner>
      <q-card-section class="q-gutter-xs">
        <div class="text-caption text-grey-6">
          {{ $t('groupChat.groupIdLabel') }}
        </div>
        <div
          class="font-mono text-caption break-word"
          data-test="group-info-id"
        >
          {{ groupIdDisplay }}
        </div>

        <div class="text-caption text-grey-6 q-mt-sm">
          {{ $t('groupChat.hostingRelayLabel') }}
        </div>
        <div
          class="font-mono text-caption break-word"
          data-test="group-info-relay"
        >
          {{ hostingRelayDisplay }}
        </div>

        <div class="text-caption text-grey-6 q-mt-sm">
          {{ $t('groupChat.writePriceLabel') }}
        </div>
        <div class="text-caption" data-test="group-info-write-price">
          {{ writePriceDisplay || $t('groupChat.writePriceUnknown') }}
        </div>
        <div
          v-if="canSetPrice"
          class="row items-start no-wrap q-gutter-xs q-mt-xs"
        >
          <q-input
            v-model="newPrice"
            filled
            dense
            class="col"
            inputmode="decimal"
            :label="$t('groupChat.changeWritePriceLabel', { unit: priceUnit })"
            :error="Boolean(priceError)"
            :error-message="
              priceError ? $t(priceError.key, priceError.values ?? {}) : ''
            "
            data-test="group-write-price-input"
            @keydown.enter.prevent="requestPriceChange"
          />
          <q-btn
            color="primary"
            unelevated
            no-caps
            :disable="newPriceWei === undefined || busy"
            :loading="busy"
            :label="$t('groupChat.changeWritePriceBtn')"
            data-test="group-write-price-btn"
            @click="requestPriceChange"
          />
        </div>
        <!-- The typed price, read back in the network's unit with what it is now. -->
        <div
          v-if="canSetPrice && newPriceWei !== undefined"
          class="text-caption q-mt-xs"
          data-test="group-write-price-preview"
        >
          {{
            $t('groupChat.writePricePreview', {
              price: newPriceDisplay,
              current: writePriceDisplay,
            })
          }}
        </div>
        <div
          v-if="refusalText"
          class="text-caption text-negative q-mt-xs"
          role="alert"
          data-test="group-info-price-refused"
        >
          {{ $t(refusalText.key, refusalText.values ?? {}) }}
        </div>

        <!-- A large raise is confirmed first: every member pays it for every message. -->
        <q-dialog
          :model-value="confirmingRaise"
          @update:model-value="open => !open && (confirmingRaise = false)"
        >
          <q-card
            style="min-width: 300px"
            data-test="group-write-price-confirm"
          >
            <q-card-section class="text-h6">
              {{ $t('groupChat.writePriceRaiseTitle') }}
            </q-card-section>
            <q-card-section class="q-pt-none">
              {{
                $t('groupChat.writePriceRaiseBody', {
                  current: writePriceDisplay,
                  price: newPriceDisplay,
                })
              }}
            </q-card-section>
            <q-card-actions align="right">
              <q-btn
                flat
                no-caps
                :label="$t('groupChat.cancel')"
                data-test="group-write-price-confirm-cancel"
                @click="confirmingRaise = false"
              />
              <q-btn
                flat
                no-caps
                color="primary"
                :label="$t('groupChat.changeWritePriceBtn')"
                data-test="group-write-price-confirm-btn"
                @click="confirmRaise"
              />
            </q-card-actions>
          </q-card>
        </q-dialog>
      </q-card-section>

      <q-separator />

      <q-card-section>
        <div class="row items-center justify-between q-mb-xs">
          <div class="text-subtitle2" data-test="group-members-heading">
            {{ $t('groupChat.membersHeading', { count: memberRows.length }) }}
          </div>
          <q-btn
            flat
            dense
            no-caps
            size="sm"
            icon="sync"
            color="primary"
            :loading="busy"
            :label="$t('groupChat.syncGroupBtn')"
            data-test="sync-group-btn"
            @click="syncGroup"
          />
        </div>

        <q-list bordered separator dense class="rounded-borders">
          <q-item
            v-for="member in memberRows"
            :key="member.address"
            data-test="group-member-row"
          >
            <q-item-section>
              <q-item-label class="row items-center q-gutter-xs">
                <span class="text-weight-medium">{{ member.label }}</span>
                <span v-if="member.isSelf" class="text-caption text-grey-6">
                  {{ $t('groupChat.youSuffix') }}
                </span>
                <q-badge
                  v-if="member.isAdmin"
                  color="secondary"
                  :label="$t('groupChat.adminBadge')"
                  data-test="group-member-admin-badge"
                />
              </q-item-label>
              <q-item-label caption class="font-mono">
                {{ member.shortAddr }}
              </q-item-label>
            </q-item-section>
            <q-item-section v-if="canRemoveMember(member)" side>
              <q-btn
                flat
                dense
                no-caps
                size="sm"
                color="negative"
                icon="person_remove"
                :disable="busy"
                :label="$t('groupChat.removeMemberBtn')"
                data-test="remove-group-member-btn"
                @click="pendingRemoval = member"
              />
            </q-item-section>
          </q-item>
        </q-list>

        <!-- Removing a member cannot be undone from here: the user confirms it first. -->
        <q-dialog
          :model-value="pendingRemoval !== null"
          @update:model-value="open => !open && (pendingRemoval = null)"
        >
          <q-card style="min-width: 300px" data-test="remove-member-confirm">
            <q-card-section class="text-h6">
              {{ $t('groupChat.removeMemberConfirmTitle') }}
            </q-card-section>
            <q-card-section class="q-pt-none">
              {{
                $t('groupChat.removeMemberConfirmBody', {
                  member: pendingRemoval?.label ?? '',
                  group: conversation.name || $t('groupChat.unnamedGroup'),
                })
              }}
            </q-card-section>
            <q-card-actions align="right">
              <q-btn
                flat
                no-caps
                :label="$t('groupChat.cancel')"
                data-test="remove-member-cancel"
                @click="pendingRemoval = null"
              />
              <q-btn
                flat
                no-caps
                color="negative"
                :label="$t('groupChat.removeMemberConfirmBtn')"
                data-test="remove-member-confirm-btn"
                @click="confirmRemoval"
              />
            </q-card-actions>
          </q-card>
        </q-dialog>

        <div
          v-if="conversation.membershipStatus === 'joined'"
          class="row items-center no-wrap q-gutter-xs q-mt-md"
        >
          <q-input
            v-model="inviteeAddress"
            filled
            dense
            class="col"
            :label="$t('groupChat.inviteMemberLabel')"
            :placeholder="$t('groupChat.inviteMemberPlaceholder')"
            data-test="invite-group-member-input"
            @keydown.enter.prevent="inviteMember"
          />
          <q-btn
            color="primary"
            unelevated
            no-caps
            :disable="!canInvite || busy"
            :loading="busy"
            :label="$t('groupChat.inviteMemberBtn')"
            data-test="invite-group-member-btn"
            @click="inviteMember"
          />
        </div>
      </q-card-section>

      <q-separator />

      <q-card-actions align="between" class="q-px-md q-py-sm">
        <q-btn
          v-if="conversation.membershipStatus === 'joined'"
          flat
          no-caps
          color="negative"
          icon="logout"
          :disable="busy"
          :label="$t('groupChat.leaveGroupBtn')"
          data-test="leave-group-btn"
          @click="leaveGroup"
        />
        <q-space />
        <q-btn
          flat
          no-caps
          :label="$t('close')"
          data-test="close-group-info-btn"
          @click="closeDialog"
        />
      </q-card-actions>
    </q-card>
  </q-dialog>
</template>

<script lang="ts">
import { computed, defineComponent, ref, watch } from 'vue'
import { useChatStore, type Conversation } from '../../stores/chats'
import {
  isBlankName,
  pendingRelayData,
  useContactStore,
} from '../../stores/contacts'
import { useProfileStore } from '../../stores/my-profile'
import {
  isChainAddress,
  safeToChainDisplayAddress,
} from '../../utils/chain-address'
import {
  sameCanonicalAddress,
  useReactiveOwnCanonicalAddress,
} from '../../utils/own-address'
import { shortAddress } from '../../utils/short-address'
import { errorNotify } from '../../utils/notifications'
import { registryAmountAdapter } from '../../utils/chain-amount'
import {
  groupWritePriceLabel,
  groupWritePriceRefusalMessage,
  groupWritePriceViewLabel,
  parseGroupWritePriceInput,
} from '../../utils/group-write-price'

/** A new price this many times the current one or more is confirmed before it is set. */
const LARGE_RAISE_FACTOR = 10n

interface MemberRow {
  address: string
  label: string
  shortAddr: string
  isAdmin: boolean
  isSelf: boolean
}

export default defineComponent({
  name: 'GroupInfoDialog',
  props: {
    modelValue: {
      type: Boolean,
      default: false,
    },
    conversationId: {
      type: String,
      default: '',
    },
  },
  emits: ['update:modelValue', 'left'],
  setup(props, { emit }) {
    const chatStore = useChatStore()
    let contactStore: ReturnType<typeof useContactStore> | null = null
    try {
      contactStore = useContactStore()
    } catch {
      contactStore = null
    }
    let profileStore: ReturnType<typeof useProfileStore> | null = null
    try {
      profileStore = useProfileStore()
    } catch {
      profileStore = null
    }
    const ownAddress = useReactiveOwnCanonicalAddress()
    const inviteeAddress = ref('')
    const busy = ref(false)
    const pendingRemoval = ref<MemberRow | null>(null)

    const conversation = computed<Conversation | null>(() => {
      if (props.conversationId)
        return chatStore.conversations[props.conversationId] ?? null
      return chatStore.activeConversation ?? null
    })

    const currentEpoch = computed<number>(() => {
      return conversation.value?.groupState?.epoch ?? 0
    })

    const groupIdDisplay = computed<string>(() => {
      const conv = conversation.value
      if (!conv) return ''
      if (conv.id.startsWith('group:')) return conv.id
      if (conv.groupState?.groupIdHex)
        return `group:${conv.groupState.groupIdHex}`
      return conv.id
    })

    const hostingRelayDisplay = computed<string>(() => {
      return conversation.value?.groupState?.homeRelay || ''
    })

    const creatorAddress = computed<string>(() => {
      return (
        conversation.value?.groupState?.roster.find(
          member => member.role === 'admin',
        )?.address || ''
      )
    })

    const isSelfAdmin = computed<boolean>(() => {
      if (
        !ownAddress.value ||
        !creatorAddress.value ||
        !conversation.value?.groupState?.groupSecretKeyHex
      )
        return false
      return sameCanonicalAddress(ownAddress.value, creatorAddress.value)
    })

    const memberRows = computed<MemberRow[]>(() => {
      const conv = conversation.value
      if (!conv) return []
      const participants = conv.participants ?? []
      return participants.map(address => {
        const isSelf = Boolean(
          ownAddress.value && sameCanonicalAddress(address, ownAddress.value),
        )
        // This user's own name is their profile's; a contact entry for a member is a
        // placeholder ("Loading...") until its profile arrives, and never named the member.
        const name = isSelf
          ? profileStore?.profile?.name
          : contactStore?.getContact?.(address)?.profile?.name
        // Shown in the network's display form (checksummed on EVM), as everywhere else: the
        // roster of a new epoch carries members' addresses in lower case.
        const display = safeToChainDisplayAddress(address) ?? address
        let shortAddr = display
        try {
          shortAddr = shortAddress(display)
        } catch {
          shortAddr = display
        }
        return {
          address,
          label:
            name &&
            !isBlankName(name) &&
            // The name a contact entry carries while its profile is being fetched.
            name !== pendingRelayData?.profile?.name
              ? name
              : shortAddr,
          shortAddr,
          isAdmin: Boolean(
            creatorAddress.value &&
              sameCanonicalAddress(address, creatorAddress.value),
          ),
          isSelf,
        }
      })
    })

    const canRemoveMember = (member: MemberRow): boolean => {
      if (conversation.value?.membershipStatus !== 'joined') return false
      return isSelfAdmin.value && !member.isSelf
    }

    const canInvite = computed<boolean>(() => {
      const trimmed = inviteeAddress.value.trim()
      return Boolean(
        conversation.value?.membershipStatus === 'joined' &&
          isSelfAdmin.value &&
          trimmed &&
          isChainAddress(trimmed),
      )
    })

    const newPrice = ref('')
    const priceError = ref<{ key: string; values?: Record<string, string> }>()
    const writePrice = computed(
      () => conversation.value?.groupState?.writePrice,
    )
    const writePriceDisplay = computed(() =>
      groupWritePriceViewLabel(writePrice.value),
    )
    const priceUnit = computed(() =>
      writePrice.value
        ? registryAmountAdapter(writePrice.value.network)?.unit ?? ''
        : '',
    )
    // Only the group's administrator signs its price, and only on a network with a unit to
    // type it in.
    const canSetPrice = computed(
      () =>
        conversation.value?.membershipStatus === 'joined' &&
        isSelfAdmin.value &&
        Boolean(priceUnit.value),
    )
    const newPriceWei = computed(() =>
      writePrice.value
        ? parseGroupWritePriceInput(writePrice.value.network, newPrice.value)
        : undefined,
    )
    // Opening the dialog asks the host for the current price.
    watch(
      () => [props.modelValue, conversation.value?.id] as const,
      ([open, id]) => {
        if (open && id && conversation.value?.groupState)
          void chatStore.refreshGroupWritePrice(id).catch(() => undefined)
      },
      { immediate: true },
    )
    const newPriceDisplay = computed(() =>
      writePrice.value && newPriceWei.value !== undefined
        ? groupWritePriceLabel(writePrice.value.network, newPriceWei.value)
        : '',
    )
    const confirmingRaise = ref(false)
    const requestPriceChange = () => {
      const price = newPriceWei.value
      if (price === undefined || busy.value) return
      const current = writePrice.value ? BigInt(writePrice.value.priceWei) : 0n
      if (current > 0n && price >= current * LARGE_RAISE_FACTOR)
        confirmingRaise.value = true
      else void changePrice()
    }
    const confirmRaise = () => {
      confirmingRaise.value = false
      void changePrice()
    }
    // The host refused the last price an administrator signed (at creation, too).
    const refusalText = computed<
      { key: string; values?: Record<string, string> } | undefined
    >(() => {
      const refusal = conversation.value?.groupState?.writePriceRefusal
      if (!refusal) return undefined
      if (refusal.minPriceWei !== undefined && writePrice.value)
        return {
          key: 'groupChat.writePriceBelowMinimum',
          values: {
            minimum: groupWritePriceLabel(
              writePrice.value.network,
              refusal.minPriceWei,
            ),
          },
        }
      return { key: 'groupChat.writePriceNotSet' }
    })
    const changePrice = async () => {
      const conv = conversation.value
      const price = newPriceWei.value
      if (!conv || price === undefined || busy.value) return
      busy.value = true
      priceError.value = undefined
      try {
        await chatStore.setGroupWritePrice(conv.id, price)
        newPrice.value = ''
      } catch (err) {
        const refusal = groupWritePriceRefusalMessage(
          err,
          writePrice.value?.network ?? '',
        )
        if (refusal) priceError.value = refusal
        else errorNotify(err instanceof Error ? err : new Error(String(err)))
      } finally {
        busy.value = false
      }
    }

    const closeDialog = () => {
      emit('update:modelValue', false)
    }

    const syncGroup = async () => {
      if (!conversation.value || busy.value) return
      busy.value = true
      try {
        await chatStore.syncGroupConversation(conversation.value.id)
      } catch (err) {
        errorNotify(err instanceof Error ? err : new Error(String(err)))
      } finally {
        busy.value = false
      }
    }

    const inviteMember = async () => {
      if (!conversation.value || !canInvite.value || busy.value) return
      busy.value = true
      try {
        await chatStore.inviteMemberToGroup({
          conversationId: conversation.value.id,
          memberAddress: inviteeAddress.value.trim(),
        })
        inviteeAddress.value = ''
      } catch (err) {
        errorNotify(err instanceof Error ? err : new Error(String(err)))
      } finally {
        busy.value = false
      }
    }

    const removeMember = async (memberAddress: string) => {
      if (!conversation.value || busy.value) return
      busy.value = true
      try {
        await chatStore.removeMemberFromGroup({
          conversationId: conversation.value.id,
          memberAddress,
        })
      } catch (err) {
        errorNotify(err instanceof Error ? err : new Error(String(err)))
      } finally {
        busy.value = false
      }
    }

    const confirmRemoval = async () => {
      const member = pendingRemoval.value
      pendingRemoval.value = null
      if (member) await removeMember(member.address)
    }

    const leaveGroup = async () => {
      if (!conversation.value || busy.value) return
      busy.value = true
      try {
        const conversationId = conversation.value.id
        await chatStore.leaveGroupConversation(conversationId)
        emit('left', conversationId)
        emit('update:modelValue', false)
      } catch (err) {
        errorNotify(err instanceof Error ? err : new Error(String(err)))
      } finally {
        busy.value = false
      }
    }

    return {
      conversation,
      currentEpoch,
      groupIdDisplay,
      hostingRelayDisplay,
      writePriceDisplay,
      priceUnit,
      canSetPrice,
      newPrice,
      newPriceWei,
      priceError,
      changePrice,
      requestPriceChange,
      confirmRaise,
      confirmingRaise,
      newPriceDisplay,
      refusalText,
      memberRows,
      inviteeAddress,
      busy,
      canRemoveMember,
      canInvite,
      pendingRemoval,
      confirmRemoval,
      closeDialog,
      syncGroup,
      inviteMember,
      removeMember,
      leaveGroup,
    }
  },
})
</script>

<style scoped>
.break-word {
  word-break: break-all;
}
</style>
