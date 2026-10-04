import { toRaw } from 'vue'
import assert from 'assert'
import { forumSnapshot, stageForumQuery } from './forum'
import { accountStatus } from 'src/accounts/session'
import { refreshAfterBurn } from 'src/utils/burn-refresh-error'
import { defineStore } from 'pinia'
import { DEFAULT_TOPIC_NAMES } from 'src/stores/default-topics'

import { activeChain, WalletHandle } from '@frank/wallet/chain'

import type {
  DiscoveredTopic,
  ForumMessage,
  ForumMessageEntry,
} from '@frank/wallet/forum-model'

export type MessageWithReplies = ForumMessage & {
  replies: MessageWithReplies[]
}

type Topic = string

const defaultOffering = activeChain.defaultTopicVoteValue.toString()
// How far back should we fetch messages if we have never fetched?
const defaultFetchDuration = Date.now() - 1000 * 60 * 60 * 24 * 7
const defaultTopics = DEFAULT_TOPIC_NAMES.map(topic => ({
  topic,
  threshold: '0',
  offering: defaultOffering,
  messages: [],
}))

export type TopicData = {
  threshold: string
  offering: string
  messages: MessageWithReplies[]
  topic: string
  // Last update from Epoch in seconds
  lastUpdate?: number
}

export interface State {
  discoveredTopics: Record<string, DiscoveredTopic>
  discoveryStatus: 'unverified' | 'verified' | 'error'
  discoveryError: string | null
  topics: Record<Topic, TopicData>
  messageIndex: Record<string, MessageWithReplies | undefined>
}

export type ReducedTopicData = {
  threshold: string
  offering: string
  // These will be reborn from the messageIndex
  messages: string[]
  topic: string
  // Last update from Epoch in seconds
  lastUpdate?: number
}

interface ReducedState {
  topics: ReducedTopicData[]
  messageIndex: Record<string, ForumMessage | undefined>
}

const topicRequests = new WeakMap<object, Map<string, object>>()
const topicViews = new WeakMap<object, Map<string, object>>()
const topicWallets = new WeakMap<object, string>()
const discoveryRequests = new WeakMap<object, object>()

