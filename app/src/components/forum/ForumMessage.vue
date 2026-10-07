<template>
  <q-card
    class="forum-post-card q-pa-none"
    :class="{ 'q-ma-sm': !compact }"
    flat
    bordered
  >
    <q-card-section class="row no-wrap q-pa-none" horizontal>
      <div
        class="vote-column column items-center justify-start q-py-sm q-px-xs"
      >
        <q-btn
          flat
          dense
          round
          size="sm"
          icon="arrow_drop_up"
          padding="0"
          :aria-label="$t('a11y.voteUp')"
          :disable="isVoting"
          @click="addVotes(1)"
          data-test="forum-vote-up"
          class="vote-btn upvote-btn"
        />
        <div
          class="vote-weight-pill text-caption text-weight-bold text-center q-my-xs"
        >
          {{ formatVoteWeight(displayedVoteWeight) }}
        </div>
        <q-btn
          flat
          dense
          round
          size="sm"
          icon="arrow_drop_down"
          padding="0"
          :aria-label="$t('a11y.voteDown')"
          :disable="isVoting"
          @click="addVotes(-1)"
          data-test="forum-vote-down"
          class="vote-btn downvote-btn"
        />
      </div>
      <div class="col column q-pa-none post-main-content">
        <template
          v-for="(entry, index) in message.entries.filter(
            entry => entry.kind === 'post',
          )"
          :key="index"
        >
          <div
            class="row items-center no-wrap justify-between q-px-md q-pt-sm q-pb-xs"
          >
            <div class="col-grow post-title-wrap">
              <q-icon
                name="link"
                v-if="entry.url"
                class="text-subtitle1 q-mr-xs"
              />
              <a
                :href="entry.url"
                target="_blank"
                v-if="entry.url"
                class="text-subtitle1 text-weight-bold post-title"
                >{{ entry.title || 'untitled' }}</a
              >
              <span v-if="!entry.url" class="text-subtitle1 text-weight-bold">
                {{ entry.title || 'untitled' }}
              </span>
            </div>
            <q-chip
              v-if="message.topic"
              outline
              dense
              size="sm"
              color="primary"
              class="topic-chip cursor-pointer q-ml-sm"
              clickable
              @click.prevent="$emit('set-topic', message.topic)"
            >
              #{{ message.topic }}
            </q-chip>
          </div>
          <div
            class="q-px-md q-pt-xs q-pb-sm col-grow post-body"
            v-if="renderBody"
          >
            <div
              class="mdstyle text-body2"
              v-html="markedMessage(entry.message)"
            />
          </div>
        </template>
        <q-separator class="q-my-none" style="opacity: 0.15" />
        <q-card-actions
          class="post-footer q-px-md q-py-xs row items-center no-wrap"
        >
          <div
            class="row items-center q-gutter-x-xs text-caption text-grey-7 author-pill"
          >
            <q-icon name="person" size="14px" color="primary" />
            <span>by</span>
            <q-btn
              no-caps
              flat
              dense
              size="sm"
              :to="authorRoute(message)"
              :disable="!authorRoute(message)"
              class="author-btn q-px-xs"
            >
              <div
                class="text-weight-bold"
                :class="{ 'font-mono': isAuthorAddress(message) }"
              >
                {{ authorName(message) }}
              </div>
            </q-btn>
          </div>
          <div
            v-if="voteStatus"
            class="text-caption text-italic q-ml-sm row items-center"
            role="status"
            data-test="vote-status"
          >
            <q-spinner-dots size="1.2em" color="primary" class="q-mr-xs" />
            <span>{{ voteStatus }}</span>
          </div>
          <q-space />
          <div class="row items-center q-gutter-x-xs">
            <span class="text-caption text-grey-6 row items-center q-mr-sm">
              <q-icon name="schedule" size="14px" class="q-mr-xs" />
              <span>{{ timestamp }}</span>
              <q-tooltip>{{ fullTimestamp }}</q-tooltip>
            </span>
            <q-btn
              flat
              dense
              size="sm"
              no-caps
              icon="chat_bubble_outline"
              class="comments-btn text-caption q-px-xs"
              :label="`${message.replies.length} replies`"
              :to="`/forum/${message.payloadDigest}`"
            />
            <q-btn
              flat
              dense
              size="sm"
              no-caps
              icon="reply"
              label="Reply"
              class="reply-btn text-caption q-px-xs text-primary"
              :to="`/new-post/${message.payloadDigest}`"
            />
          </div>
        </q-card-actions>
        <a-message-replies :messages="message.replies" v-if="showReplies" />
        <q-separator v-if="showParent && parentDigest && parentMessage" />
        <q-card-section
          v-if="showParent && parentDigest && parentMessage"
          class="q-pa-none"
        >
          <q-card-section class="q-pa-sm">In reply to:</q-card-section>
          <forum-message
            v-bind="$attrs"
            class="q-ma-none"
            :message="parentMessage"
            :show-replies="false"
            :render-body="false"
          />
        </q-card-section>
      </div>
    </q-card-section>
  </q-card>
