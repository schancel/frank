/**
 * A headless blackjack player/dealer. It is nothing but an ordinary account driving the shared
 * hand state machine (`@frank/wallet/message-item-plugins/blackjack/hand`) with the same messages
 * a person's app sends: it accepts any challenge in the opposite role, and it challenges, as
 * dealer, every account it learns of for the first time. There is no bot-only message, no separate
 * bankroll key and no allowlist. See `docs/protocol/blackjack-p2p.md`.
 *
 * Money is the stamp of a message, so "pay exactly once" is "send that message exactly once". Every
 * message the bot decides to send is first saved in a durable outbox under a key that names the
 * hand and its position; the outbox sends one row at a time and records the wallet's payment
 * attempt as soon as it exists. After a crash the bot asks the wallet what happened to the row in
 * flight before anything is sent again, and a row never gets a second payment.
 *
 * All I/O is behind `BotAccount` and `BotStore`.
 */
import { randomBytes } from 'crypto'
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  writeSync,
} from 'fs'
import { dirname } from 'path'

import { handValue } from '@frank/wallet/message-item-plugins/blackjack/deck'
import { BET_MESSAGE_FEE_RESERVE_WEI } from '@frank/wallet/message-item-plugins/blackjack/game'
import {
  buildAccept,
  buildChallenge,
  dealerStep,
  foldHand,
  handEventsOf,
  maxDealerBetWei,
  maxPlayerBetWei,
  playerMoves,
  refundBetStep,
  roleOf,
  seedFromBytes,
  DEALER_COVER_MULTIPLE,
  type HandEvent,
  type HandItem,
  type HandState,
} from '@frank/wallet/message-item-plugins/blackjack/hand'

export type AttemptStatus = 'live' | 'delivered' | 'dead' | 'unknown'

/** What the bot needs from an ordinary account: its address, its spendable balance, and the same
 * direct-message operations the app uses. */
export interface BotAccount {
  readonly address: string
  /** Balance of the account itself. Stamps it has received are not spendable (#837). */
  spendableWei(): Promise<bigint>
  /** Sends one message whose stamp is `stampWei`. `onAttemptCreated` is called once the wallet has
   * durably journaled this message's one payment set, before it is submitted. */
  send(params: {
    to: string
    item: HandItem
    stampWei: bigint
    onAttemptCreated: (payloadDigest: string) => Promise<void>
  }): Promise<{ payloadDigest: string; stampValueWei: bigint }>
  /** Messages received at or after `sinceMs`, oldest first. */
  receive(sinceMs: number): Promise<
    {
      from: string
      items: readonly { type: string }[]
      stampValueWei: bigint
      payloadDigest: string
      receivedTime: number
    }[]
  >
  /** Re-sends the same bytes of live attempts and reports what is known about each digest. */
  attemptStatus(digests: string[]): Promise<Record<string, AttemptStatus>>
  /** Digests of payment attempts the wallet holds that are not in `knownDigests`. */
  unattributedAttempts(knownDigests: string[]): Promise<string[]>
}

/**
 * `queued`    saved; no send was started.
 * `sending`   a send was started and this store does not know its outcome. The wallet is asked
 *             before anything is sent again.
 * `attempt`   the wallet journaled exactly one payment set for the row (`digest`).
 * `delivered` the relay accepted it. Final.
 * `dead`      the relay ended that payment set. Final: the row is never paid again.
 */
export type OutboxPhase = 'queued' | 'sending' | 'attempt' | 'delivered' | 'dead'

export interface OutboxRow {
  /** One message per key, ever. */
  key: string
  to: string
  item: HandItem
  stampWei: string
  phase: OutboxPhase
  digest?: string
}

interface StoredEvent {
  item: HandItem
  from: string
  to: string
  stampWei: string
  digest: string
}

export interface BotState {
  /** Receive cursor: the latest relay time seen. */
  since: number
  /** Hand logs, per peer address (lowercase) and game. */
  hands: Record<string, Record<string, StoredEvent[]>>
  /** The dealer seeds this account committed to, per peer and game (`peer|gameId`), so a seed is
   * never shared between two hands. Never sent before the reveal. */
  seeds: Record<string, string>
  /** Accounts this bot has already challenged on its own initiative. */
  challenged: Record<string, true>
  outbox: OutboxRow[]
}

