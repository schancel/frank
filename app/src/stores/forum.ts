import assert from 'assert'
import { defineStore } from 'pinia'
import { indexBy, uniq } from 'ramda'

import {
  activeChain,
  DirectMessagePreparationProgress,
  WalletHandle,
} from '@frank/wallet/chain'

import { ForumMessage, ForumMessageEntry } from '@frank/cashweb/types/forum'
import { refreshAfterBurn } from 'src/utils/burn-refresh-error'
import { SortMode } from 'src/utils/sorting'

export type MessageWithReplies = ForumMessage & {
  replies: MessageWithReplies[]
  timestamp: Date | string
}

export interface State {
  messages: MessageWithReplies[]
  index: Record<string, MessageWithReplies | undefined>
  topics: string[]
  selectedTopic: string
  sortMode: SortMode
  duration: number
  voteThreshold: number
  /** Ticket #61: distinguishes "still fetching" from "fetched, genuinely no posts" -- Forum.vue's
   * own perpetual loading spinner (found live) couldn't tell the two apart before this existed. */
  hasFetchedOnce: boolean
}

export const useForumStore = defineStore('forum', {
  state: (): State => ({
    messages: [],
    index: {},
    topics: [],
    selectedTopic: '',
    sortMode: 'hot',
    // 1 week
    duration: 1000 * 60 * 60 * 24 * 7,
    voteThreshold: 0,
    hasFetchedOnce: false,
  }),
  getters: {
    getMessage(state) {
      return (messageDigest?: string) => {
        console.log('messageDigest', messageDigest)
        if (!messageDigest) {
          return null
        }
        return state.index[messageDigest]
      }
    },
  },
  actions: {
    setSortMode(sortMode: SortMode) {
      this.sortMode = sortMode
    },
    setDuration(duration: number) {
      this.duration = duration
    },
    setVoteThreshold(voteThreshold: number) {
      this.voteThreshold = voteThreshold
    },

    setEntries(messages: ForumMessage[]) {
      const canonicalByDigest = new Map<string, MessageWithReplies>()
      const canonicalMessages: MessageWithReplies[] = []
      for (const message of this.messages) {
        if (canonicalByDigest.has(message.payloadDigest)) {
          continue
        }
        canonicalByDigest.set(message.payloadDigest, message)
        canonicalMessages.push(message)
      }
      this.messages = canonicalMessages

      for (const message of messages) {
        const existingMessage = canonicalByDigest.get(message.payloadDigest)
        if (existingMessage) {
          existingMessage.satoshis = message.satoshis
          continue
        }

        const newMessage: MessageWithReplies = { ...message, replies: [] }
        this.messages.push(newMessage)
        const canonicalMessage = this.messages[this.messages.length - 1]
        canonicalByDigest.set(message.payloadDigest, canonicalMessage)
      }

      this.index = indexBy(message => message.payloadDigest, this.messages)
      this.topics = uniq(messages.map(message => message.topic))
      for (const message of this.messages) {
        message.replies = []
      }
      for (const message of this.messages) {
        if (!message.parentDigest) {
          continue
        }
        const parent = this.index[message.parentDigest]
        if (!parent) {
          continue
        }
        const visitedDigests = new Set([message.payloadDigest])
        let ancestor: MessageWithReplies | undefined = parent
        let cyclic = false
        while (ancestor) {
          if (visitedDigests.has(ancestor.payloadDigest)) {
            cyclic = true
            break
          }
          visitedDigests.add(ancestor.payloadDigest)
          ancestor = ancestor.parentDigest
            ? this.index[ancestor.parentDigest]
            : undefined
        }
        if (cyclic) {
          continue
        }
        parent.replies.push(message)
      }
    },
    setMessage(message: ForumMessage) {
      if (message.payloadDigest in this.index) {
        const oldMessage = this.index[message.payloadDigest]
        assert(oldMessage, 'Not possible, typescript hole')
        oldMessage.satoshis = message.satoshis
        return
      }
      const containsPost = message.entries.some(entry => entry.kind === 'post')
      if (!containsPost) {
        return
      }

      console.log('Saving specific message', message)
      const mesageWithReplies = { ...message, replies: [] }
      this.messages.push(mesageWithReplies)
      this.index = indexBy(message => message.payloadDigest, this.messages)
      this.topics = uniq(this.messages.map(message => message.topic))
      if (!mesageWithReplies.parentDigest) {
        return
      }
      if (!(mesageWithReplies.parentDigest in this.index)) {
        return
      }
      const replies = this.index[mesageWithReplies.parentDigest]?.replies
      const found = replies?.some(
        reply => reply.payloadDigest === mesageWithReplies.payloadDigest,
      )
      if (found) {
        return
      }
      this.index[mesageWithReplies.parentDigest]?.replies.push(
        mesageWithReplies,
      )
    },
    setSelectedTopic(topic: string) {
      this.selectedTopic = topic
    },
    pushNewTopic(topic: string) {
      this.topics.push(topic)
    },
    async refreshMessages({ wallet }: { topic: string; wallet: WalletHandle }) {
      console.log('fetching messages')
      const from = Date.now() - this.duration
      console.log(from)
      // Empty topic == "all topics", matching the old `getBroadcastMessages('', from)` behavior.
      const entries = await activeChain.topics.fetchByTopic({
        wallet,
        topic: '',
        sinceMs: from,
      })
      this.hasFetchedOnce = true
      if (!entries) {
        return
      }
      this.setEntries(entries)
    },
    async putMessage({
      wallet,
      entry,
      satoshis,
      topic,
      parentDigest,
      onPreparationProgress,
    }: {
      wallet: WalletHandle
      entry: ForumMessageEntry
      satoshis: number
      topic: string
      parentDigest?: string
      onPreparationProgress?: (
        progress: DirectMessagePreparationProgress,
      ) => void
    }) {
      // See `stores/topics.ts`'s `putMessage` for the signed-number -> direction/magnitude
      // mapping rationale (same Lotus `RegistryHandler.createBroadcast`/`addOfferings`
      // sign-folding convention this store's callers also produce).
      console.log('posting message')
      const { payloadDigest } = await activeChain.topics.post({
        wallet,
        topic,
        entries: [entry],
        direction: satoshis >= 0 ? 'up' : 'down',
        voteWeightWei: BigInt(Math.abs(satoshis)),
        parentDigest,
        onPreparationProgress,
      })
      await refreshAfterBurn('post', () => this.fetchMessage({ payloadDigest }))
    },
    async fetchMessage({ payloadDigest }: { payloadDigest: string }) {
      // Note: `ActiveChain.topics.fetchOne` takes no `wallet` -- reading a public topic post
      // never needed a sender identity to begin with.
      console.log('fetching message', payloadDigest)
      const message = await activeChain.topics.fetchOne(payloadDigest)
      if (!message) {
        console.log('could not fetch message', payloadDigest)
        return
      }
      this.setMessage(message)
      // Need to refetch so we get the right proxy object
      return this.getMessage(payloadDigest)
    },
    async addOffering({
      wallet,
      payloadDigest,
      satoshis,
    }: {
      wallet: WalletHandle
      payloadDigest: string
      satoshis: number
    }) {
      console.log('voting towards message', payloadDigest, satoshis)
      await activeChain.topics.vote({
        wallet,
        payloadDigest,
        direction: satoshis >= 0 ? 'up' : 'down',
        voteWeightWei: BigInt(Math.abs(satoshis)),
      })
      await refreshAfterBurn('vote', () => this.fetchMessage({ payloadDigest }))
    },
  },
  storage: {
    save(storage, _mutation, state): Promise<void> {
      return storage.put('forum', JSON.stringify(state))
    },
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    async restore(storage): Promise<Partial<State>> {
      let forum = '{}'
      try {
        forum = await storage.get('forum')
      } catch (err) {
        //
      }
      const deserializedForum = JSON.parse(forum) as State
      return deserializedForum
    },
  },
})
