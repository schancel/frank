<template>
  <q-card class="forum-post-card q-ma-sm" flat bordered>
    <q-card-section class="column q-pa-none post-main-content">
      <forum-parent-link
        v-if="parentDigest"
        :digest="parentDigest"
        :label="parentLabel"
        class="q-px-md q-pt-sm"
      />
      <div
        class="post-meta-header q-px-md q-pt-sm q-pb-xs row items-center justify-between wrap"
        style="gap: 4px"
      >
        <div
          class="row items-center wrap text-caption text-grey-7 author-pill"
          style="gap: 4px"
        >
          <span class="text-caption text-grey-6 row items-center">
            <span>{{ timestamp }}</span>
            <q-tooltip>{{ fullTimestamp }}</q-tooltip>
          </span>
          <span>{{ submittedByLabel }}</span>
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
          <account-badge
            v-if="authorAddress(message)"
            :address="authorAddress(message)"
            :account-type="authorProfile(message)?.accountType"
            :bot-role="authorProfile(message)?.botRole"
            :is-bot="authorProfile(message)?.isBot"
          />
        </div>
        <q-chip
          v-if="message.topic"
          outline
          dense
          size="sm"
          color="primary"
          class="topic-chip cursor-pointer q-ma-none"
          clickable
          @click.prevent="$emit('set-topic', message.topic)"
        >
          #{{ message.topic }}
        </q-chip>
      </div>

      <template
        v-for="(entry, index) in message.entries.filter(
          entry => entry.kind === 'post' || entry.kind === 'game',
        )"
        :key="index"
      >
        <div
          v-if="
            entry.kind === 'post' && (displayTitle(entry.title) || entry.url)
          "
          class="row items-center justify-between q-px-md q-pt-xs q-pb-xs"
        >
          <div class="col-grow post-title-wrap">
            <a
              :href="entry.url"
              target="_blank"
              v-if="entry.url"
              class="post-title text-subtitle1 text-weight-bold"
              >{{ displayTitle(entry.title) || entry.url }}</a
            >
            <router-link
              v-if="!entry.url && displayTitle(entry.title)"
              :to="`/forum/${message.payloadDigest}`"
              class="post-title text-subtitle1 text-weight-bold"
              >{{ displayTitle(entry.title) }}</router-link
            >
          </div>
        </div>

        <div
          class="q-px-md q-pt-xs q-pb-sm col-grow post-body"
          v-if="entry.kind === 'post' && renderBody"
        >
          <div
            class="mdstyle text-body2"
            v-external-images
            v-html="markedMessage(entry.message, entry.title)"
          />
          <game-announcement-card
            v-if="getAnnouncement(entry)"
            :announcement="getAnnouncement(entry)!"
          />
        </div>

        <div
          v-if="entry.kind === 'game'"
          class="row items-center justify-between q-px-md q-pt-xs q-pb-xs"
        >
          <div class="col-grow post-title-wrap">
            <router-link
              :to="`/forum/${message.payloadDigest}`"
              class="post-title text-subtitle1 text-weight-bold"
              >{{
                entry.title || getAnnouncement(entry)?.gameName || 'Game Table'
              }}</router-link
            >
          </div>
        </div>

        <div
          class="q-px-md q-pt-xs q-pb-sm col-grow post-body"
          v-if="entry.kind === 'game' && renderBody"
        >
          <div
            v-if="entry.message"
            class="mdstyle text-body2"
            v-external-images
            v-html="markedMessage(entry.message, entry.title)"
          />
          <game-announcement-card
            v-if="getAnnouncement(entry)"
            :announcement="getAnnouncement(entry)!"
          />
        </div>
      </template>

      <q-card-actions
        class="post-footer q-px-md q-py-sm row items-center wrap"
        style="gap: 8px"
      >
        <div
          class="forum-vote-pill row items-center no-wrap"
          data-test="forum-vote-pill"
        >
          <q-btn
            flat
            dense
            round
            size="sm"
            icon="arrow_upward"
            :aria-label="$t('a11y.voteUp')"
            :disable="isVoting"
            :loading="isVoting && activeVoteDirection === 1"
            @click="addVotes(1)"
            data-test="forum-vote-up"
            class="vote-btn upvote-btn"
          />
          <div
            class="vote-weight-pill text-caption text-weight-bold text-center q-px-xs"
            :title="formatExactVoteWeight(displayedVoteWeight)"
          >
            {{ formatVoteWeight(displayedVoteWeight) }}
          </div>
          <q-btn
            flat
            dense
            round
            size="sm"
            icon="arrow_downward"
            :aria-label="$t('a11y.voteDown')"
            :disable="isVoting"
            :loading="isVoting && activeVoteDirection === -1"
            @click="addVotes(-1)"
            data-test="forum-vote-down"
            class="vote-btn downvote-btn"
          />
        </div>

        <q-btn
          no-caps
          unelevated
          rounded
          dense
          size="sm"
          icon="chat_bubble_outline"
          class="forum-action-pill comments-btn text-caption q-px-sm"
          :label="String(message.replies.length)"
          :aria-label="`${message.replies.length} comments`"
          :to="`/forum/${message.payloadDigest}`"
        >
          <q-tooltip>{{ `${message.replies.length} comments` }}</q-tooltip>
        </q-btn>

        <q-btn
          no-caps
          unelevated
          rounded
          dense
          size="sm"
          icon="reply"
          class="forum-action-pill reply-btn text-caption q-px-sm"
          label="Reply"
          :to="`/new-post/${message.payloadDigest}`"
        />

        <div
          v-if="voteStatus"
          class="text-caption text-italic row items-center"
          role="status"
          data-test="vote-status"
        >
          <q-spinner-dots size="1.2em" color="primary" class="q-mr-xs" />
          <span>{{ voteStatus }}</span>
        </div>
      </q-card-actions>
      <a-message-replies :messages="message.replies" v-if="showReplies" />
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
import { vExternalImages } from '../../utils/external-images'