export const useTopicStore = defineStore('topics', {
  state: (): State => ({
    discoveredTopics: {},
    discoveryStatus: 'unverified',
    discoveryError: null,
    topics: {},
    messageIndex: {},
  }),
  getters: {
    getMessage(state) {
      return (messageDigest?: string) => {
        if (!messageDigest) {
          return null
        }
        return state.messageIndex[messageDigest]
      }
    },
    getTopics(state) {
      return Object.keys(state.topics)
    },
  },
  actions: {
    deleteTopic(topic: string) {
      this.invalidateRefresh()
      delete this.topics[topic]
    },
    ensureTopic(topic: string): TopicData {
      if (!this.topics) {
        this.topics = {}
      }

      if (!(topic in this.topics)) {
        this.topics[topic] = {
          threshold: '0',
          messages: [],
          topic,
          offering: defaultOffering,
          lastUpdate: defaultFetchDuration,
        }
      }
      return this.topics[topic]
    },
    setVoteThreshold(topic: string, voteThreshold: string) {
      const topicState = this.ensureTopic(topic)
      topicState.threshold = voteThreshold
    },
    setEntries(topic: string, messages: ForumMessage[], until: number) {
      const topicState = this.ensureTopic(topic)
      const snapshot = forumSnapshot(messages)
      const other = Object.fromEntries(
        Object.entries(this.messageIndex).filter(
          ([, row]) => row?.topic !== topic,
        ),
      )
      this.$patch(state => {
        state.topics = {
          ...state.topics,
          [topic]: {
            ...topicState,
            messages: snapshot.messages,
            lastUpdate: until,
          },
        }
        state.messageIndex = { ...other, ...snapshot.index }
      })
    },
    setMessage(topic: string, message: ForumMessage) {
      this.setEntries(
        topic,
        [
          ...this.ensureTopic(topic).messages.filter(
            row => row.payloadDigest !== message.payloadDigest,
          ),
          message,
        ],
        Date.now(),
      )
    },
    invalidateRefresh() {
      topicRequests.delete(toRaw(this.$state))
      topicViews.delete(toRaw(this.$state))
      discoveryRequests.delete(toRaw(this.$state))
    },
    async refreshMessages({
      topic,
      wallet,
    }: {
      topic: string
      wallet: WalletHandle
    }) {
      const owner = wallet.identity.address.raw.toLowerCase()
      if (topicWallets.get(toRaw(this.$state)) !== owner)
        this.invalidateRefresh()
      topicWallets.set(toRaw(this.$state), owner)
      const requests =
        topicRequests.get(toRaw(this.$state)) ?? new Map<string, object>()
      topicRequests.set(toRaw(this.$state), requests)
      const token = {}
      requests.set(topic, token)
      const revision = accountStatus.revision
      const status = accountStatus.status
      const chain = activeChain
      const to = Date.now()
      const current = () =>
        topicRequests.get(toRaw(this.$state)) === requests &&
        requests.get(topic) === token &&
        accountStatus.revision === revision &&
        accountStatus.status === status &&
        activeChain === chain
      const entries = await stageForumQuery(
        () =>
          activeChain.topics.fetchByTopic({
            wallet,
            topic,
            sinceMs: to - 1000 * 60 * 60 * 24 * 7,
          }),
        current,
      )
      if (
        topicRequests.get(toRaw(this.$state)) !== requests ||
        requests.get(topic) !== token ||
        accountStatus.revision !== revision ||
        accountStatus.status !== status ||
        activeChain !== chain
      )
        return
      if (!entries) throw new Error('Incomplete topic query')
      this.setEntries(topic, entries, to)
    },
    async putMessage({
      wallet,
      topic,
      entry,
      parentDigest,
    }: {
      wallet: WalletHandle
      entry: ForumMessageEntry
      topic: string
      parentDigest?: string
    }) {
      const topicData = this.ensureTopic(topic)
      const satoshis = BigInt(topicData.offering)
      if (satoshis <= 0n || satoshis > 9223372036854775807n)
        throw new Error('Invalid Forum post amount')
      const { payloadDigest } = await activeChain.topics.post({
        wallet,
        topic,
        entries: [entry],
        direction: satoshis >= 0n ? 'up' : 'down',
        voteWeightWei: satoshis < 0n ? -satoshis : satoshis,
        parentDigest,
      })
      await refreshAfterBurn('post', () =>
        this.fetchMessage({ topic, payloadDigest }),
      )
    },
    async fetchMessage({
      payloadDigest,
      topic,
    }: {
      payloadDigest: string
      topic: string
    }) {
      // Note: `ActiveChain.topics.fetchOne` takes no `wallet` -- reading a public topic post
      // never needed a sender identity to begin with.
      const revision = accountStatus.revision
      const status = accountStatus.status
      const chain = activeChain
      const requests =
        topicViews.get(toRaw(this.$state)) ?? new Map<string, object>()
      topicViews.set(toRaw(this.$state), requests)
      const key = `${topic}\u0000${payloadDigest}`
      const token = {}
      requests.set(key, token)
      const current = () =>
        topicViews.get(toRaw(this.$state)) === requests &&
        requests.get(key) === token &&
        accountStatus.revision === revision &&
        accountStatus.status === status &&
        activeChain === chain
      const message = await stageForumQuery(
        () => activeChain.topics.fetchOne(payloadDigest),
        current,
      )
      if (!message) {
        console.log('could not fetch message', payloadDigest)
        return
      }
      if (
        topicViews.get(toRaw(this.$state)) !== requests ||
        requests.get(key) !== token ||
        accountStatus.revision !== revision ||
        accountStatus.status !== status ||
        activeChain !== chain ||
        message.topic !== topic
      )
        return
      this.setMessage(topic, message)
      // Need to refetch so we get the right proxy object
      return this.getMessage(payloadDigest)
    },
    async refreshDiscoveredTopics() {
      const revision = accountStatus.revision
      const status = accountStatus.status
      const chain = activeChain
      const token = {}
      discoveryRequests.set(toRaw(this.$state), token)
      let discovered
      try {
        discovered = await stageForumQuery(
          () => activeChain.topics.discoverTopics(),
          () =>
            discoveryRequests.get(toRaw(this.$state)) === token &&
            revision === accountStatus.revision &&
            status === accountStatus.status &&
            activeChain === chain,
        )
        for (const row of discovered ?? []) {
          if (
            typeof row.postCount !== 'string' ||
            !/^(0|[1-9][0-9]*)$/.test(row.postCount) ||
            row.postCount.length > 20 ||
            BigInt(row.postCount) > 18446744073709551615n
          ) {
            throw new Error('Invalid canonical topic post count')
          }
        }
      } catch (error) {
        if (
          discoveryRequests.get(toRaw(this.$state)) !== token ||
          revision !== accountStatus.revision ||
          status !== accountStatus.status ||
          activeChain !== chain
        )
          return false
        this.$patch({
          discoveryStatus: 'error',
          discoveryError:
            error instanceof Error ? error.message : String(error),
        })
        return false
      }
      if (
        discoveryRequests.get(toRaw(this.$state)) !== token ||
        revision !== accountStatus.revision ||
        status !== accountStatus.status ||
        activeChain !== chain
      )
        return
      if (!discovered) return false
      const topics = { ...this.topics }
      for (const { topic } of discovered) {
        if (!Object.prototype.hasOwnProperty.call(topics, topic)) {
          topics[topic] = {
            topic,
            threshold: '0',
            offering: defaultOffering,
            messages: [],
          }
        }
      }
      const discoveredTopics = Object.fromEntries(
        discovered.map(row => [row.topic, { ...row }]),
      )
      this.$patch(state => {
        state.topics = topics
        state.discoveredTopics = discoveredTopics
        state.discoveryStatus = 'verified'
        state.discoveryError = null
      })
      return true
    },
    async addOffering({
      wallet,
      payloadDigest,
      satoshis,
      topic,
    }: {
      wallet: WalletHandle
      payloadDigest: string
      satoshis: bigint
      topic: string
    }) {
      console.log('voting towards message', payloadDigest, satoshis)
      await activeChain.topics.vote({
        wallet,
        payloadDigest,
        direction: satoshis >= 0n ? 'up' : 'down',
        voteWeightWei: satoshis < 0n ? -satoshis : satoshis,
      })
      await refreshAfterBurn('vote', () =>
        this.fetchMessage({ topic, payloadDigest }),
      )
    },
  },
  storage: {
    save(storage, _mutation, state): Promise<void> {
      const reduceState = (): ReducedState => {
        const topics: ReducedTopicData[] = Object.values(state.topics).map(
          topic => ({
            ...topic,
            messages: topic.messages.map(message => message.payloadDigest),
          }),
        )
        return {
          topics,
          messageIndex: Object.fromEntries(
            Object.entries(state.messageIndex)
              .filter(([, row]) => row)
              .map(([digest, row]) => {
                const { replies: _replies, ...observation } = row!
                return [digest, observation]
              }),
          ),
        }
      }
      const reducedState = reduceState()
      return storage.put('topics', JSON.stringify(reducedState))
    },
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    async restore(storage): Promise<Partial<State>> {
      const processSerializedTopics = (
        deserializedState: Partial<ReducedState>,
      ): State => {
        const hydratedState: State = {
          discoveredTopics: {},
          discoveryStatus: 'unverified',
          discoveryError: null,
          messageIndex: {},
          // Add default topics
          topics: Object.fromEntries(
            defaultTopics.map(topic => {
              return [topic.topic, topic]
            }),
          ),
        }
        const messageIndex = hydratedState.messageIndex

        if (!('topics' in deserializedState)) {
          deserializedState.topics = []
        }
        if (!(deserializedState.topics instanceof Array)) {
          deserializedState.topics = []
        }
        assert(deserializedState.topics)
        // This should work on the old serialized state
        for (const topic of deserializedState.topics) {
          const validMessages = topic.messages.filter(
            payloadDigest => payloadDigest in messageIndex,
          )
          hydratedState.topics[topic.topic] = {
            ...topic,
            threshold:
              typeof topic.threshold === 'string' ? topic.threshold : '0',
            offering:
              typeof topic.offering === 'string'
                ? topic.offering
                : defaultOffering,
            lastUpdate: undefined,
            // Persisted observations are unverified after restart.
            messages: validMessages.map(
              payloadDigest => messageIndex[payloadDigest],
            ) as MessageWithReplies[],
          }
        }

        return hydratedState
      }

      try {
        const topics = await storage.get('topics')
        const deserializedTopics = JSON.parse(topics) as Partial<ReducedState>
        console.log('loaded topics', deserializedTopics)
        return processSerializedTopics(deserializedTopics)
      } catch (err) {
        console.log('Unable to load topics store', err)
      }
      return processSerializedTopics({
        messageIndex: {},
        topics: [],
      })
    },
  },
})