/** A map with no prototype: no key (a peer, a game id) can ever name an inherited property. */
const bare = <T>(entries: Record<string, T> = {}): Record<string, T> =>
  Object.assign(Object.create(null), entries)

export const emptyBotState = (): BotState => ({
  since: 0,
  hands: bare(),
  seeds: bare(),
  challenged: bare(),
  outbox: [],
})

/** A loaded state with every keyed map rebuilt without a prototype. */
function bareState(loaded: BotState): BotState {
  const hands = bare<Record<string, StoredEvent[]>>()
  for (const [peer, games] of Object.entries(loaded.hands ?? {}))
    hands[peer] = bare(games)
  return {
    since: loaded.since ?? 0,
    hands,
    seeds: bare(loaded.seeds),
    challenged: bare(loaded.challenged),
    outbox: loaded.outbox ?? [],
  }
}

/** Durable bot state. `save` returns only once the state would survive a kill. */
export interface BotStore {
  load(): BotState
  save(state: BotState): void
}

export class MemoryBotStore implements BotStore {
  private saved = JSON.stringify(emptyBotState())
  load(): BotState {
    return JSON.parse(this.saved)
  }
  save(state: BotState): void {
    this.saved = JSON.stringify(state)
  }
}

/** One JSON file, replaced atomically (write a temporary file, flush it, rename over the old). */
export class FileBotStore implements BotStore {
  constructor(private readonly path: string) {}
  load(): BotState {
    if (!existsSync(this.path)) return emptyBotState()
    return { ...emptyBotState(), ...JSON.parse(readFileSync(this.path, 'utf8')) }
  }
  save(state: BotState): void {
    mkdirSync(dirname(this.path), { recursive: true })
    const temporary = `${this.path}.tmp`
    const fd = openSync(temporary, 'w')
    try {
      writeSync(fd, JSON.stringify(state))
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
    renameSync(temporary, this.path)
  }
}

export interface BotConfig {
  /** The max bet the bot offers when it challenges, and the most it bets as a player. */
  maxBetWei: bigint
  /** The ordinary stamp of a message that carries no money. */
  stampWei: bigint
  /** What the bot keeps back for the fees of its own messages. */
  reserveWei?: bigint
  /** More accounts to challenge, beyond those that message the bot (for example a relay's feed of
   * new registrations). Called every tick; each address is challenged at most once, ever. */
  newAccounts?: () => Promise<string[]>
  randomBytes?: (length: number) => Uint8Array
  log?: (line: string) => void
}

const lower = (address: string) => address.toLowerCase()

export class BlackjackP2pBot {
  private state: BotState
  private readonly reserveWei: bigint
  private readonly random: (length: number) => Uint8Array
  private readonly log: (line: string) => void

  constructor(
    private readonly account: BotAccount,
    private readonly store: BotStore,
    private readonly config: BotConfig,
  ) {
    this.state = bareState(store.load())
    this.reserveWei = config.reserveWei ?? BET_MESSAGE_FEE_RESERVE_WEI
    this.random = config.randomBytes ?? (n => new Uint8Array(randomBytes(n)))
    this.log = config.log ?? (() => undefined)
  }

  /** The folded hand with `peer`, for inspection. */
  hand(peer: string, gameId: string): HandState | undefined {
    return foldHand(this.events(peer, gameId)).state
  }

  outbox(): readonly OutboxRow[] {
    return this.state.outbox
  }

  private events(peer: string, gameId: string): HandEvent[] {
    const games = this.state.hands[lower(peer)]
    const log = games && Object.hasOwn(games, gameId) ? games[gameId] : []
    return log.map(e => ({
      ...e,
      stampWei: BigInt(e.stampWei),
    }))
  }

  private record(peer: string, event: HandEvent): void {
    const games = (this.state.hands[lower(peer)] ??= bare())
    const log = (games[event.item.gameId] ??= [])
    if (log.some(e => e.digest === event.digest)) return
    log.push({ ...event, stampWei: event.stampWei.toString() })
  }

  private save(): void {
    this.store.save(this.state)
  }

