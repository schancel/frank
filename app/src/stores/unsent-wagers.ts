import { defineStore } from 'pinia'
import { LevelDB } from 'level'

/**
 * A blackjack wager that may have been PAID on-chain and whose outcome at the dealer is not yet
 * proven (#310). The dealer bot only acts on messages it receives and answers a bet with a
 * `blackjack-move` (accepted) or a game-tagged error, so a wager is only safe to forget once one
 * of those replies arrived. The record's `state` says how far the flow got:
 *
 * - `signed`: the transfer was signed and this record was flushed to storage BEFORE the broadcast.
 *   The payment may or may not have reached the chain (a lost broadcast response, a killed app);
 *   only the node can say, so this state is reconciled by asking the node about `wagerTxHash`.
 * - `paid`: the node reports the transfer mined; the bet message is not delivered yet.
 * - `sent`: the bet message was delivered (`sentAt`); waiting for the dealer's reply.
 *
 * "Retry" re-sends the bet message for the SAME `wagerTxHash` and `gameId` (the bot claims each
 * transaction hash for one stake, so a duplicate is answered "already authorized" and can never
 * create a second game or charge). It never builds a second transfer.
 *
 * Records are keyed by the paying wallet (`walletAddress`) as well as the dealer, so another
 * account on the same browser never sees or is blocked by them; they are not deleted on account
 * replace (re-importing the old seed brings them back).
 */
export type UnsentWagerState = 'signed' | 'paid' | 'sent'

export interface UnsentWager {
  gameId: string
  wagerTxHash: string
  dealerAddress: string
  /** Canonical address of the wallet that signed the wager. */
  walletAddress: string
  /** Decimal wei string (JSON-safe). */
  amountWei: string
  createdAt: number
  state: UnsentWagerState
  /** When the bet message was delivered (`sent` only). */
  sentAt?: number
  /** Chat messages that existed when the bet was (re)sent: only later ones can answer it. */
  seenMessages?: number
}

export interface State {
  wagers: UnsentWager[]
  /** Hashes whose flow is running RIGHT NOW in this page (never persisted: after a reload
   * nothing is in flight, so an interrupted flow shows up for reconciliation). */
  inFlight: string[]
  /** The stored records could not be read. Saving is then refused (so the unreadable value is
   * never overwritten) and adding a record throws, which aborts a new wager before broadcast. */
  loadError: string
}

const KEY = 'unsentWagers'

export function saveUnsentWagers(
  storage: LevelDB,
  state: State,
): Promise<void> {
  if (state.loadError) return Promise.resolve() // never overwrite what we could not read
  return storage.put(KEY, JSON.stringify({ wagers: state.wagers }))
}

function isNotFound(err: unknown): boolean {
  const e = err as { notFound?: boolean; type?: string; message?: string }
  return (
    e?.notFound === true ||
    e?.type === 'NotFoundError' ||
    /not ?found/i.test(e?.message ?? '')
  )
}

export async function restoreUnsentWagers(
  storage: LevelDB,
): Promise<Partial<State>> {
  let raw: string
  try {
    raw = await storage.get(KEY)
  } catch (err) {
    if (isNotFound(err)) return {}
    return {
      loadError: `Saved wager records could not be read: ${
        err instanceof Error ? err.message : String(err)
      }`,
    }
  }
  try {
    const parsed = JSON.parse(raw) as Partial<State>
    if (!Array.isArray(parsed.wagers)) throw new Error('unexpected format')
    const wagers = parsed.wagers
      .filter(
        w =>
          typeof w?.gameId === 'string' &&
          typeof w?.wagerTxHash === 'string' &&
          typeof w?.dealerAddress === 'string',
      )
      .map(w => ({
        ...w,
        walletAddress: w.walletAddress ?? '',
        state: w.state ?? 'paid',
      }))
    return { wagers }
  } catch (err) {
    return {
      loadError: `Saved wager records are unreadable: ${
        err instanceof Error ? err.message : String(err)
      }`,
    }
  }
}

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase()

export const useUnsentWagersStore = defineStore('unsentWagers', {
  state: (): State => ({ wagers: [], inFlight: [], loadError: '' }),
  getters: {
    /** Records of one wallet to one dealer. */
    forDealer: state => (address: string, wallet: string) =>
      state.wagers.filter(
        w => same(w.dealerAddress, address) && same(w.walletAddress, wallet),
      ),
  },
  actions: {
    /** Idempotent per `wagerTxHash`. Throws if storage was unreadable (nothing may be saved). */
    add(wager: UnsentWager) {
      if (this.loadError) throw new Error(this.loadError)
      if (this.wagers.some(w => w.wagerTxHash === wager.wagerTxHash)) return
      this.wagers.push(wager)
    },
    remove(wagerTxHash: string) {
      this.wagers = this.wagers.filter(w => w.wagerTxHash !== wagerTxHash)
      this.setInFlight(wagerTxHash, false)
    },
    setState(
      wagerTxHash: string,
      state: UnsentWagerState,
      sentAt?: number,
      seenMessages?: number,
    ) {
      const wager = this.wagers.find(w => w.wagerTxHash === wagerTxHash)
      if (!wager) return
      wager.state = state
      wager.sentAt = sentAt
      wager.seenMessages = seenMessages
    },
    setInFlight(wagerTxHash: string, on: boolean) {
      const without = this.inFlight.filter(h => h !== wagerTxHash)
      this.inFlight = on ? [...without, wagerTxHash] : without
    },
  },
  storage: {
    save(storage, _mutation, state): Promise<void> {
      return saveUnsentWagers(storage, state)
    },
    restore(storage): Promise<Partial<State>> {
      return restoreUnsentWagers(storage)
    },
  },
})