import AMessageReplies from './ForumMessageReplies.vue'
import ForumParentLink from './ForumParentLink.vue'
import GameAnnouncementCard from 'components/topic/GameAnnouncementCard.vue'
import AccountBadge from 'src/components/contacts/AccountBadge.vue'
import { authorDisplayProfile } from 'src/utils/author-display-profile'
import { parseGameAnnouncement } from 'src/utils/game-announcement'

import { MessageWithReplies, useForumStore } from 'src/stores/forum'
import { useContactStore } from 'src/stores/contacts'
import { useProfileStore } from 'src/stores/my-profile'
import { useActiveWallet } from 'src/composables/useActiveWallet'
import {
  notifyBurnFailure,
  BurnRefreshError,
} from 'src/utils/burn-refresh-error'
import { activeChain } from '@frank/wallet/chain'
import { formatCompactAmount, formatRawAmount } from 'src/utils/chain-amount'
import { stampPreparationStatus } from 'src/utils/stamp-preparation-status'
import {
  isKnownOwnAddress,
  sameCanonicalAddress,
  useReactiveOwnCanonicalAddress,
  useReactiveOwnAddresses,
} from 'src/utils/own-address'

export default defineComponent({
  setup() {
    const forumStore = useForumStore()
    const contactStore = useContactStore()
    let profileStore:
      | ReturnType<typeof useProfileStore>
      | { profile: Record<string, unknown> }
    try {
      profileStore = useProfileStore()
    } catch {
      profileStore = { profile: {} }
    }
    const { messages, topics, selectedTopic } = storeToRefs(forumStore)

    return {
      storeMessages: messages,
      getMessage: forumStore.getMessage,
      forumStore,
      isOwnPost: (digest?: string) =>
        typeof (forumStore as any)?.isOwnPost === 'function'
          ? (forumStore as any).isOwnPost(digest)
          : false,
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
      ownAddresses: useReactiveOwnAddresses(),
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
  directives: { externalImages: vExternalImages },
  components: {
    AMessageReplies,
    ForumParentLink,
    GameAnnouncementCard,
    AccountBadge,
  },
  data() {
    return {
      timeoutId: undefined as ReturnType<typeof setTimeout> | undefined,
      voteAmount: 0n,
      localVoteDelta: 0n,
      isVoting: false,
      activeVoteDirection: 0,
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
    this.activeVoteDirection = 0
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
      return formatCompactAmount(activeChain, value)
    },
    formatExactVoteWeight(value: string) {
      return formatRawAmount(activeChain, value)
    },
    getAnnouncement(entry?: any) {
      return parseGameAnnouncement(entry, this.message)
    },
    displayTitle(title?: string): string {
      const t = String(title ?? '').trim()
      if (!t || t.toLowerCase() === 'untitled') return ''
      return t
    },
    markedMessage(text?: string, title?: string) {
      let cleaned = (text ?? '').replace(
        /<!--\s*GAME_ANNOUNCEMENT:.*?-->/gs,
        '',
      )
      const trimmedTitle = String(title ?? '').trim()
      if (trimmedTitle) {
        const leadingTrimmed = cleaned.trimStart()
        if (leadingTrimmed.startsWith(trimmedTitle)) {
          const rest = leadingTrimmed.slice(trimmedTitle.length)
          if (rest.startsWith('\n') || rest.startsWith('\r\n')) {
            cleaned = rest.replace(/^(\r?\n)+/, '')
          }
        }
      }
      return renderMarkdown(cleaned, this.$q.dark.isActive)
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
      if ((msg as any).isOwn || (msg as any).isLocal || (msg as any).own) {
        return true
      }
      if (
        msg.payloadDigest &&
        (this.isOwnPost?.(msg.payloadDigest) ||
          this.forumStore?.isOwnPost?.(msg.payloadDigest))
      ) {
        return true
      }
      const poster = msg.poster
      if (poster) {
        if (isKnownOwnAddress(poster, this.ownAddresses)) {
          return true
        }
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
        const profile = authorDisplayProfile(this.myProfile?.profile)
        return profile.name || profile?.username || 'You'
      }
      if (msg.poster && this.haveContact(msg.poster)) {
        const contactProfile = authorDisplayProfile(
          this.getContactProfile(msg.poster),
        )
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
        authorDisplayProfile(this.getContactProfile(msg.poster)).name
      ) {
        return false
      }
      return Boolean(msg.poster)
    },
    authorAddress(message?: MessageWithReplies): string {
      const msg = message ?? this.message
      if (this.isAuthorMe(msg)) {
        const profileAddr = (this.myProfile?.profile as any)?.address
        if (profileAddr) return profileAddr
        const own =
          typeof this.ownAddress === 'object' &&
          this.ownAddress !== null &&
          'value' in this.ownAddress
            ? (this.ownAddress as any).value
            : this.ownAddress
        return own || msg?.poster || ''
      }
      return msg?.poster || ''
    },
    authorProfile(message?: MessageWithReplies) {
      const msg = message ?? this.message
      if (this.isAuthorMe(msg)) {
        return authorDisplayProfile(this.myProfile?.profile)
      }
      if (msg?.poster && this.haveContact(msg.poster)) {
        return authorDisplayProfile(this.getContactProfile(msg.poster))
      }
      return undefined
    },
    resolveVoteUnitValue(): bigint {
      const customDisplay = String(
        this.forumStore?.voteAmountDisplay ?? '',
      ).trim()
      if (customDisplay) {
        try {
          const parsed = activeChain.fromDisplayAmount(customDisplay)
          if (parsed > 0n) {
            return parsed
          }
        } catch {
          // Fall back to defaultTopicVoteValue
        }
      }
      return activeChain.defaultTopicVoteValue
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

      const delta = BigInt(direction) * this.resolveVoteUnitValue()
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
          this.activeVoteDirection = 0
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
          this.activeVoteDirection = satoshis >= 0n ? 1 : -1
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
              this.activeVoteDirection = 0
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
            this.activeVoteDirection = 0
            this.votePreparationStatus = null
            this.setStampPreparationStatus?.(null)
          }
        })()
      }, 1_000)
    },
  },
  computed: {
    submittedByLabel(): string {
      return 'submitted by'
    },
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
      if (!this.message || !this.message.timestamp) {
        return ''
      }
      return moment(this.message.timestamp).fromNow()
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
      return this.parentDigest ? this.getMessage(this.parentDigest) : null
    },
    parentLabel(): string {
      const parent = this.parentMessage
      if (!parent) return ''
      const title = parent.entries.find(entry => entry.kind === 'post')?.title
      return this.displayTitle(title) || this.authorName(parent)
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

body.body--dark .forum-post-card {
  background: #1c1613;
  border-color: rgba(255, 255, 255, 0.08);
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.2);

  &:hover {
    border-color: rgba(255, 255, 255, 0.18);
    box-shadow: 0 4px 14px rgba(0, 0, 0, 0.35);
  }
}

.forum-vote-pill {
  border-radius: 999px;
  background: rgba(0, 0, 0, 0.05);
  padding: 2px 6px;
}

body.body--dark .forum-vote-pill {
  background: rgba(255, 255, 255, 0.08);
}

.forum-action-pill {
  border-radius: 999px;
  background: rgba(0, 0, 0, 0.05);
  color: inherit;
  transition: background 0.15s ease, color 0.15s ease;
  &:hover:not(:disabled) {
    background: rgba(0, 0, 0, 0.1);
  }
}

body.body--dark .forum-action-pill {
  background: rgba(255, 255, 255, 0.08);
  &:hover:not(:disabled) {
    background: rgba(255, 255, 255, 0.14);
  }
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