  /** One round: settle the outbox, read new messages, decide, send. Safe to call again after any
   * failure or restart. Returns how many messages were delivered this round. */
  async tick(): Promise<number> {
    let delivered = 0
    // A row whose outcome is unknown blocks everything: nothing new is decided or paid until the
    // wallet has said what happened to it.
    if (!(await this.settleOutbox())) return delivered
    await this.receive()
    if (this.config.newAccounts)
      for (const address of await this.config.newAccounts())
        await this.challengeOnce(address)
    for (;;) {
      await this.decide()
      const row = this.state.outbox.find(r => r.phase === 'queued')
      if (!row) return delivered
      if (!(await this.deliver(row))) return delivered
      delivered++
    }
  }

  /** Resolves every row that is neither queued nor final. True when none is left in doubt. */
  private async settleOutbox(): Promise<boolean> {
    for (const row of this.state.outbox) {
      if (row.phase === 'sending') {
        // The process died (or the send failed) before the attempt was recorded here. The wallet
        // knows whether a payment set exists: rows go out one at a time, so an attempt the wallet
        // holds that no row accounts for can only be this row's.
        const known = this.state.outbox.flatMap(r => (r.digest ? [r.digest] : []))
        const orphans = await this.account.unattributedAttempts(known)
        if (orphans.length > 1) {
          this.log(`outbox held: ${orphans.length} unexplained payment attempts`)
          return false
        }
        if (orphans.length === 1) {
          row.digest = orphans[0]
          row.phase = 'attempt'
        } else {
          row.phase = 'queued'
        }
        this.save()
      }
      if (row.phase === 'attempt') {
        const status = (await this.account.attemptStatus([row.digest!]))[row.digest!]
        if (status === 'delivered') this.markDelivered(row)
        else if (status === 'dead') {
          row.phase = 'dead'
          this.save()
          this.log(`message ${row.key} can never be delivered; it is not paid again`)
        } else return false
      }
    }
    return true
  }

  private markDelivered(row: OutboxRow): void {
    row.phase = 'delivered'
    // The bot's own message enters the hand only here, from the outbox, so the hand never
    // contains a message that was not delivered.
    for (const event of handEventsOf({
      items: [row.item],
      senderAddress: this.account.address,
      recipientAddress: row.to,
      stampValueWei: BigInt(row.stampWei),
      payloadDigest: row.digest!,
    }))
      this.record(row.to, event)
    this.save()
  }

  private async deliver(row: OutboxRow): Promise<boolean> {
    row.phase = 'sending'
    this.save()
    try {
      const sent = await this.account.send({
        to: row.to,
        item: row.item,
        stampWei: BigInt(row.stampWei),
        onAttemptCreated: async digest => {
          row.digest = digest
          row.phase = 'attempt'
          this.save()
        },
      })
      row.digest = sent.payloadDigest
      this.markDelivered(row)
      return true
    } catch (error) {
      // Outcome unknown. The row stays `sending` or `attempt`; the next tick asks the wallet.
      this.log(`send ${row.key} did not complete: ${(error as Error).message}`)
      return false
    }
  }

  private async receive(): Promise<void> {
    const messages = await this.account.receive(this.state.since)
    for (const message of messages) {
      // One message can never stop the loop: whatever goes wrong with it, the cursor passes it.
      try {
        for (const event of handEventsOf({
          items: message.items,
          senderAddress: message.from,
          recipientAddress: this.account.address,
          stampValueWei: message.stampValueWei,
          payloadDigest: message.payloadDigest,
        }))
          this.record(message.from, event)
        // An account the bot has never dealt with: challenge it once.
        await this.challengeOnce(message.from, false)
      } catch (error) {
        this.log(
          `message ${message.payloadDigest} skipped: ${(error as Error).message}`,
        )
      }
      this.state.since = Math.max(this.state.since, message.receivedTime)
    }
    this.save()
  }

  private enqueue(key: string, to: string, item: HandItem, stampWei: bigint): void {
    if (this.state.outbox.some(row => row.key === key)) return
    this.state.outbox.push({
      key,
      to,
      item,
      stampWei: stampWei.toString(),
      phase: 'queued',
    })
  }