</template>

<script lang="ts">
import moment from 'moment'
import { accountStatus } from 'src/accounts/session'
import { defineComponent } from 'vue'
import type { PropType } from 'vue'
import { storeToRefs } from 'pinia'

import { renderMarkdown } from '../../utils/markdown'

import AMessageReplies from './ForumMessageReplies.vue'

import { MessageWithReplies, useForumStore } from 'src/stores/forum'
import { useContactStore } from 'src/stores/contacts'
import { useProfileStore } from 'src/stores/my-profile'
import { useActiveWallet } from 'src/composables/useActiveWallet'
import {
  notifyBurnFailure,
  BurnRefreshError,
} from 'src/utils/burn-refresh-error'
import { activeChain } from '@frank/wallet/chain'
import { formatRawAmount } from 'src/utils/chain-amount'
import { stampPreparationStatus } from 'src/utils/stamp-preparation-status'
import {
  sameCanonicalAddress,
  useReactiveOwnCanonicalAddress,
} from 'src/utils/own-address'

export default defineComponent({
  setup() {
    const forumStore = useForumStore()
    const contactStore = useContactStore()
    let profileStore: ReturnType<typeof useProfileStore> | { profile: Record<string, unknown> }
    try {
      profileStore = useProfileStore()
    } catch {
      profileStore = { profile: {} }
    }
    const { messages, topics, selectedTopic } = storeToRefs(forumStore)

    return {
      storeMessages: messages,
      getMessage: forumStore.getMessage,
      isOwnPost: forumStore.isOwnPost,
      topics,
      getContactProfile: contactStore.getContactProfile,
      haveContact: contactStore.haveContact,
      selectedTopic,
      addOffering: forumStore.addOffering,
      applyOptimisticVote: forumStore.applyOptimisticVote,
      rollbackOptimisticVote: forumStore.rollbackOptimisticVote,
      setStampPreparationStatus: forumStore.setStampPreparationStatus,
      myProfile: profileStore,
      profileStore,
      ownAddress: useReactiveOwnCanonicalAddress(),
    }
  },
  props: {
    message: {
      default: () => ({
        poster: undefined,
        voteWeightWei: '0',
        replies: [],
        entries: [],
        payloadDigest: undefined,
        topic: '',
      }),
      type: Object as PropType<MessageWithReplies>,
    },
    showParent: {
      default: false,
      type: Boolean,
    },
    showReplies: {
      default: true,
      type: Boolean,
    },
    renderBody: {
      default: true,
      type: Boolean,
    },
    compact: {
      default: false,
      type: Boolean,
    },
  },
  components: {
    AMessageReplies,
  },
  data() {
    return {
      timeoutId: undefined as ReturnType<typeof setTimeout> | undefined,
      voteAmount: 0n,
      localVoteDelta: 0n,
      isVoting: false,
      votePreparationStatus: null as string | null,
      voteActive: true,
      voteTarget: null as string | null,
      voteOwnerRevision: null as number | null,
      voteOwnerStatus: null as string | null,
    }
  },
  emits: ['set-topic'],
  unmounted() {
    this.voteActive = false
    if (this.timeoutId) clearTimeout(this.timeoutId)
    if (this.voteAmount !== 0n && this.voteTarget) {
      this.rollbackOptimisticVote?.({
        payloadDigest: this.voteTarget,
        deltaWei: this.voteAmount,
      })
      this.voteAmount = 0n
      this.localVoteDelta = 0n
    }
    if (this.isVoting || this.voteAmount !== 0n) {
      this.setStampPreparationStatus?.(null)
    }
  },
  methods: {
    formatVoteWeight(value: string) {
      return formatRawAmount(activeChain, value)
    },
    markedMessage(text?: string) {
      return renderMarkdown(text ?? '', this.$q.dark.isActive)
    },
    formatAddress(address?: string): string {
      if (!address || typeof address !== 'string') {
        return 'Anonymous'
      }
      const trimmed = address.trim()
      if (!trimmed) {
        return 'Anonymous'
      }
      if (trimmed.length <= 14) {
        return trimmed
      }
      return `${trimmed.slice(0, 8)}...${trimmed.slice(-6)}`
    },
    isAuthorMe(message?: MessageWithReplies): boolean {
      const msg = message ?? this.message
      if (!msg) return false
      if (
        (msg as any).isOwn ||
        (msg as any).isLocal ||
        (msg as any).own
      ) {
        return true
      }
      if (msg.payloadDigest && this.isOwnPost?.(msg.payloadDigest)) {
        return true
      }
      const poster = msg.poster
      if (poster) {
        const own =
          typeof this.ownAddress === 'object' &&
          this.ownAddress !== null &&
          'value' in this.ownAddress
            ? (this.ownAddress as any).value
            : this.ownAddress
        if (
          own &&
          (sameCanonicalAddress(poster, own) ||
            poster.toLowerCase() === String(own).toLowerCase())
        ) {
          return true
        }
        const profileAddr = (this.myProfile?.profile as any)?.address
        if (
          profileAddr &&
          (sameCanonicalAddress(poster, profileAddr) ||
            poster.toLowerCase() === String(profileAddr).toLowerCase())
        ) {
          return true
        }
      }
      return false
    },
    authorName(message?: MessageWithReplies): string {
      const msg = message ?? this.message
      if (!msg) return 'Anonymous'
      if (this.isAuthorMe(msg)) {
        const profile = this.myProfile?.profile
        return profile?.name || profile?.username || 'You'
      }
      if (msg.poster && this.haveContact(msg.poster)) {
        const contactProfile = this.getContactProfile(msg.poster)
        if (contactProfile?.name) {
          return contactProfile.name
        }
      }
      if (msg.poster) {
        return this.formatAddress(msg.poster)
      }
      return 'Anonymous'
    },
    authorRoute(message?: MessageWithReplies): string | undefined {
      const msg = message ?? this.message
      if (!msg) return undefined
      if (this.isAuthorMe(msg)) {
        return '/profile'
      }
      if (msg.poster) {
        return `/chat/${msg.poster}`
      }
      return undefined
    },
    isAuthorAddress(message?: MessageWithReplies): boolean {
      const msg = message ?? this.message
      if (!msg || this.isAuthorMe(msg)) return false
      if (
        msg.poster &&
        this.haveContact(msg.poster) &&
        this.getContactProfile(msg.poster)?.name
      ) {
        return false
      }
      return Boolean(msg.poster)
    },
    addVotes(direction: number) {
      if (
        this.voteTarget !== this.message.payloadDigest ||
        this.voteOwnerRevision !== accountStatus.revision ||
        this.voteOwnerStatus !== accountStatus.status
      ) {
        if (this.voteAmount !== 0n && this.voteTarget) {
          this.rollbackOptimisticVote?.({
            payloadDigest: this.voteTarget,
            deltaWei: this.voteAmount,
          })
        }
        this.voteAmount = 0n
        this.localVoteDelta = 0n
      }
      this.voteTarget = this.message.payloadDigest
      this.voteOwnerRevision = accountStatus.revision
      this.voteOwnerStatus = accountStatus.status

      const delta = BigInt(direction) * activeChain.defaultTopicVoteValue
      this.voteAmount += delta
      this.localVoteDelta += delta
      if (this.message?.payloadDigest) {
        this.applyOptimisticVote?.({
          payloadDigest: this.message.payloadDigest,
          deltaWei: delta,
        })
      }
      this.setStampPreparationStatus?.(this.$t('stampPreparation.voting'))

      if (this.timeoutId) {
        clearTimeout(this.timeoutId)
      }
      const digest = this.message.payloadDigest
      const revision = accountStatus.revision
      const status = accountStatus.status
      this.timeoutId = setTimeout(() => {
        if (
          !this.voteActive ||
          this.message.payloadDigest !== digest ||
          accountStatus.revision !== revision ||
          accountStatus.status !== status
        ) {
          if (this.voteAmount !== 0n && digest) {
            this.rollbackOptimisticVote?.({
              payloadDigest: digest,
              deltaWei: this.voteAmount,
            })
          }
          this.voteAmount = 0n
          this.localVoteDelta = 0n
          this.setStampPreparationStatus?.(null)
          return
        }
        void (async () => {
          if (this.voteAmount === 0n) {
            return
          }
          console.log('Adding votes', {
            payloadDigest: this.message?.payloadDigest,
            satoshis: this.voteAmount,
          })
          // The votes being sent are consumed either way: a failed burn is reported, never
          // silently kept and re-sent on top of the next click (ticket #273).
          const satoshis = this.voteAmount
          this.voteAmount = 0n
          this.isVoting = true
          const initialStatus = this.$t('chat.stampPreparationChecking')
          this.votePreparationStatus = initialStatus
          this.setStampPreparationStatus?.(initialStatus)
          try {
            const wallet = await useActiveWallet()
            if (
              !this.voteActive ||
              this.message.payloadDigest !== digest ||
              accountStatus.revision !== revision ||
              accountStatus.status !== status
            ) {
              this.rollbackOptimisticVote?.({
                payloadDigest: digest,
                deltaWei: satoshis,
              })
              this.localVoteDelta = 0n
              this.setStampPreparationStatus?.(null)
              return
            }
            await this.addOffering({
              wallet,
              payloadDigest: digest,
              satoshis,
              onPreparationProgress: progress => {
                if (
                  !this.voteActive ||
                  this.message.payloadDigest !== digest ||
                  accountStatus.revision !== revision ||
                  accountStatus.status !== status
                ) {
                  return
                }
                const progressStatus = stampPreparationStatus(
                  progress,
                  (key, params) => this.$t(key, params ?? {}),
                  {
                    format: raw => activeChain.toDisplayAmount(raw),
                    unit: activeChain.unit,
                  },
                )
                this.votePreparationStatus = progressStatus
                this.setStampPreparationStatus?.(progressStatus)
              },
            })
            this.localVoteDelta = 0n
          } catch (err) {
            if (!(err instanceof BurnRefreshError)) {
              this.rollbackOptimisticVote?.({
                payloadDigest: digest,
                deltaWei: satoshis,
              })
              this.localVoteDelta = 0n
            }
            notifyBurnFailure(err, key => this.$t(key))
          } finally {
            this.isVoting = false
            this.votePreparationStatus = null
            this.setStampPreparationStatus?.(null)
          }
        })()
      }, 1_000)
    },
  },
  computed: {
    displayedVoteWeight(): string {
      const storeMessage = this.message?.payloadDigest
        ? this.getMessage(this.message.payloadDigest)
        : undefined
      if (storeMessage?.voteWeightWei !== undefined) {
        return storeMessage.voteWeightWei
      }
      return (
        BigInt(this.message?.voteWeightWei || '0') + this.localVoteDelta
      ).toString()
    },
    voteStatus(): string | null {
      if (this.votePreparationStatus) {
        return this.votePreparationStatus
      }
      if (this.isVoting || this.voteAmount !== 0n) {
        return this.$t('stampPreparation.voting')
      }
      return null
    },
    timestamp() {
      if (!this.message) {
        return ''
      }
      const howLongAgo = moment(this.message?.timestamp)
      return howLongAgo.calendar(null, {
        sameDay: 'HH:mm:ss',
        nextDay: '[Tomorrow] HH:mm:ss',
        nextWeek: 'dddd',
        lastDay: 'HH:mm:ss',
        lastWeek: '[Last] dddd',
        sameElse: 'DD/MM/YYYY',
      })
    },
    fullTimestamp() {
      return this.message
        ? moment(this.message?.timestamp).format('YYYY-MM-DD HH:mm:ss')
        : ''
    },
    parentDigest() {
      return this.message?.parentDigest
    },
    parentMessage() {
      return this.getMessage(this.parentDigest)
    },
    messages() {
      return this.storeMessages.filter((message: MessageWithReplies) =>
        message.entries.some(entry => entry.kind === 'post'),
      )
    },
  },
})
</script>

