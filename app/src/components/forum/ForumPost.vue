<template>
  <q-card class="q-pa-none q-ma-sm" flat bordered>
    <q-card-section class="row" horizontal>
      <q-card-section class="col-shrink q-pa-none q-ma-none bg-on-secondary">
        <q-card-section class="q-pa-none q-ma-none text-center">
          <q-btn flat icon="arrow_drop_up" padding="0" @click="addVotes(1)" />
        </q-card-section>
        <q-card-section class="q-pa-none q-ma-none text-center">
          <q-btn
            flat
            icon="arrow_drop_down"
            padding="0"
            @click="addVotes(-1)"
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
            class="q-ma-none q-pa-none col-grow text-bold"
          >
            <a
              :href="entry.url"
              target="_blank"
              v-if="entry.url"
              class="post-title"
              >{{ entry.title || 'untitled' }}</a
            >
            <router-link
              v-if="!entry.url"
              :to="`/forum/${message.payloadDigest}`"
              class="post-title"
              >{{ entry.title || 'untitled' }}</router-link
            >
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
          <span>{{ formatVoteWeight(message.satoshis) }} by</span>
          <q-btn
            no-caps
            flat
            stretch
            dense
            :to="`/chat/${message.poster}`"
            class="q-pa-none q-ma-none"
          >
            <div v-if="haveContact(message.poster)">
              {{ getContactProfile(message.poster).name }}
            </div>
            <div v-else>{{ formatAddress(message.poster) }}</div>
          </q-btn>
          <q-space />
          <span class="q-ma-none q-pa-none q-pr-sm">
            {{ timestamp }}
            <q-tooltip>{{ fullTimestamp }}</q-tooltip>
          </span>
          <q-btn
            no-caps
            flat
            stretch
            dense
            class="q-pa-none q-ma-none"
            :label="`${message.replies.length} comments`"
            :to="`/forum/${message.payloadDigest}`"
          />
          <q-btn
            no-caps
            flat
            stretch
            dense
            class="q-pa-none q-ma-none"
            label="reply"
            :to="`/new-post/${message.payloadDigest}`"
          />
        </q-card-actions>
        <a-message-replies :messages="message.replies" v-if="showReplies" />
      </q-card-section>
    </q-card-section>
  </q-card>
</template>

<script lang="ts">
import moment from 'moment'
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
import { formatSafeRawAmount, rawToSafeNumber } from 'src/utils/chain-amount'

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
        satoshis: 0,
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
      voteAmount: 0,
    }
  },
  emits: ['set-topic'],
  methods: {
    formatVoteWeight(value: number) {
      return formatSafeRawAmount(activeChain, value)
    },
    markedMessage(text: string) {
      return renderMarkdown(text, this.$q.dark.isActive)
    },
    formatAddress(address: string) {
      return (
        address.substring(6, 12) +
        '...' +
        address.substring(address.length - 6, address.length)
      )
    },
    addVotes(direction: number) {
      this.voteAmount +=
        direction *
        rawToSafeNumber(activeChain, activeChain.defaultTopicVoteValue)
      if (this.timeoutId) {
        clearTimeout(this.timeoutId)
      }
      this.timeoutId = setTimeout(() => {
        void (async () => {
          if (this.voteAmount === 0) {
            return
          }
          console.log('Adding votes', {
            payloadDigest: this.message?.payloadDigest,
            satoshis: this.voteAmount,
          })
          // The votes being sent are consumed either way: a failed burn is reported, never
          // silently kept and re-sent on top of the next click (ticket #273).
          const satoshis = this.voteAmount
          this.voteAmount = 0
          try {
            const wallet = await useActiveWallet()
            await this.addOffering({
              wallet,
              payloadDigest: this.message?.payloadDigest,
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