  /** What this account must be able to pay for hands it has dealt, or has decided to deal. */
  private committedWei(): bigint {
    let total = 0n
    for (const [peer, games] of Object.entries(this.state.hands))
      for (const gameId of Object.keys(games)) {
        const state = this.hand(peer, gameId)
        if (!state || roleOf(state, this.account.address) !== 'dealer') continue
        const dealt = ['player_turn', 'awaiting_card', 'dealer_turn'].includes(
          state.phase,
        )
        const dealing =
          state.phase === 'awaiting_deal' &&
          this.state.outbox.some(
            row =>
              row.key === `${peer}|${gameId}|${state.seen.length}` &&
              row.item.action === 'deal' &&
              row.phase !== 'dead',
          )
        if (dealt || dealing) total += state.wagerWei * DEALER_COVER_MULTIPLE
      }
    return total
  }

  private newSeed(peer: string, gameId: string): string {
    const seed = seedFromBytes(this.random(32))
    this.state.seeds[`${lower(peer)}|${gameId}`] = seed
    return seed
  }

  /** Challenges `address` as dealer, once per address for the life of the store. */
  private async challengeOnce(address: string, persist = true): Promise<void> {
    const peer = lower(address)
    if (peer === lower(this.account.address) || this.state.challenged[peer]) return
    // An account that already opened a hand with the bot needs no invitation.
    const known = Object.keys(this.state.hands[peer] ?? {}).length > 0
    const free = (await this.account.spendableWei()) - this.committedWei()
    const cap = maxDealerBetWei(free, this.reserveWei)
    const maxBetWei = cap < this.config.maxBetWei ? cap : this.config.maxBetWei
    if (!known && maxBetWei < this.config.stampWei) {
      // Not marked: the account is challenged later, once the bot can cover a hand.
      this.log(`cannot cover a challenge to ${address} now`)
      return
    }
    this.state.challenged[peer] = true
    if (!known) {
      const gameId = Buffer.from(this.random(16)).toString('hex')
      const built = buildChallenge({
        gameId,
        role: 'dealer',
        maxBetWei,
        spendableWei: free,
        reserveWei: this.reserveWei,
        seed: this.newSeed(peer, gameId),
      })
      if ('item' in built)
        this.enqueue(`challenge|${peer}`, address, built.item, this.config.stampWei)
    }
    if (persist) this.save()
  }

