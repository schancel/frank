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
        <q-btn flat round dense icon="close" @click="closeDialog" />
      </q-card-section>

      <q-separator />
      <q-banner
        v-if="
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
                @click="removeMember(member.address)"
              />
            </q-item-section>
          </q-item>
        </q-list>

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
import { computed, defineComponent, ref } from 'vue'
import { useChatStore, type Conversation } from '../../stores/chats'
import { useContactStore } from '../../stores/contacts'
import { isChainAddress } from '../../utils/chain-address'
import {
  sameCanonicalAddress,
  useReactiveOwnCanonicalAddress,
} from '../../utils/own-address'
import { shortAddress } from '../../utils/short-address'
import { errorNotify } from '../../utils/notifications'

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
    const ownAddress = useReactiveOwnCanonicalAddress()
    const inviteeAddress = ref('')
    const busy = ref(false)

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
        const contactName = contactStore?.getContact?.(address)?.profile?.name
        let shortAddr = address
        try {
          shortAddr = shortAddress(address)
        } catch {
          shortAddr = address
        }
        return {
          address,
          label: contactName || shortAddr,
          shortAddr,
          isAdmin: Boolean(
            creatorAddress.value &&
              sameCanonicalAddress(address, creatorAddress.value),
          ),
          isSelf: Boolean(
            ownAddress.value && sameCanonicalAddress(address, ownAddress.value),
          ),
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

    const leaveGroup = async () => {
      if (!conversation.value || busy.value) return
      busy.value = true
      try {
        chatStore.leaveGroupConversation(conversation.value.id)
        emit('left', conversation.value.id)
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
      memberRows,
      inviteeAddress,
      busy,
      canRemoveMember,
      canInvite,
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
