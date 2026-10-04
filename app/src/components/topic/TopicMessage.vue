<template>
  <div>
    <q-separator />
    <div class="row q-ml-sm q-mr-sm q-mb-sm">
      <q-btn
        no-caps
        flat
        padding="0"
        :to="`/chat/${message.poster}`"
        class="q-pa-none q-mt-xs text-center"
      >
        <div v-if="haveContact(message.poster)">
          {{ getContactProfile(message.poster)?.name }}
        </div>
        <div v-else>{{ formatAddress(message.poster) }}</div>
      </q-btn>
      <q-space />
      <span class="q-pa-none q-mt-xs text-center">{{ message.topic }}</span>
      <q-card-section class="q-pa-none q-mt-xs text-center">
        <q-btn
          flat
          icon="arrow_drop_up"
          padding="0"
          :aria-label="$t('a11y.voteUp')"
          @click="addVotes(1)"
          data-test="forum-vote-up"
        />
      </q-card-section>
      <q-card-section class="q-pa-none q-mt-xs text-center"
        >{{ formttedAmount }}</q-card-section
      >
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
      <span class="q-pa-none q-mt-xs text-center">
        {{ timestamp }}
        <q-tooltip>{{ fullTimestamp }}</q-tooltip>
      </span>
    </div>

    <template v-for="(entry, index) in message.entries" :key="index">
      <div
        :v-if="entry.kind === 'post'"
        class="q-ma-none q-pa-none col-grow q-ml-lg"
      >
        <a
          :href="entry.url"
          target="_blank"
          v-if="entry.url"
          class="post-title"
          >{{ entry.title || 'untitled' }}</a
        >
        <span class="mdstyle" v-html="markedMessage(entry.message)" />
      </div>
    </template>
  </div>
</template>

<script lang="ts">
import moment from 'moment'
import { accountStatus } from 'src/accounts/session'
import { activeChain } from '@frank/wallet/chain'
import { formatRawAmount } from 'src/utils/chain-amount'
import { computed, defineComponent } from 'vue'
import type { PropType } from 'vue'

import { renderMarkdown } from '../../utils/markdown'
import { useContactStore } from 'src/stores/contacts'

import type { ForumMessage } from '@frank/wallet/forum-model'
import { useTopicStore } from 'src/stores/topics'
import { useActiveWallet } from 'src/composables/useActiveWallet'
import { notifyBurnFailure } from 'src/utils/burn-refresh-error'

export default defineComponent({
  setup(props) {
    const contactStore = useContactStore()

    return {
      timeoutId: null as ReturnType<typeof setTimeout> | null,
      voteAmount: 0n,
      voteActive: true,
      voteTarget: null as string | null,
      voteOwnerRevision: null as number | null,
      voteOwnerStatus: null as string | null,
      getContactProfile: contactStore.getContactProfile,
      haveContact: contactStore.haveContact,
      formttedAmount: computed(() => {
        return formatRawAmount(activeChain, props.message.voteWeightWei)
      }),
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
      type: Object as PropType<ForumMessage>,
      required: true,
    },
    topic: {
      required: true,
      type: String,
    },
  },
  unmounted() {
    this.voteActive = false
    if (this.timeoutId) clearTimeout(this.timeoutId)
    this.voteAmount = 0n
  },
  methods: {
    markedMessage(text?: string) {
      return renderMarkdown(text ?? '', this.$q.dark.isActive)
    },
    formatAddress(address: string) {
      return '...' + address.substring(address.length - 10, address.length)
    },
    addVotes(votes: number) {
      if (this.voteTarget !== this.message.payloadDigest || this.voteOwnerRevision !== accountStatus.revision || this.voteOwnerStatus !== accountStatus.status) this.voteAmount = 0n
      this.voteTarget = this.message.payloadDigest
      this.voteOwnerRevision = accountStatus.revision
      this.voteOwnerStatus = accountStatus.status

      const topicStore = useTopicStore()
      const topic = this.topic
      this.voteAmount += BigInt(votes)
      console.log('adding votes', this.voteAmount)
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
            await topicStore.addOffering({
              wallet,
              payloadDigest: digest,
              satoshis:
                satoshis * BigInt(topicStore.topics[topic]?.offering ?? activeChain.defaultTopicVoteValue.toString()),
              topic,
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
</style>