  /** Queues the bot's next message for every hand that is waiting on it. */
  private async decide(): Promise<void> {
    const own = this.account.address
    let balance: bigint | undefined
    const spendableWei = async () =>
      (balance ??= await this.account.spendableWei())
    for (const [peer, games] of Object.entries(this.state.hands))
      for (const gameId of Object.keys(games)) {
        const events = this.events(peer, gameId)
        const state = foldHand(events).state
        if (!state) continue
        const role = roleOf(state, own)
        const to = role === 'dealer' ? state.player : state.dealer
        // The position in the hand: a hand at the same position always gives the same key.
        const key = `${peer}|${gameId}|${state.seen.length}`
        if (this.state.outbox.some(row => row.key === key)) continue
        // Finished hands with nothing owed need no balance and no message.
        if (
          (state.phase === 'resolved' || state.phase === 'refunded') &&
          state.rejected.every(r => r.refundedWei !== undefined)
        )
          continue
        const spendable = await spendableWei()
        if (role === 'dealer') {
          if (state.phase === 'challenged') {
            const built = buildAccept({
              state,
              spendableWei: spendable - this.committedWei(),
              reserveWei: this.reserveWei,
              seed:
                this.state.seeds[`${peer}|${gameId}`] ??
                this.newSeed(peer, gameId),
            })
            if ('item' in built && BigInt(maxBet(built.item)) >= this.config.stampWei)
              this.enqueue(key, to, built.item, this.config.stampWei)
            else this.log(`cannot cover the challenge ${gameId} from ${peer}`)
            continue
          }
          const seed = this.state.seeds[`${peer}|${gameId}`] ?? ''
          let step = dealerStep(state, seed)
          // A bet the bot can no longer cover (other hands took the money) goes back.
          if (
            step?.item.action === 'deal' &&
            spendable - this.reserveWei <
              this.committedWei() + state.wagerWei * DEALER_COVER_MULTIPLE
          )
            step = refundBetStep(state)
          if (step)
            this.enqueue(key, to, step.item, step.payWei ?? this.config.stampWei)
          continue
        }
        if (role !== 'player') continue
        const moves = playerMoves(state)
        const base = { type: 'blackjack-hand' as const, gameId }
        if (moves.includes('bet')) {
          const own = maxPlayerBetWei(spendable, this.reserveWei)
          const wager = [state.maxBetWei, this.config.maxBetWei, own].reduce((a, b) =>
            a < b ? a : b,
          )
          if (wager >= this.config.stampWei)
            this.enqueue(key, to, { ...base, action: 'bet' }, wager)
          else this.log(`cannot afford a bet in ${gameId}`)
        } else if (moves.length) {
          // The player's choices are few: draw below 17, otherwise stand.
          const action = handValue(state.playerCards).total < 17 ? 'hit' : 'stand'
          this.enqueue(key, to, { ...base, action }, this.config.stampWei)
        }
      }
    this.save()
  }
}

const maxBet = (item: HandItem): string =>
  item.action === 'accept' || item.action === 'challenge' ? item.maxBetWei : '0'

/** The same account operations as `BotAccount`, on a wallet opened through the ordinary chain
 * facade (`@frank/wallet/chain`): the bot holds no key and no client of its own. */
export function walletBotAccount(
  chain: {
    parseAddress(address: string): { raw: string } | undefined
    directMessages: {
      send(params: {
        wallet: unknown
        recipient: { raw: string }
        items: HandItem[]
        stampValue?: bigint
        onAttemptCreated?: (digest: string) => void | Promise<void>
      }): Promise<{ payloadDigest: string; stampValueWei: bigint }>
      fetchSince(params: { wallet: unknown; sinceMs: number }): Promise<
        {
          senderAddress: { raw: string }
          items: readonly { type: string }[]
          payloadDigest: string
          stampValueWei: bigint
          receivedTime: number
        }[]
      >
      reconcileAttempts(params: {
        wallet: unknown
        payloadDigests: string[]
      }): Promise<Record<string, AttemptStatus>>
      unattributedAttempts(params: {
        wallet: unknown
        knownDigests: string[]
      }): Promise<string[]>
    }
  },
  wallet: {
    identity: { address: { raw: string } }
    getBalance(): Promise<bigint>
  },
): BotAccount {
  return {
    address: wallet.identity.address.raw,
    spendableWei: () => wallet.getBalance(),
    send: ({ to, item, stampWei, onAttemptCreated }) => {
      const recipient = chain.parseAddress(to)
      if (!recipient) throw new Error(`not an address: ${to}`)
      return chain.directMessages.send({
        wallet,
        recipient,
        items: [item],
        stampValue: stampWei,
        onAttemptCreated,
      })
    },
    receive: async sinceMs =>
      (await chain.directMessages.fetchSince({ wallet, sinceMs })).map(m => ({
        from: m.senderAddress.raw,
        items: m.items,
        stampValueWei: m.stampValueWei,
        payloadDigest: m.payloadDigest,
        receivedTime: m.receivedTime,
      })),
    attemptStatus: digests =>
      chain.directMessages.reconcileAttempts({ wallet, payloadDigests: digests }),
    unattributedAttempts: knownDigests =>
      chain.directMessages.unattributedAttempts({ wallet, knownDigests }),
  }
}

/** Ticks the bot until `signal` aborts. A failing round is logged and tried again; the outbox
 * makes every round safe to repeat. */
export async function runBlackjackP2pBot(params: {
  bot: BlackjackP2pBot
  intervalMs: number
  signal: AbortSignal
  log?: (line: string) => void
  sleep?: (ms: number) => Promise<void>
}): Promise<void> {
  const sleep =
    params.sleep ?? (ms => new Promise<void>(resolve => setTimeout(resolve, ms)))
  while (!params.signal.aborted) {
    try {
      await params.bot.tick()
    } catch (error) {
      params.log?.(`round failed: ${(error as Error).message}`)
    }
    if (!params.signal.aborted) await sleep(params.intervalMs)
  }
}
