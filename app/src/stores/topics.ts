import { toRaw } from 'vue'
import { stageForumQuery } from './forum'
import { accountStatus } from 'src/accounts/session'
import { defineStore } from 'pinia'
import { readStoreJson } from 'src/boot/pinia'
import { DEFAULT_TOPIC_NAMES } from 'src/stores/default-topics'

import { activeChain } from '@frank/wallet/chain'

import type { DiscoveredTopic } from '@frank/wallet/forum-model'

/**
 * The forum's topic names: the default ones, the ones the user added (AddTopic) and the ones
 * the relay reports (discovery). The forum's posts, votes and filters are the forum store's
 * (`stores/forum.ts`); this store only lists topics.
 */

type Topic = string

export type TopicData = {
  topic: string
}

export interface State {
  discoveredTopics: Record<string, DiscoveredTopic>
  discoveryStatus: 'unverified' | 'verified' | 'error'
  discoveryError: string | null
  topics: Record<Topic, TopicData>
}

interface ReducedState {
  topics: TopicData[]
}

const discoveryRequests = new WeakMap<object, object>()

export const useTopicStore = defineStore('topics', {
  state: (): State => ({
    discoveredTopics: {},
    discoveryStatus: 'unverified',
    discoveryError: null,
    topics: {},
  }),
  getters: {
    getTopics(state) {
      return Object.keys(state.topics)
    },
  },
  actions: {
    ensureTopic(topic: string): TopicData {
      if (!this.topics) {
        this.topics = {}
      }
      if (!(topic in this.topics)) {
        this.topics[topic] = { topic }
      }
      return this.topics[topic]
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
          topics[topic] = { topic }
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
  },
  storage: {
    save(storage, _mutation, state): Promise<void> {
      const reduced: ReducedState = {
        topics: Object.values(state.topics).map(({ topic }) => ({ topic })),
      }
      return storage.put('topics', JSON.stringify(reduced))
    },
    async restore(storage): Promise<Partial<State>> {
      const saved = await readStoreJson<Partial<ReducedState>>(
        storage,
        'topics',
      )
      const topics: Record<Topic, TopicData> = Object.fromEntries(
        DEFAULT_TOPIC_NAMES.map(topic => [topic, { topic }]),
      )
      for (const row of Array.isArray(saved?.topics) ? saved.topics : []) {
        if (row && typeof row.topic === 'string')
          topics[row.topic] = { topic: row.topic }
      }
      return {
        discoveredTopics: {},
        discoveryStatus: 'unverified',
        discoveryError: null,
        topics,
      }
    },
  },
})
