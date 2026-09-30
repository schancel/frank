import { defineStore } from 'pinia'
import { LevelDB } from 'level'

/**
 * A blackjack wager that was PAID on-chain but whose `bet` message was not (confirmed) delivered
 * to the dealer (#310). The dealer bot only acts on messages it receives, so without this record
 * the wager would be stranded with no trace in the app. The record is written (and flushed to
 * storage) right after the transfer succeeds and BEFORE the message is attempted; it is removed
 * only once the send succeeded. "Retry" re-sends the bet message for the SAME `wagerTxHash` and
 * `gameId`: the bot claims each transaction hash for one stake, so a duplicate is answered with
 * "already authorized" and can never create a second game or charge.
 */
export interface UnsentWager {
  gameId: string
  wagerTxHash: string
  dealerAddress: string
  /** Decimal wei string (JSON-safe). */
  amountWei: string
  createdAt: number
}

export interface State {
  wagers: UnsentWager[]
  /** Hashes whose bet message is being sent RIGHT NOW by this page (never persisted: after a
   * reload nothing is in flight, so an interrupted send shows up as unsent). */
  inFlight: string[]
}

const KEY = 'unsentWagers'

export function saveUnsentWagers(
  storage: LevelDB,
  state: State,
): Promise<void> {
  return storage.put(KEY, JSON.stringify({ wagers: state.wagers }))
}

export async function restoreUnsentWagers(
  storage: LevelDB,
): Promise<Partial<State>> {
  try {
    const parsed = JSON.parse(await storage.get(KEY)) as Partial<State>
    const wagers = Array.isArray(parsed.wagers)
      ? parsed.wagers.filter(
          w =>
            typeof w?.gameId === 'string' &&
            typeof w?.wagerTxHash === 'string' &&
            typeof w?.dealerAddress === 'string',
        )
      : []
    return { wagers }
  } catch {
    return {}
  }
}

export const useUnsentWagersStore = defineStore('unsentWagers', {
  state: (): State => ({ wagers: [], inFlight: [] }),
  getters: {
    forDealer: state => (address: string) =>
      state.wagers.filter(
        w => w.dealerAddress.toLowerCase() === address.toLowerCase(),
      ),
    /** Records that need the player's attention: unsent and not being sent right now. */
    stranded(): (address: string) => UnsentWager[] {
      return address =>
        this.forDealer(address).filter(
          w => !this.inFlight.includes(w.wagerTxHash),
        )
    },
  },
  actions: {
    /** Idempotent per `wagerTxHash`: one transaction is one record. */
    add(wager: UnsentWager) {
      if (this.wagers.some(w => w.wagerTxHash === wager.wagerTxHash)) return
      this.wagers.push(wager)
    },
    remove(wagerTxHash: string) {
      this.wagers = this.wagers.filter(w => w.wagerTxHash !== wagerTxHash)
      this.setInFlight(wagerTxHash, false)
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
