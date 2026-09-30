import { defineStore } from 'pinia'

/**
 * Health of the direct-message mailbox poll loop (ticket #271), so the UI can say so when the
 * inbox is not actually being read. Before this, every failure branch of
 * `adapters/pinia-chain-adapter.ts`'s poller only logged to the console, and an unreadable inbox
 * looked exactly like an empty one.
 *
 * Deliberately not persisted (no `storage` option): it describes the current session's last poll
 * and must start as `ok` after a reload rather than show a stale problem.
 */
export type MailboxPollState =
  /** The last poll succeeded (or none has failed yet). */
  | 'ok'
  /** The relay has no mailbox routes (404): messaging is disabled or unsupported there. */
  | 'unavailable'
  /** The relay could not be reached, or kept failing (network, 5xx, ...). */
  | 'unreachable'
  /** The relay asked us to slow down (429). */
  | 'rate-limited'
  /** The relay rejected the mailbox login (401). */
  | 'unauthorized'

export interface MailboxStatusState {
  state: MailboxPollState
  /** Delay until the next poll, when the poller is backing off. */
  retryInMs: number | null
}

export const useMailboxStatusStore = defineStore('mailbox-status', {
  state: (): MailboxStatusState => ({ state: 'ok', retryInMs: null }),
  getters: {
    hasProblem: state => state.state !== 'ok',
  },
  actions: {
    setOk() {
      this.state = 'ok'
      this.retryInMs = null
    },
    setProblem(state: Exclude<MailboxPollState, 'ok'>, retryInMs: number) {
      this.state = state
      this.retryInMs = retryInMs
    },
  },
})
