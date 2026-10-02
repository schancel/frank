import { defineStore } from 'pinia'
import { reactive } from 'vue'
import { indexBy, uniq } from 'ramda'

import {
  activeChain,
  DirectMessagePreparationProgress,
  WalletHandle,
} from '@frank/wallet/chain'

import { ForumMessage, ForumMessageEntry } from '@frank/cashweb/types/forum'
import { refreshAfterBurn } from 'src/utils/burn-refresh-error'
import { DEFAULT_TOPIC_NAMES } from 'src/stores/default-topics'
import { SortMode } from 'src/utils/sorting'

export type MessageWithReplies = ForumMessage & {
  replies: MessageWithReplies[]
  timestamp: Date | string
}

export type ForumOutageStatus = 'ok' | 'degraded' | 'outage'

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
  outageStatus: ForumOutageStatus
  isRefreshing: boolean
}

export type ForumPostReservationStatus = 'in-flight' | 'outcome-unknown'

type ForumPostReservation = {
  id: number
  status: ForumPostReservationStatus
}

// Session-only economic ownership for paid forum submissions. This deliberately lives outside
// Pinia's persisted State: it must survive page unmount/remount, but a process restart must not
// manufacture a crash-retry policy or a durable operation journal. The public chain identity is
// stable across independently-created handles for the same account and contains no seed material.
const forumPostReservations = reactive(new Map<string, ForumPostReservation>())
let nextForumPostReservationId = 0

function forumPostReservationKey(
  wallet: WalletHandle,
  destination: string,
): string {
  return `${wallet.identity.address.raw.toLowerCase()}\u0000${destination}`
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
    outageStatus: 'ok',
    isRefreshing: false,
  }),
  getters: {
    getMessage(state) {
      return (messageDigest?: string) => {
        console.log('messageDigest', messageDigest)
        if (
          !messageDigest ||
          !Object.prototype.hasOwnProperty.call(state.index, messageDigest)
        ) {
          return null
        }
        const message = state.index[messageDigest]
        if (
          !message ||
          message.payloadDigest !== messageDigest ||
          typeof message.topic !== 'string' ||
          !Array.isArray(message.entries)
        ) {
          return null
        }
        return message
      }
    },
  },
  actions: {
    getPostReservationId({
      wallet,
      destination,
    }: {
      wallet: WalletHandle
      destination: string
    }): number | undefined {
      return forumPostReservations.get(
        forumPostReservationKey(wallet, destination),
      )?.id
    },
    reservePostSubmission({
      wallet,
      destination,
    }: {
      wallet: WalletHandle
      destination: string
    }): number | undefined {
      const reservationKey = forumPostReservationKey(wallet, destination)
      if (forumPostReservations.has(reservationKey)) return undefined
      const id = ++nextForumPostReservationId
      forumPostReservations.set(reservationKey, { id, status: 'in-flight' })
      return id
    },
    releasePostSubmission({
      wallet,
      destination,
      reservationId,
    }: {
      wallet: WalletHandle
      destination: string
      reservationId: number
    }): boolean {
      const reservationKey = forumPostReservationKey(wallet, destination)
      const reservation = forumPostReservations.get(reservationKey)
      if (reservation?.id !== reservationId) {
        return false
      }
      return forumPostReservations.delete(reservationKey)
    },
    markPostSubmissionOutcomeUnknown({
      wallet,
      destination,
      reservationId,
    }: {
      wallet: WalletHandle
      destination: string
      reservationId: number
    }): boolean {
      const reservationKey = forumPostReservationKey(wallet, destination)
      const reservation = forumPostReservations.get(reservationKey)
      if (reservation?.id !== reservationId) {
        return false
      }
      reservation.status = 'outcome-unknown'
      return true
    },
    getPostReservationStatus({
      wallet,
      destination,
    }: {
      wallet: WalletHandle
      destination: string
    }): ForumPostReservationStatus | undefined {
      return forumPostReservations.get(
        forumPostReservationKey(wallet, destination),
      )?.status
    },
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
        const parent = this.getMessage(message.parentDigest)
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
            ? this.getMessage(ancestor.parentDigest) ?? undefined
            : undefined
        }
        if (cyclic) {
          continue
        }
        parent.replies.push(message)
      }
    },
    setMessage(message: ForumMessage) {
      const oldMessage = this.getMessage(message.payloadDigest)
      if (oldMessage) {
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
      const parent = this.getMessage(mesageWithReplies.parentDigest)
      if (!parent) return
      const replies = parent.replies
      const found = replies?.some(
        reply => reply.payloadDigest === mesageWithReplies.payloadDigest,
      )
      if (found) {
        return
      }
      parent.replies.push(mesageWithReplies)
    },
    setSelectedTopic(topic: string) {
      this.selectedTopic = topic
    },
    pushNewTopic(topic: string) {
      this.topics.push(topic)
    },
    /**
     * Topic names one refresh asks the relay for (ticket #365). The relay only serves posts for an
     * exact topic name, so "all topics" means: the default topics, every topic the relay has
     * discovered, and any topic we already hold posts for. A non-empty `selected` narrows this to
     * that topic plus the known topics it prefixes (matching `Forum.vue`'s prefix filter).
     */
    async topicsToFetch(selected: string): Promise<string[]> {
      const discovered = await activeChain.topics.discoverTopics()
      const known = [
        ...DEFAULT_TOPIC_NAMES,
        ...discovered.map(entry => entry.topic),
        ...this.topics,
      ]
      const wanted = selected
        ? [selected, ...known.filter(name => name.startsWith(selected))]
        : known
      return uniq(wanted.filter(name => name !== ''))
    },
    async refreshMessages({
      wallet,
      topic,
    }: {
      topic: string
      wallet: WalletHandle
    }) {
      console.log('fetching messages')
      this.isRefreshing = true
      try {
        const from = Date.now() - this.duration
        const names = await this.topicsToFetch(topic)
        const results = await Promise.allSettled(
          names.map(name =>
            activeChain.topics.fetchByTopic({
              wallet,
              topic: name,
              sinceMs: from,
            }),
          ),
        )
        const failures = results.filter(
          (result): result is PromiseRejectedResult =>
            result.status === 'rejected',
        )
        for (const failure of failures) {
          console.error('forum: topic fetch failed', failure.reason)
        }
        this.hasFetchedOnce = true
        // If every topic fetch failed, record the outage state and exit loading before re-throwing
        // so callers can handle the rejection and the UI can show an accessible outage/retry view.
        if (results.length > 0 && failures.length === results.length) {
          this.outageStatus = 'outage'
          throw failures[0].reason
        }
        if (failures.length > 0) {
          this.outageStatus = 'degraded'
        } else {
          this.outageStatus = 'ok'
        }
        const entries = results.flatMap(result =>
          result.status === 'fulfilled' ? result.value ?? [] : [],
        )
        this.setEntries(entries)
      } finally {
        this.isRefreshing = false
      }
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
      return {
        ...deserializedForum,
        isRefreshing: false,
      }
    },
  },
})
