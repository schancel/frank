import { defineStore } from 'pinia'
import { reactive } from 'vue'
import { uniq } from 'ramda'

import {
  activeChain,
  DirectMessagePreparationProgress,
  WalletHandle,
} from '@frank/wallet/chain'

import type { ForumMessage, ForumMessageEntry } from '@frank/wallet/forum-model'
import { refreshAfterBurn } from 'src/utils/burn-refresh-error'
import { DEFAULT_TOPIC_NAMES } from 'src/stores/default-topics'
import { accountStatus } from 'src/accounts/session'
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
  voteThreshold: string
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

// Request authority is session-only and never serialized with observations.
const refreshContexts = new WeakMap<object, object>()
const viewRequests = new WeakMap<object, Map<string, object>>()

/** Build rows, index and acyclic reply links privately, then publish in one Pinia patch. */
export function forumSnapshot(rows: ForumMessage[]): {
  messages: MessageWithReplies[]
  index: Record<string, MessageWithReplies>
} {
  const index: Record<string, MessageWithReplies> = Object.create(null)
  for (const row of rows) index[row.payloadDigest] = { ...row, replies: [] }
  const messages = Object.values(index)
  const acyclic = new Map<string, boolean>()
  for (const row of messages) {
    const trail = new Set<string>()
    let ancestor: MessageWithReplies | undefined = row
    while (
      ancestor &&
      !acyclic.has(ancestor.payloadDigest) &&
      !trail.has(ancestor.payloadDigest)
    ) {
      trail.add(ancestor.payloadDigest)
      ancestor = ancestor.parentDigest
        ? index[ancestor.parentDigest]
        : undefined
    }
    const valid = !ancestor || acyclic.get(ancestor.payloadDigest) === true
    for (const digest of trail) acyclic.set(digest, valid)
    if (valid && row.parentDigest && index[row.parentDigest])
      index[row.parentDigest].replies.push(row)
  }
  return { messages, index }
}

