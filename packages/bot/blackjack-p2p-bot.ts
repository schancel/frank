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
  totalStakeWei,
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
  /** One message per key, ever. The key names what the message is for (the debt it pays, the
   * move it makes), not when it was decided: `refund|peer|game|ref`, `reveal|peer|game`... */
  key: string
  /** `peer|game` of the hand the message belongs to. */
  hand?: string
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
  /** The max bet the bot offers when it challenges or accepts as dealer. */
  maxBetWei: bigint
  /** The most the bot bets in one hand as player. Default: ten ordinary stamps. A dealer the bot
   * does not know can keep this, so it is small unless configured. */
  playerBetWei?: bigint
  /** The most the bot has at stake as player across all its open hands. Default: three bets. */
  maxPlayerRiskWei?: bigint
  /** How many hands with money at stake the bot holds at once, in either role. A silent
   * opponent keeps a hand open for good, so this bounds what silence can tie up. Default 20.
   * Independently of it, the bot holds at most one such hand per account. */
  maxOpenHands?: number
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
    // Both maps have no prototype, so an unknown key is simply absent.
    const log = games?.[gameId] ?? []
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

  /** Logs a refusal once per run, not once per round. */
  private readonly logged = new Set<string>()
  private logOnce(key: string, line: string): void {
    if (this.logged.has(key)) return
    this.logged.add(key)
    this.log(line)
  }

  private save(): void {
    this.store.save(this.state)
  }

  /** Why the new-account listing last failed, so the same reason is logged once. */
  private feedFailure: string | undefined
  /** Rounds run so far, and for rows whose send failed, the round they may be tried again in. */
  private round = 0
  private readonly retry = new Map<string, { failures: number; notBefore: number }>()

  /** One round: settle the outbox, read new messages, decide, send. Safe to call again after any
   * failure or restart. Returns how many messages were delivered this round. */
  async tick(): Promise<number> {
    this.round++
    let delivered = 0
    // A row whose outcome is in doubt is settled with the wallet before anything is sent.
    for (const row of this.state.outbox)
      if (!(await this.settle(row))) return delivered
    await this.receive()
    if (this.config.newAccounts) {
      // The listing only finds new opponents. When it cannot be read, hands in progress are
      // still played and paid this round; it is asked again next round.
      let addresses: string[] = []
      try {
        addresses = await this.config.newAccounts()
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error)
        if (reason !== this.feedFailure)
          this.config.log?.(`new accounts could not be read: ${reason}`)
        this.feedFailure = reason
      }
      if (addresses.length) this.feedFailure = undefined
      for (const address of addresses) await this.challengeOnce(address)
    }
    for (;;) {
      await this.decide()
      // Every hand's message is sent on its own: one that cannot be sent waits and is tried
      // again later, and does not hold up the others.
      const ready = this.state.outbox.filter(
        row =>
          row.phase === 'queued' &&
          (this.retry.get(row.key)?.notBefore ?? 0) <= this.round,
      )
      let progress = false
      for (const row of ready) {
        if (await this.deliver(row)) {
          delivered++
          progress = true
        } else if (!(await this.settle(row, true))) return delivered
      }
      if (!progress) return delivered
    }
  }

  /**
   * Asks the wallet what became of a row that is neither queued nor final. False only when the
   * wallet holds payment attempts the outbox cannot explain: then nothing may be sent.
   */
  private async settle(row: OutboxRow, failedNow = false): Promise<boolean> {
    if (row.phase === 'sending') {
      // The send stopped (or the process died) before an attempt was recorded here. The wallet
      // knows whether a payment set exists. Only one row is ever in this phase, because a failed
      // send is settled before the next one starts, so an attempt the wallet holds that no row
      // accounts for can only be this row's.
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
        // Nothing was paid: the row may be sent again. After a send that failed in this run it
        // waits a growing number of rounds; after a restart it is simply tried.
        row.phase = 'queued'
        if (failedNow) {
          const failures = (this.retry.get(row.key)?.failures ?? 0) + 1
          this.retry.set(row.key, {
            failures,
            notBefore: this.round + Math.min(2 ** (failures - 1), 64),
          })
        }
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
      }
      // Still live: the same bytes are sent again next round. Other rows are not held up.
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
      // Outcome unknown. The row stays `sending` or `attempt` until the wallet is asked.
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

  private enqueue(
    key: string,
    hand: string | undefined,
    to: string,
    item: HandItem,
    stampWei: bigint,
  ): void {
    if (this.state.outbox.some(row => row.key === key)) return
    this.state.outbox.push({
      key,
      ...(hand === undefined ? {} : { hand }),
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
              row.key === `deal|${peer}|${gameId}` &&
              row.phase !== 'dead',
          )
        if (dealt || dealing) total += state.wagerWei * DEALER_COVER_MULTIPLE
      }
    return total
  }

  /** The hands that have money at stake now, counting a bet or a deal the bot has queued. */
  private openHands(): { peers: Set<string>; count: number; playerRiskWei: bigint } {
    const open = { peers: new Set<string>(), count: 0, playerRiskWei: 0n }
    const queued = (key: string) =>
      this.state.outbox.find(row => row.key === key && row.phase !== 'dead')
    for (const [peer, games] of Object.entries(this.state.hands))
      for (const gameId of Object.keys(games)) {
        const state = this.hand(peer, gameId)
        if (!state) continue
        const hand = `${peer}|${gameId}`
        const role = roleOf(state, this.account.address)
        const staked = ['player_turn', 'awaiting_card', 'dealer_turn'].includes(
          state.phase,
        )
        if (role === 'player') {
          const bet = state.phase === 'open' ? queued(`bet|${hand}`) : undefined
          if (!staked && state.phase !== 'awaiting_deal' && !bet) continue
          open.playerRiskWei += bet ? BigInt(bet.stampWei) : totalStakeWei(state)
        } else if (role === 'dealer') {
          // A bet the bot has not decided to deal is not open yet: it may still be returned.
          if (
            !staked &&
            !(state.phase === 'awaiting_deal' && queued(`deal|${hand}`))
          )
            continue
        } else continue
        open.peers.add(peer)
        open.count++
      }
    return open
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
        this.enqueue(
          `challenge|${peer}`,
          undefined,
          address,
          built.item,
          this.config.stampWei,
        )
    }
    if (persist) this.save()
  }

  /** Queues the bot's next message for every hand that is waiting on it. */
  private async decide(): Promise<void> {
    const own = this.account.address
    let balance: bigint | undefined
    const spendableWei = async () =>
      (balance ??= await this.account.spendableWei())
    const open = this.openHands()
    const maxOpen = this.config.maxOpenHands ?? 20
    const playerBet = this.config.playerBetWei ?? 10n * this.config.stampWei
    const maxRisk = this.config.maxPlayerRiskWei ?? 3n * playerBet
    /** Why the bot may not put money into one more hand with `peer`, if it may not. */
    const closedTo = (peer: string): string | undefined =>
      open.peers.has(peer)
        ? 'another hand with this account is still open'
        : open.count >= maxOpen
        ? `${maxOpen} hands are already open`
        : undefined
    for (const [peer, games] of Object.entries(this.state.hands))
      for (const gameId of Object.keys(games)) {
        const events = this.events(peer, gameId)
        const state = foldHand(events).state
        if (!state) continue
        const role = roleOf(state, own)
        const to = role === 'dealer' ? state.player : state.dealer
        const hand = `${peer}|${gameId}`
        // One message per hand at a time: nothing new is decided for a hand while a message of
        // it is still on its way, so a decision is never made on a state that is about to change.
        if (
          this.state.outbox.some(
            row =>
              row.hand === hand &&
              (row.phase === 'queued' ||
                row.phase === 'sending' ||
                row.phase === 'attempt'),
          )
        )
          continue
        /** Queues the hand's next message under the key of what it is for. */
        const queue = (item: HandItem, stampWei: bigint) =>
          this.enqueue(messageKey(hand, item, state), hand, to, item, stampWei)
        // Finished hands with nothing owed need no balance and no message.
        if (
          (state.phase === 'resolved' || state.phase === 'refunded') &&
          state.rejected.every(r => r.refundedWei !== undefined)
        )
          continue
        const spendable = await spendableWei()
        if (role === 'dealer') {
          const seed = this.state.seeds[`${peer}|${gameId}`] ?? ''
          // Money the hand did not accept goes back first, whatever state the hand is in.
          const owed = dealerStep(state, seed)
          if (owed?.item.action === 'refund') {
            queue(owed.item, owed.payWei ?? this.config.stampWei)
            continue
          }
          if (state.phase === 'challenged') {
            const closed = closedTo(peer)
            if (closed) {
              this.logOnce(`accept|${hand}`, `not accepting ${gameId}: ${closed}`)
              continue
            }
            const free = spendable - this.committedWei()
            // The lowest of the challenge's max bet, the bot's own and what it can cover.
            const wanted = [
              state.maxBetWei,
              this.config.maxBetWei,
              maxDealerBetWei(free, this.reserveWei),
            ].reduce((a, b) => (a < b ? a : b))
            const built = buildAccept({
              state,
              wantedMaxBetWei: wanted,
              spendableWei: free,
              reserveWei: this.reserveWei,
              seed:
                this.state.seeds[`${peer}|${gameId}`] ??
                this.newSeed(peer, gameId),
            })
            if ('item' in built && BigInt(maxBet(built.item)) >= this.config.stampWei)
              queue(built.item, this.config.stampWei)
            else this.log(`cannot cover the challenge ${gameId} from ${peer}`)
            continue
          }
          let step = owed
          if (step?.item.action === 'deal') {
            // A bet goes back instead of being dealt when the bot can no longer cover it (other
            // hands took the money), when this account already has an open hand, or when the
            // bot holds as many open hands as it may.
            const closed =
              closedTo(peer) ??
              (spendable - this.reserveWei <
              this.committedWei() + state.wagerWei * DEALER_COVER_MULTIPLE
                ? 'the bot cannot cover it'
                : undefined)
            if (closed) {
              this.log(`returning the bet of ${gameId}: ${closed}`)
              step = refundBetStep(state)
            } else {
              open.peers.add(peer)
              open.count++
            }
          }
          if (step)
            queue(step.item, step.payWei ?? this.config.stampWei)
          continue
        }
        if (role !== 'player') continue
        const moves = playerMoves(state)
        const base = { type: 'blackjack-hand' as const, gameId }
        if (moves.includes('bet')) {
          // The challenger picked the roles, so the bot plays. What it risks is bounded: one
          // open hand per account, a small bet, and a limit on its total at stake as player.
          const closed = closedTo(peer)
          const own = maxPlayerBetWei(spendable, this.reserveWei)
          const wager = [state.maxBetWei, playerBet, own].reduce((a, b) =>
            a < b ? a : b,
          )
          if (closed) this.logOnce(`bet|${hand}`, `not betting in ${gameId}: ${closed}`)
          else if (open.playerRiskWei + wager > maxRisk)
            this.logOnce(
              `bet|${hand}`,
              `not betting in ${gameId}: at most ${maxRisk} wei at stake as player`,
            )
          else if (wager >= this.config.stampWei) {
            queue({ ...base, action: 'bet' }, wager)
            open.peers.add(peer)
            open.count++
            open.playerRiskWei += wager
          } else this.logOnce(`bet|${hand}`, `cannot afford a bet in ${gameId}`)
        } else if (moves.length) {
          // The player's choices are few: draw below 17, otherwise stand.
          const action = handValue(state.playerCards).total < 17 ? 'hit' : 'stand'
          queue({ ...base, action }, this.config.stampWei)
        }
      }
    this.save()
  }
}

/** The outbox key of a hand's message: what it pays or which move it is. The same debt or move
 * always gives the same key, so it is queued, and paid, once. */
function messageKey(hand: string, item: HandItem, state: HandState): string {
  switch (item.action) {
    case 'refund':
      return `refund|${hand}|${item.ref}`
    case 'card':
      return `card|${hand}|${item.playerCards.length}`
    case 'hit':
      return `hit|${hand}|${state.playerCards.length}`
    default:
      return `${item.action}|${hand}`
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