<style lang="scss" scoped>
.forum-post-card {
  border-radius: 12px;
  border: 1px solid var(--q-color-border, rgba(0, 0, 0, 0.08));
  background: var(--q-card-bg, #ffffff);
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.04);
  transition: transform 0.15s ease, box-shadow 0.15s ease,
    border-color 0.15s ease;
  overflow: hidden;

  &:hover {
    border-color: rgba(0, 0, 0, 0.16);
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.06);
  }
}

:global(body.body--dark) .forum-post-card {
  background: #1c1613;
  border-color: rgba(255, 255, 255, 0.08);
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.2);

  &:hover {
    border-color: rgba(255, 255, 255, 0.18);
    box-shadow: 0 4px 14px rgba(0, 0, 0, 0.35);
  }
}

.vote-column {
  min-width: 52px;
  background: rgba(0, 0, 0, 0.02);
  border-right: 1px solid rgba(0, 0, 0, 0.05);
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: flex-start;
  padding: 8px 4px;
}

:global(body.body--dark) .vote-column {
  background: rgba(255, 255, 255, 0.03);
  border-right: 1px solid rgba(255, 255, 255, 0.06);
}

.vote-btn {
  opacity: 0.7;
  transition: opacity 0.15s ease, color 0.15s ease, background 0.15s ease;
  &:hover:not(:disabled) {
    opacity: 1;
  }
}
.upvote-btn:hover:not(:disabled) {
  color: #ff5722 !important;
  background: rgba(255, 87, 34, 0.1);
}
.downvote-btn:hover:not(:disabled) {
  color: #7c4dff !important;
  background: rgba(124, 77, 255, 0.1);
}

.vote-weight-pill {
  font-size: 0.75rem;
  letter-spacing: -0.02em;
}

.post-title {
  color: var(--q-color-text);
  text-decoration: none;
  transition: color 0.15s ease;
}

.post-title:hover {
  color: var(--q-primary);
  text-decoration: underline;
}

.topic-chip {
  font-weight: 600;
  transition: opacity 0.15s ease;
  &:hover {
    opacity: 0.85;
  }
}

:deep() .mdstyle img {
  max-width: 100%;
  max-height: 448px;
}
:deep() .mdstyle pre,
code,
table {
  max-width: 100%;
  white-space: pre-wrap;
}
:deep() .mdstyle p {
  max-width: 100%;
  word-break: break-word;
  line-height: 1.5;
  margin-bottom: 0.5rem;
}
:deep() .mdstyle h1,
h2,
h3,
h4 {
  font-size: 120%;
  font-weight: bold;
  line-height: inherit;
}
</style>