// All app Forum queries share one staging slot, including overlapping refresh generations.
// Queued obsolete requests never start another client snapshot.
let forumReadTail = Promise.resolve()
export async function stageForumQuery<T>(
  read: () => Promise<T>,
  isCurrent: () => boolean,
): Promise<T | undefined> {
  const previous = forumReadTail
  let release!: () => void
  forumReadTail = new Promise<void>(resolve => {
    release = resolve
  })
  await previous
  try {
    return isCurrent() ? await read() : undefined
  } finally {
    release()
  }
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
    voteThreshold: '0',
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
          typeof message.voteWeightWei !== 'string' ||
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
      this.invalidateRefresh()
      this.duration = duration
    },
    setVoteThreshold(voteThreshold: string) {
      this.voteThreshold = String(voteThreshold)
    },

    setEntries(messages: ForumMessage[]) {
      const snapshot = forumSnapshot(messages)
      this.$patch(state => {
        state.messages = snapshot.messages
        state.index = snapshot.index
        state.topics = uniq(snapshot.messages.map(message => message.topic))
      })
    },
    setMessage(message: ForumMessage) {
      this.setEntries([
        ...this.messages.filter(
          row => row.payloadDigest !== message.payloadDigest,
        ),
        message,
      ])
    },
    invalidateRefresh() {
      refreshContexts.delete(this)
      viewRequests.delete(this)
      this.isRefreshing = false
    },
    setSelectedTopic(topic: string) {
      this.invalidateRefresh()
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
    async topicsToFetch(
      selected: string,
      isCurrent: () => boolean = () => true,
    ): Promise<string[]> {
      const discovered = await stageForumQuery(
        () => activeChain.topics.discoverTopics(),
        isCurrent,
      )
      if (!discovered) return []
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
      const token = {
        wallet: wallet.identity.address.raw.toLowerCase(),
        chain: activeChain,
        revision: accountStatus.revision,
        status: accountStatus.status,
        selected: this.selectedTopic,
        duration: this.duration,
      }
      refreshContexts.set(this, token)
      const current = () =>
        refreshContexts.get(this) === token &&
        activeChain === token.chain &&
        accountStatus.revision === token.revision &&
        accountStatus.status === token.status &&
        this.selectedTopic === token.selected &&
        this.duration === token.duration
      this.isRefreshing = true
      try {
        const from = Date.now() - this.duration
        const names = await this.topicsToFetch(topic, current)
        if (!current()) return
        // Sequential query staging bounds aggregate memory instead of allocating one full
        // 64 MiB client snapshot per discovered topic. Each query publishes atomically.
        let failures = 0
        let firstError: unknown
        for (const name of names) {
          try {
            const entries = await stageForumQuery(
              () =>
                activeChain.topics.fetchByTopic({
                  wallet,
                  topic: name,
                  sinceMs: from,
                }),
              current,
            )
            if (!current()) return
            if (!entries) throw new Error('Incomplete Forum query')
            this.setEntries([
              ...this.messages.filter(message => message.topic !== name),
              ...entries,
            ])
          } catch (error) {
            if (!current()) return
            failures++
            firstError ??= error
          }
        }
        if (!current()) return
        this.hasFetchedOnce = true
        this.outageStatus =
          failures === 0
            ? 'ok'
            : failures === names.length
            ? 'outage'
            : 'degraded'
        if (failures) throw firstError
      } catch (error) {
        if (!current()) return
        this.hasFetchedOnce = true
        if (this.outageStatus !== 'degraded') this.outageStatus = 'outage'
        throw error
      } finally {
        if (current()) this.isRefreshing = false
      }
    },
    async refreshOperationStatus({ wallet }: { wallet: WalletHandle }) {
      await activeChain.topics.reconcileOperations({ wallet })
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
      satoshis: bigint
      topic: string
      parentDigest?: string
      onPreparationProgress?: (
        progress: DirectMessagePreparationProgress,
      ) => void
    }) {
      if (satoshis <= 0n || satoshis > 9223372036854775807n)
        throw new Error('Invalid Forum post amount')
      const { payloadDigest } = await activeChain.topics.post({
        wallet,
        topic,
        entries: [entry],
        direction: satoshis >= 0n ? 'up' : 'down',
        voteWeightWei: satoshis < 0n ? -satoshis : satoshis,
        parentDigest,
        onPreparationProgress,
      })
      await refreshAfterBurn('post', () => this.fetchMessage({ payloadDigest }))
    },
    async fetchMessage({
      payloadDigest,
      isCurrent,
    }: {
      payloadDigest: string
      isCurrent?: () => boolean
    }) {
      // Note: `ActiveChain.topics.fetchOne` takes no `wallet` -- reading a public topic post
      // never needed a sender identity to begin with.
      const token = refreshContexts.get(this)
      const revision = accountStatus.revision
      const status = accountStatus.status
      const selected = this.selectedTopic
      const chain = activeChain
      const request = {}
      const requests = viewRequests.get(this) ?? new Map<string, object>()
      viewRequests.set(this, requests)
      requests.set(payloadDigest, request)
      const current = () =>
        (!isCurrent || isCurrent()) &&
        viewRequests.get(this) === requests &&
        requests.get(payloadDigest) === request &&
        refreshContexts.get(this) === token &&
        accountStatus.revision === revision &&
        accountStatus.status === status &&
        activeChain === chain &&
        this.selectedTopic === selected
      const message = await stageForumQuery(
        () => activeChain.topics.fetchOne(payloadDigest),
        current,
      )
      if (!message) {
        console.log('could not fetch message', payloadDigest)
        return
      }
      if (isCurrent && !isCurrent()) return
      if (
        viewRequests.get(this) !== requests ||
        requests.get(payloadDigest) !== request ||
        refreshContexts.get(this) !== token ||
        accountStatus.revision !== revision ||
        accountStatus.status !== status ||
        activeChain !== chain ||
        this.selectedTopic !== selected
      )
        return
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
      satoshis: bigint
    }) {
      console.log('voting towards message', payloadDigest, satoshis)
      await activeChain.topics.vote({
        wallet,
        payloadDigest,
        direction: satoshis >= 0n ? 'up' : 'down',
        voteWeightWei: satoshis < 0n ? -satoshis : satoshis,
      })
      await refreshAfterBurn('vote', () => this.fetchMessage({ payloadDigest }))
    },
  },
  storage: {
    save(storage, _mutation, state): Promise<void> {
      const messages = state.messages.map(
        ({ replies: _replies, ...row }) => row,
      )
      return storage.put(
        'forum',
        JSON.stringify({ ...state, messages, index: {} }),
      )
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
        // Cached observations are unverified after restart, especially old number rows.
        messages: [],
        index: {},
        voteThreshold:
          typeof deserializedForum.voteThreshold === 'string'
            ? deserializedForum.voteThreshold
            : '0',
        hasFetchedOnce: false,
        outageStatus: 'ok',
        isRefreshing: false,
      }
    },
  },
})
