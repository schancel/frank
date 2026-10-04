<template>
  <q-card class="q-pa-none" :class="{ 'q-ma-sm': !compact }" flat bordered>
    <q-card-section class="row" horizontal>
      <q-card-section class="col-shrink q-pa-sm bg-on-secondary">
        <q-card-section class="q-pa-none text-center">
          <q-btn
            flat
            icon="arrow_drop_up"
            padding="0"
            :aria-label="$t('a11y.voteUp')"
            @click="addVotes(1)"
          data-test="forum-vote-up"
          />
        </q-card-section>
        <q-card-section class="q-pa-none q-mt-xs text-center">{{
          formatVoteWeight(message.voteWeightWei)
        }}</q-card-section>
        <q-card-section class="q-pa-none q-mt-xs text-center">
          <q-btn
            flat
            icon="arrow_drop_down"
            padding="0"
            :aria-label="$t('a11y.voteDown')"
            @click="addVotes(-1)"
          data-test="forum-vote-down"
          />
        </q-card-section>
      </q-card-section>
      <q-card-section class="q-ma-none q-pa-none col" vertical>
        <template
          v-for="(entry, index) in message.entries.filter(
            entry => entry.kind === 'post',
          )"
          :key="index"
        >
          <q-card-section
            horizontal
            class="q-ma-none q-pa-sm col-grow text-bold"
          >
            <q-icon name="link" v-if="entry.url" class="text-h6 q-pa-xs" />
            <a
              :href="entry.url"
              target="_blank"
              v-if="entry.url"
              class="text-h6 text-bold q-mr-md post-title"
              >{{ entry.title || 'untitled' }}</a
            >
            <span v-if="!entry.url" class="text-h6 text-bold q-mr-md">
              {{ entry.title || 'untitled' }}
            </span>
            <q-space />
            <a
              class="q-pr-sm post-title"
              @click.prevent="$emit('set-topic', message.topic)"
              >{{ message.topic }}</a
            >
          </q-card-section>
          <q-card-section
            class="q-ma-none q-px-sm q-pt-none q-pb-sm col-grow"
            v-if="renderBody"
          >
            <span class="mdstyle" v-html="markedMessage(entry.message)" />
          </q-card-section>
        </template>
        <q-card-actions class="q-ma-none q-pa-none">
          <q-btn no-caps flat stretch dense :to="`/chat/${message.poster}`">
            <div v-if="haveContact(message.poster)">
              {{ getContactProfile(message.poster).name }}
            </div>
            <div v-else>{{ formatAddress(message.poster) }}</div>
          </q-btn>
          <div class="text-bold q-ml-sm text-caption">
            {{ timestamp }}
            <q-tooltip>{{ fullTimestamp }}</q-tooltip>
          </div>
          <q-btn
            flat
            no-caps
            icon="forum"
            class="q-ml-md"
            :label="`${message.replies.length} replies`"
            :to="`/forum/${message.payloadDigest}`"
          />
          <q-btn
            flat
            no-caps
            icon="reply"
            label="Reply"
            class="q-ml-sm"
            :to="`/new-post/${message.payloadDigest}`"
          />
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
      </q-card-section>
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
import { useActiveWallet } from 'src/composables/useActiveWallet'
import { notifyBurnFailure } from 'src/utils/burn-refresh-error'
import { activeChain } from '@frank/wallet/chain'
import { formatRawAmount } from 'src/utils/chain-amount'

export default defineComponent({
  setup() {
    const forumStore = useForumStore()
    const contactStore = useContactStore()
    const { messages, topics, selectedTopic } = storeToRefs(forumStore)

    return {
      storeMessages: messages,
      getMessage: forumStore.getMessage,
      topics,
      getContactProfile: contactStore.getContactProfile,
      haveContact: contactStore.haveContact,
      selectedTopic,
      addOffering: forumStore.addOffering,
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
    this.voteAmount = 0n
  },
  methods: {
    formatVoteWeight(value: string) {
      return formatRawAmount(activeChain, value)
    },
    markedMessage(text?: string) {
      return renderMarkdown(text ?? '', this.$q.dark.isActive)
    },
    formatAddress(address: string) {
      return (
        address.substring(6, 12) +
        '...' +
        address.substring(address.length - 6, address.length)
      )
    },
    addVotes(direction: number) {
      if (this.voteTarget !== this.message.payloadDigest || this.voteOwnerRevision !== accountStatus.revision || this.voteOwnerStatus !== accountStatus.status) this.voteAmount = 0n
      this.voteTarget = this.message.payloadDigest
      this.voteOwnerRevision = accountStatus.revision
      this.voteOwnerStatus = accountStatus.status

      this.voteAmount +=
        BigInt(direction) *
        activeChain.defaultTopicVoteValue
      if (this.timeoutId) {
        clearTimeout(this.timeoutId)
      }
      const digest = this.message.payloadDigest
      const revision = accountStatus.revision
      const status = accountStatus.status
      this.timeoutId = setTimeout(() => {
        if (!this.voteActive || this.message.payloadDigest !== digest || accountStatus.revision !== revision || accountStatus.status !== status) { this.voteAmount = 0n; return }
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
          try {
            const wallet = await useActiveWallet()
            if (!this.voteActive || this.message.payloadDigest !== digest || accountStatus.revision !== revision || accountStatus.status !== status) return
            await this.addOffering({
              wallet,
              payloadDigest: digest,
              satoshis,
            })
          } catch (err) {
            notifyBurnFailure(err, key => this.$t(key))
          }
        })()
      }, 1_000)
    },
  },
  computed: {
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

<style scoped>
:deep() .mdstyle img {
  max-width: 100%;
  max-height: 448px;
}
:deep() .mdstyle pre,
code,
table {
  /*overflow-wrap: break-word;*/
  max-width: 100%;
  white-space: pre-wrap;
}
:deep() .mdstyle p {
  max-width: 100%;
  word-break: break-word;
}
:deep() .mdstyle h1,
h2,
h3,
h4 {
  font-size: 120%;
  font-weight: bold;
  line-height: inherit;
}

.post-title {
  color: var(--q-color-text);
  text-decoration: none;
}

.post-title:hover {
  text-decoration: underline;
}
</style>
