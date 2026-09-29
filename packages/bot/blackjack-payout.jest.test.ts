/**
 * Ticket #215: a resolved blackjack hand must never leave its winner unpaid, and never pay twice.
 * Every failure point between "hand resolved" and "receipt shows the payout" is injected against a
 * fake chain (mempool + mined set + nonces) so "paid exactly once" is checked against what actually
 * mined, not against mock call counts alone.
 */
import { createHash } from 'crypto'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import level from 'level'
import { getAddress } from 'ethers'

import { deriveDeck, handValue, sha256Hex } from '@frank/wallet/message-item-plugins/blackjack/deck'
import {
  dealInitialCards,
  HydratedBlackjackMove,
  resolveOutcome,
} from '@frank/wallet/message-item-plugins/blackjack/game'
import { sendDirectMessageItems, sendDirectMessageText } from './qwen-bot-common'
import { BlackjackBotStateStore } from './blackjack-bot-state'
import {
  attemptPayout,
  attemptRefund,
  handleMove,
  PayoutBackoff,
  runBlackjackLoop,
  settlePayouts,
} from './blackjack-bot.livecheck'
import { DOUBLE_PAYMENT_REMINDER, listPayouts, requeueNonceConsumed, requeuePayout, runAdminCli } from './blackjack-payout-admin.livecheck'

jest.mock('./qwen-bot-common', () => ({
  loadOrCreateIdentity: jest.fn(),
  registerAndLog: jest.fn(),
  requiredEnv: jest.fn(),
  sendDirectMessageItems: jest.fn(async () => undefined),
  sendDirectMessageText: jest.fn(async () => undefined),
  setUpFundedStampClient: jest.fn(),
}))

const DEALER = `0x${'bb'.repeat(20)}`
const PLAYER = `0x${'aa'.repeat(20)}`
const WAGER_HASH = `0x${'AB'.repeat(32)}`

/** A payer account on a fake chain. `pending` nonce = mined count + mempool size, like
 * eth_getTransactionCount("pending"). */
class FakeChain {
  address = `0x${'dd'.repeat(20)}`
  mined = new Map<string, { nonce: number; to: string; value: bigint; reverted?: boolean }>()
  mempool = new Map<string, { nonce: number; to: string; value: bigint; raw: string }>()
  events: string[] = []
  builds = 0
  failBuild: Error | undefined
  failSubmit: { error: Error; reachesMempool: boolean } | undefined
  failStatus: Error | undefined
  revertNext = false

  private get confirmedCount() {
    return this.mined.size
  }

  async buildAndSignTransfer(to: string, value: bigint) {
    this.events.push('build')
    this.builds += 1
    if (this.failBuild) throw this.failBuild
    const nonce = this.confirmedCount + this.mempool.size
    const rawTx = `0xraw:${nonce}:${to}:${value}`
    const txHash = `0x${createHash('sha256').update(rawTx).digest('hex')}`
    return { rawTx, txHash, nonce, to, value }
  }

  async submit(signed: { rawTx: string; txHash: string }) {
    return this.submitRaw(signed.rawTx, signed.txHash)
  }

  async submitRaw(rawTx: string, txHash: string): Promise<string> {
    this.events.push('submitRaw')
    const [, nonceText, to, value] = rawTx.split(':')
    const tx = { nonce: Number(nonceText), to, value: BigInt(value), raw: rawTx }
    const inject = this.failSubmit
    if (inject) {
      this.failSubmit = undefined
      if (inject.reachesMempool) this.mempool.set(txHash, tx)
      throw inject.error
    }
    if (this.mined.has(txHash)) throw new Error('nonce too low')
    if (this.mempool.has(txHash)) throw new Error('already known')
    const clash = [...this.mined.values(), ...this.mempool.values()].some((t) => t.nonce === tx.nonce)
    if (clash) throw new Error('replacement transaction underpriced / nonce too low')
    this.mempool.set(txHash, tx)
    return txHash
  }

  async getStatus(txHash: string) {
    if (this.failStatus) throw this.failStatus
    const m = this.mined.get(txHash)
    if (!m) return 'pending' as const
    return m.reverted ? ('failed' as const) : ('confirmed' as const)
  }

  mine() {
    for (const [hash, tx] of [...this.mempool].sort(([, a], [, b]) => a.nonce - b.nonce)) {
      this.mined.set(hash, { ...tx, reverted: this.revertNext || undefined })
      this.mempool.delete(hash)
    }
    this.revertNext = false
  }

  /** Total value that actually moved to `to` (successful mined transfers only). */
  paidTo(to: string): bigint {
    let total = 0n
    for (const t of this.mined.values()) if (t.to === to && !t.reverted) total += t.value
    return total
  }
}

function findWinningSeed(): string {
  for (let i = 0; i < 2000; i++) {
    const seed = `payout-win-${i}`
    const deck = deriveDeck(seed, WAGER_HASH.toLowerCase(), 0)
    const initial = dealInitialCards(deck)
    if (handValue(initial.playerCards).blackjack) continue
    let dealer = initial.dealerCards
    let n = 4
    while (handValue(dealer).total < 17) dealer = [...dealer, deck[n++]]
    if (resolveOutcome(handValue(initial.playerCards), handValue(dealer)) === 'player_win') {
      return seed
    }
  }
  throw new Error('no winning seed')
}

describe('blackjack payout is durable and exactly-once (#215)', () => {
  let directory: string
  let state: BlackjackBotStateStore
  let chain: FakeChain
  let getBalance: jest.Mock
  const seed = findWinningSeed()
  const PLAYER_CANON = getAddress(PLAYER)

  async function reopen() {
    await state.Close()
    state = new BlackjackBotStateStore(directory)
    await state.Open()
  }

  beforeEach(async () => {
    jest.clearAllMocks()
    ;(sendDirectMessageItems as jest.Mock).mockImplementation(async () => {
      chain.events.push('dm')
    })
    directory = mkdtempSync(join(tmpdir(), 'blackjack-payout-'))
    state = new BlackjackBotStateStore(directory)
    await state.Open()
    chain = new FakeChain()
    getBalance = jest.fn(async () => 10n ** 30n)
    await state.setPendingCommitment(seed, sha256Hex(seed))
  })

  afterEach(async () => {
    await state.Close()
    rmSync(directory, { recursive: true, force: true })
  })

  function hydrated(action: HydratedBlackjackMove['action'], o: Partial<HydratedBlackjackMove> = {}) {
    return { gameId: 'game-a', action, senderAddress: PLAYER, ...o } as HydratedBlackjackMove
  }
  async function move(action: HydratedBlackjackMove['action'], h: HydratedBlackjackMove) {
    await handleMove({
      action,
      hydrated: h,
      senderAddress: PLAYER,
      senderPubKey: Buffer.alloc(33, 1),
      minWagerWei: 10n,
      maxWagerWei: 1000n,
      state,
      identity: { displayAddress: DEALER } as never,
      networkTag: 'TEST',
      stampValueWei: 1n,
      stampClient: {} as never,
      pool: {} as never,
      mainAccountSigner: chain as never,
      provider: { getBalance } as never,
    })
  }
  const bet = (o: Partial<HydratedBlackjackMove> = {}) =>
    move(
      'bet',
      hydrated('bet', {
        wagerTxHash: WAGER_HASH,
        verifiedWager: { fromAddress: PLAYER, toAddress: DEALER, valueWei: 100n },
        ...o,
      }),
    )
  const stand = () => move('stand', hydrated('stand'))
  const settle = (backoff?: PayoutBackoff, now?: number) =>
    settlePayouts({ state, mainAccountSigner: chain as never, backoff, now })
  const paid = () => chain.paidTo(PLAYER_CANON)

  async function startWinningGame() {
    await bet()
    chain.events.length = 0
    jest.mocked(sendDirectMessageItems).mockClear()
  }

  it('normal resolution: reveal message, then the payout, in main\'s order; confirmed only by a receipt', async () => {
    await startWinningGame()
    await stand()

    expect(chain.events).toEqual(['dm', 'build', 'submitRaw'])
    expect(sendDirectMessageItems).toHaveBeenCalledTimes(1)
    expect(jest.mocked(sendDirectMessageItems).mock.calls[0][0]).toMatchObject({
      toAddress: PLAYER_CANON,
      items: [expect.objectContaining({ action: 'reveal', outcome: 'player_win', serverSeed: seed })],
    })
    // Accepted into the mempool is NOT paid: still owed, still counted against the bankroll.
    expect(state.getGame('game-a')).toMatchObject({ revealed: true, payout: { status: 'submitted', amountWei: 200n } })
    expect(state.openExposureWei()).toBe(200n)
    expect(paid()).toBe(0n)

    chain.mine()
    await settle()
    expect(state.getPayout('game-a')?.status).toBe('confirmed')
    expect(state.openExposureWei()).toBe(0n)
    expect(paid()).toBe(200n)
    expect(chain.builds).toBe(1)
    await settle()
    expect(chain.builds).toBe(1)
    expect(paid()).toBe(200n)
  })

  it('a loss records no payout and sends only the reveal', async () => {
    const lossSeed = (() => {
      for (let i = 0; i < 2000; i++) {
        const s = `payout-loss-${i}`
        const deck = deriveDeck(s, WAGER_HASH.toLowerCase(), 0)
        const init = dealInitialCards(deck)
        if (handValue(init.playerCards).blackjack) continue
        let dealer = init.dealerCards
        let n = 4
        while (handValue(dealer).total < 17) dealer = [...dealer, deck[n++]]
        if (resolveOutcome(handValue(init.playerCards), handValue(dealer)) === 'dealer_win') return s
      }
      throw new Error('no losing seed')
    })()
    await state.setPendingCommitment(lossSeed, sha256Hex(lossSeed))
    await startWinningGame()
    await stand()
    expect(chain.events).toEqual(['dm'])
    expect(state.getGame('game-a')).toMatchObject({ revealed: true })
    expect(state.getPayout('game-a')).toBeUndefined()
    expect(chain.builds).toBe(0)
  })

  it('resolving and recording the payout is one durable write', async () => {
    await startWinningGame()
    const r = await state.resolveGameWithPayout({ gameId: 'game-a', dealtCount: 4, payoutWei: 200n })
    expect(r.ok).toBe(true)
    await reopen() // nothing else was written or flushed by the caller
    expect(state.getGame('game-a')).toMatchObject({ revealed: true, payout: { status: 'owed', amountWei: 200n } })
    expect(await state.resolveGameWithPayout({ gameId: 'game-a', dealtCount: 4, payoutWei: 200n })).toEqual({
      ok: false,
      reason: 'already_revealed',
    })
  })

  it('reveal DM throws after the persist: the winner is still paid once', async () => {
    await startWinningGame()
    jest.mocked(sendDirectMessageItems).mockRejectedValueOnce(new Error('stamp/relay failure'))
    await stand()
    expect(state.getGame('game-a')?.revealed).toBe(true)
    chain.mine()
    await settle()
    expect(paid()).toBe(200n)
    expect(state.getPayout('game-a')?.status).toBe('confirmed')
    await settle()
    expect(paid()).toBe(200n)
    expect(chain.builds).toBe(1)
  })

  it('payout cannot be built (insufficient funds): stays owed, counts against the bankroll, retried with backoff, paid once', async () => {
    await startWinningGame()
    chain.failBuild = new Error('insufficient funds')
    await stand() // must not throw
    expect(state.getPayout('game-a')).toMatchObject({ status: 'owed', amountWei: 200n })
    expect(state.openExposureWei()).toBe(200n)

    const backoff: PayoutBackoff = new Map()
    await settle(backoff, 1000)
    const buildsAfterFirstRetry = chain.builds
    await settle(backoff, 1001) // inside the backoff window: no attempt
    expect(chain.builds).toBe(buildsAfterFirstRetry)

    chain.failBuild = undefined
    await settle(backoff, 1000 + 120000)
    chain.mine()
    await settle(backoff, 1000 + 240000)
    expect(paid()).toBe(200n)
    expect(state.getPayout('game-a')?.status).toBe('confirmed')
    await settle(backoff, 1000 + 480000)
    expect(paid()).toBe(200n)
  })

  it('submit throws before anything reaches the network: the SAME signed bytes are re-broadcast, never re-signed', async () => {
    await startWinningGame()
    chain.failSubmit = { error: new Error('rpc down'), reachesMempool: false }
    await stand()
    const journaled = state.getPayout('game-a')!
    expect(journaled.status).toBe('submitting')
    expect(journaled.rawTx).toContain(':0:')
    expect(chain.mempool.size).toBe(0)

    await settle()
    expect(chain.builds).toBe(1)
    expect(chain.mempool.get(journaled.txHash!)?.raw).toBe(journaled.rawTx)
    chain.mine()
    await settle()
    expect(paid()).toBe(200n)
    expect(chain.mined.size).toBe(1)
  })

  it('crash after the payout is recorded but before anything is signed: restart pays once', async () => {
    await startWinningGame()
    jest.mocked(sendDirectMessageItems).mockRejectedValueOnce(new Error('process died'))
    chain.failBuild = new Error('process died')
    await stand()
    await reopen()
    expect(state.getPayout('game-a')?.status).toBe('owed')
    chain.failBuild = undefined
    await settle()
    chain.mine()
    await settle()
    expect(paid()).toBe(200n)
    expect(state.getPayout('game-a')?.status).toBe('confirmed')
  })

  it('crash after the signed tx is journaled but before broadcast: restart re-broadcasts the journaled bytes', async () => {
    await startWinningGame()
    chain.failSubmit = { error: new Error('process died'), reachesMempool: false }
    await stand()
    const journaled = state.getPayout('game-a')!
    await reopen()
    expect(state.getPayout('game-a')).toMatchObject({ status: 'submitting', rawTx: journaled.rawTx })
    await settle()
    chain.mine()
    await settle()
    expect(chain.builds).toBe(1)
    expect(paid()).toBe(200n)
    expect(chain.mined.size).toBe(1)
  })

  it('crash after broadcast, before confirmation: restart never signs again and pays once', async () => {
    await startWinningGame()
    await stand()
    expect(chain.mempool.size).toBe(1)
    await reopen()
    await settle() // receipt pending; same bytes re-offered ("already known"), no new tx
    expect(chain.mempool.size).toBe(1)
    expect(chain.builds).toBe(1)
    expect(state.getPayout('game-a')?.status).not.toBe('confirmed')
    chain.mine()
    await reopen()
    await settle()
    expect(state.getPayout('game-a')?.status).toBe('confirmed')
    expect(paid()).toBe(200n)
    expect(chain.mined.size).toBe(1)
  })

  it('lost RPC response (tx reached the mempool but the call threw): no second transfer', async () => {
    await startWinningGame()
    chain.failSubmit = { error: new Error('socket hang up'), reachesMempool: true }
    await stand()
    expect(state.getPayout('game-a')?.status).toBe('submitting')
    expect(chain.mempool.size).toBe(1)
    await settle()
    expect(chain.builds).toBe(1)
    chain.mine()
    await settle()
    expect(paid()).toBe(200n)
    expect(chain.mined.size).toBe(1)
    expect(state.getPayout('game-a')?.status).toBe('confirmed')
  })

  it('an unreadable receipt never clears or re-signs; a reverted receipt is left for an operator', async () => {
    await startWinningGame()
    await stand()
    chain.mine()
    chain.failStatus = new Error('rpc error')
    const errors = jest.spyOn(console, 'error').mockImplementation(() => undefined)
    await expect(settle()).resolves.toBeUndefined()
    expect(state.getPayout('game-a')?.status).toBe('submitted')
    chain.failStatus = undefined
    // Reverted on-chain: value did not move; do not auto-re-sign, alert.
    chain.mined.get([...chain.mined.keys()][0])!.reverted = true
    await settle()
    expect(state.getPayout('game-a')?.status).toBe('failed')
    expect(errors).toHaveBeenCalledWith(expect.stringContaining('OPERATOR ACTION'))
    expect(chain.builds).toBe(1)
    expect(paid()).toBe(0n)
    errors.mockRestore()
  })

  it('serializes payer transactions: nothing else signs while a signed payout is unconfirmed', async () => {
    await startWinningGame()
    chain.failSubmit = { error: new Error('lost'), reachesMempool: false }
    await stand()
    expect(state.hasSignedUnconfirmedPayout()).toBe(true)
    const buildsBefore = chain.builds

    // A queued refund and a second owed payout must not take the payout's nonce.
    await state.claimRefund({ txHash: `0x${'12'.repeat(32)}`, playerAddress: PLAYER, amountWei: 5n })
    expect(await attemptRefund({ state, txHash: `0x${'12'.repeat(32)}`, mainAccountSigner: chain as never })).toBe('pending')
    expect(chain.builds).toBe(buildsBefore)

    await settle()
    chain.mine()
    await settle()
    expect(paid()).toBe(200n)
    expect(await attemptRefund({ state, txHash: `0x${'12'.repeat(32)}`, mainAccountSigner: chain as never })).toBe('sent')
    expect(chain.mined.size).toBe(1) // payout only; refund is in the mempool with the NEXT nonce
    expect([...chain.mempool.values()][0].nonce).toBe(1)
  })

  it('a second owed payout waits for the first to confirm and then takes the next nonce', async () => {
    await startWinningGame()
    await stand()
    // Second resolved winner whose payout is owed.
    const second = `0x${'CD'.repeat(32)}`
    // Any seed that deals no natural for this wager hash, so the game stays open until resolved.
    let s2 = ''
    for (let i = 0; !s2; i++) {
      const c = `b-seed-${i}`
      if (!handValue(dealInitialCards(deriveDeck(c, second.toLowerCase(), 0)).playerCards).blackjack) s2 = c
    }
    await state.setPendingCommitment(s2, sha256Hex(s2))
    await move(
      'bet',
      hydrated('bet', {
        gameId: 'game-b',
        wagerTxHash: second,
        verifiedWager: { fromAddress: PLAYER, toAddress: DEALER, valueWei: 100n },
      }),
    )
    const rec = state.getGame('game-b')!
    await state.resolveGameWithPayout({ gameId: 'game-b', dealtCount: rec.dealtCount, payoutWei: 300n })
    expect(await attemptPayout({ state, gameId: 'game-b', mainAccountSigner: chain as never })).toBe('blocked')
    expect(chain.builds).toBe(1)
    chain.mine()
    await settle() // confirms game-a, then signs game-b at the next nonce
    expect(state.getPayout('game-a')?.status).toBe('confirmed')
    expect(state.getPayout('game-b')?.status).toBe('submitted')
    chain.mine()
    await settle()
    expect([...chain.mined.values()].map((t) => t.nonce).sort()).toEqual([0, 1])
    expect(paid()).toBe(500n)
  })

  it('the bankroll check counts an owed payout', async () => {
    await startWinningGame()
    chain.failBuild = new Error('insufficient funds')
    await stand()
    // 200 owed + a 250 worst case for a new 100 bet = 450 > 449. (Without the owed term, 250 fits.)
    getBalance.mockResolvedValue(449n)
    await move('bet', hydrated('bet', {
      gameId: 'game-c',
      wagerTxHash: `0x${'EF'.repeat(32)}`,
      verifiedWager: { fromAddress: PLAYER, toAddress: DEALER, valueWei: 100n },
    }))
    expect(state.getGame('game-c')).toBeUndefined()
    // The refused 100 bet is itself queued for refund (pending): 200 + 100 + 250.
    getBalance.mockResolvedValue(550n)
    await move('bet', hydrated('bet', {
      gameId: 'game-c',
      wagerTxHash: `0x${'FE'.repeat(32)}`,
      verifiedWager: { fromAddress: PLAYER, toAddress: DEALER, valueWei: 100n },
    }))
    expect(state.getGame('game-c')).toBeDefined()
  })

  describe('backward compatibility', () => {
    async function writeRawGame(id: string, row: Record<string, unknown>, claimHash: string) {
      await state.Close()
      const db = level(join(directory, 'blackjack-bot-state'), { keyEncoding: 'binary', valueEncoding: 'binary' } as never) as any
      await db.put(Buffer.from(`game:${id}`), Buffer.from(JSON.stringify(row)))
      await db.put(Buffer.from(`wager-claim:${claimHash}`), Buffer.from(JSON.stringify({ gameId: id })))
      await db.close()
      state = new BlackjackBotStateStore(directory)
      await state.Open()
    }
    const base = () => ({
      authority: 'verified-wager-sender',
      serverSeed: seed,
      serverSeedHash: sha256Hex(seed),
      wagerTxHash: WAGER_HASH.toLowerCase(),
      wagerWei: '100',
      playerAddress: PLAYER_CANON,
      dealtCount: 4,
    })

    it('rows without the payout field load unchanged, then resolve and pay normally', async () => {
      await writeRawGame(
        'old-game',
        { ...base(), revealed: false, doubled: false, doubleWagerWei: null },
        WAGER_HASH.toLowerCase(),
      )
      expect(state.getGame('old-game')).toMatchObject({ revealed: false, doubled: false })
      expect(state.getGame('old-game')!.payout).toBeUndefined()
      await move('stand', hydrated('stand', { gameId: 'old-game' }))
      chain.mine()
      await settle()
      expect(paid()).toBe(200n)
      await reopen()
      expect(state.getPayout('old-game')?.status).toBe('confirmed')
    })

    it('pre-double rows and already-revealed old rows load as resolved with no payout invented', async () => {
      await writeRawGame('older', { ...base(), revealed: true }, WAGER_HASH.toLowerCase())
      expect(state.getGame('older')).toMatchObject({ revealed: true, doubled: false })
      expect(state.getPayout('older')).toBeUndefined()
      expect(state.getOpenPayouts()).toEqual([])
      await settle()
      expect(chain.builds).toBe(0)
      expect(state.openExposureWei()).toBe(0n)
    })

    it('an invalid persisted payout is quarantined, not trusted', async () => {
      await writeRawGame(
        'bad',
        { ...base(), revealed: true, doubled: false, doubleWagerWei: null, payout: { status: 'owed', amountWei: '-5', rawTx: null, txHash: null } },
        WAGER_HASH.toLowerCase(),
      )
      expect(state.getGame('bad')?.payout).toBeUndefined()
      expect(state.getGame('bad')?.authority).not.toBe('verified-wager-sender')
    })
  })

  // ---- round 2: rollback shape, loop hold/idle/cursor, backoff, alerts, operator tool ---------
  describe('rollback shape (rows without a payout are byte-shaped like main)', () => {
    const MAIN_KEYS = [
      'authority', 'dealtCount', 'doubleWagerWei', 'doubled', 'playerAddress', 'revealed',
      'serverSeed', 'serverSeedHash', 'wagerTxHash', 'wagerWei',
    ]
    async function rawRow(id: string) {
      await state.Close()
      const db = level(join(directory, 'blackjack-bot-state'), { keyEncoding: 'binary', valueEncoding: 'binary' } as never) as any
      const raw = JSON.parse((await db.get(Buffer.from(`game:${id}`))).toString())
      await db.close()
      state = new BlackjackBotStateStore(directory)
      await state.Open()
      return raw
    }

    it('in-progress, hit and resolved-loss rows carry exactly main\'s keys (no payout key)', async () => {
      await startWinningGame()
      expect(Object.keys(await rawRow('game-a')).sort()).toEqual(MAIN_KEYS)
      await state.resolveGameWithPayout({ gameId: 'game-a', dealtCount: 4, payoutWei: 0n }) // a loss
      expect(Object.keys(await rawRow('game-a')).sort()).toEqual(MAIN_KEYS)
    })

    it('a row that owes a payout still round-trips through every state', async () => {
      await startWinningGame()
      chain.failSubmit = { error: new Error('x'), reachesMempool: false }
      await stand()
      const before = state.getPayout('game-a')!
      expect(Object.keys(await rawRow('game-a'))).toContain('payout')
      await reopen()
      expect(state.getPayout('game-a')).toEqual(before)
      expect(before).toMatchObject({ status: 'submitting', nonce: 0 })
    })
  })

  describe('poll loop', () => {
    let t: number
    let onSleep: (() => void) | undefined
    const now = () => t
    const sleep = async (ms: number) => {
      t += ms
      if (t > 50_000_000) throw new Error('runaway loop') // a broken loop fails, never hangs
      onSleep?.()
    }
    const msg = (ts: number, n: number) => ({ timestamp: ts, message: { payloadHash: Buffer.from([n]) } }) as never
    let relay: Array<{ timestamp: number; message: { payloadHash: Buffer } }>
    let fetchCalls: number[]
    let handled: number[]

    beforeEach(() => {
      t = 1000
      onSleep = undefined
      relay = []
      fetchCalls = []
      handled = []
    })
    const loop = (over: Record<string, unknown> = {}) =>
      runBlackjackLoop({
        state,
        mainAccountSigner: chain as never,
        pollIntervalMs: 100,
        maxHands: 1000,
        idleTimeoutMs: 1000,
        drainTimeoutMs: 5000,
        now,
        sleep,
        fetchMessages: async (since: number) => {
          fetchCalls.push(since)
          return relay.filter((m) => m.timestamp >= since) as never
        },
        processMessage: async (m: never) => {
          handled.push((m as { timestamp: number }).timestamp)
          return undefined
        },
        ...over,
      } as never)
    const stopAfter = (n: number) => {
      let i = 0
      onSleep = () => {
        if (++i >= n) throw new Error('stop')
      }
    }

    it('a genuinely idle bot still exits cleanly after the idle timeout', async () => {
      const r = await loop()
      expect(r).toMatchObject({ handsResolved: 0, exitCode: 0, unsettled: [] })
      expect(t).toBeGreaterThan(1000 + 1000)
    })

    it('the payout hold is not idleness: no idle exit while a payout is open, exit 0 once it confirms', async () => {
      await startWinningGame()
      await stand() // submitted, never mined yet
      t = 1000
      let mined = false
      onSleep = () => {
        if (t >= 1000 + 5000 && !mined) {
          mined = true
          chain.mine()
        }
      }
      relay = [{ timestamp: 1500, message: { payloadHash: Buffer.from([9]) } }]
      const r = await loop({ drainTimeoutMs: 300 })
      expect(mined).toBe(true) // it waited well past idleTimeoutMs (1000) for the confirmation
      expect(handled).toEqual([1500]) // and then went on to serve the message held meanwhile
      expect(r).toMatchObject({ exitCode: 0, unsettled: [] })
      expect(paid()).toBe(200n)
    })

    it('messages held during a payout stall are fetched after a restart (durable cursor)', async () => {
      await startWinningGame()
      await stand() // in flight, not mined
      t = 1000
      relay = [{ timestamp: 1500, message: { payloadHash: Buffer.from([1]) } }]
      stopAfter(4)
      await expect(loop()).rejects.toThrow('stop')
      expect(fetchCalls).toEqual([]) // held: nothing was fetched or consumed
      expect(handled).toEqual([])
      expect(state.getSince()).toBe(1000)

      chain.mine()
      await reopen()
      onSleep = undefined
      t = 900000 // the restart happens much later
      fetchCalls = []
      await loop()
      expect(fetchCalls[0]).toBe(1000) // NOT Date.now()
      expect(handled).toEqual([1500])
      expect(state.getSince()).toBe(1501)
    })

    it('a fresh database starts at "now" and persists it; the cursor never passes unhandled messages', async () => {
      expect(state.getSince()).toBeUndefined()
      relay = [
        { timestamp: 2000, message: { payloadHash: Buffer.from([1]) } },
        { timestamp: 2001, message: { payloadHash: Buffer.from([2]) } },
      ]
      let first = true
      const r = await loop({
        maxHands: 1,
        processMessage: async (m: { timestamp: number }) => {
          handled.push(m.timestamp)
          if (!first) return undefined
          first = false
          return { action: 'reveal', gameId: 'x' }
        },
      })
      expect(r.handsResolved).toBe(1)
      expect(handled).toEqual([2000]) // stopped at the hand limit, 2001 left unread
      expect(state.getSince()).toBe(1000) // not advanced past the unread message
      await reopen()
      handled = []
      await loop()
      expect(handled).toEqual([2001]) // 2000 is deduped by hasProcessed
    })

    it('the processed marker is durable BEFORE a message is handled (at-most-once)', async () => {
      relay = [{ timestamp: 2000, message: { payloadHash: Buffer.from([5]) } }]
      const order: string[] = []
      const realAdd = state.addProcessed.bind(state)
      const realFlush = state.flush.bind(state)
      jest.spyOn(state, 'addProcessed').mockImplementation((h: string) => { order.push('mark'); realAdd(h) })
      jest.spyOn(state, 'flush').mockImplementation(async () => { order.push('flush'); await realFlush() })
      await loop({
        processMessage: async () => { order.push('handle'); return undefined },
      })
      const firstHandle = order.indexOf('handle')
      expect(order.slice(0, firstHandle).lastIndexOf('flush')).toBeGreaterThan(order.indexOf('mark'))
    })

    it('a message whose handling throws is skipped after restart (not re-run, not crashing the loop) and logged', async () => {
      relay = [{ timestamp: 2000, message: { payloadHash: Buffer.from([6]) } }]
      const errors = jest.spyOn(console, 'error').mockImplementation(() => undefined)
      const r = await loop({
        processMessage: async (m: { timestamp: number }) => {
          handled.push(m.timestamp)
          throw new Error('hydrate RPC exploded')
        },
      })
      expect(r.exitCode).toBe(0)
      expect(handled).toEqual([2000])
      expect(errors).toHaveBeenCalledWith(expect.stringContaining('MESSAGE FAILED'))
      expect(String(errors.mock.calls.find((c) => String(c[0]).includes('MESSAGE FAILED'))![0])).toContain(Buffer.from([6]).toString('hex'))
      await reopen() // restart
      handled = []
      await loop()
      expect(handled).toEqual([]) // at-most-once: skipped, exactly as on main
      errors.mockRestore()
    })

    it('a corrupt persisted cursor is ignored and logged, and the loop starts at now and repairs it', async () => {
      await state.Close()
      const db = level(join(directory, 'blackjack-bot-state'), { keyEncoding: 'binary', valueEncoding: 'binary' } as never) as any
      await db.put(Buffer.from('__poll_since_ms__'), Buffer.from('"not-a-number"'))
      await db.close()
      const errors = jest.spyOn(console, 'error').mockImplementation(() => undefined)
      state = new BlackjackBotStateStore(directory)
      await state.Open()
      expect(state.getSince()).toBeUndefined()
      expect(errors).toHaveBeenCalledWith(expect.stringContaining('CURSOR CORRUPT'), expect.anything())
      await loop()
      expect(state.getSince()).toBe(1000)
      await reopen()
      expect(state.getSince()).toBe(1000)
      errors.mockRestore()
    })

    it('a normal single hand through the loop: reveal then payout, exit 0 after the drain confirms it', async () => {
      relay = [{ timestamp: 2000, message: { payloadHash: Buffer.from([7]) } }]
      onSleep = () => chain.mine()
      let n = 0
      const r = await loop({
        maxHands: 1,
        processMessage: async () => {
          if (n++ > 0) return undefined
          await bet()
          chain.events.length = 0
          await stand()
          return { action: 'stand', gameId: 'game-a' }
        },
      })
      expect(chain.events).toEqual(['dm', 'build', 'submitRaw'])
      expect(r).toMatchObject({ handsResolved: 1, exitCode: 0, unsettled: [] })
      expect(paid()).toBe(200n)
    })

    it('exits non-zero, with a structured warning, when a payout is still unsettled (failed, needs an operator)', async () => {
      await startWinningGame()
      await stand()
      chain.revertNext = true
      chain.mine()
      const errors = jest.spyOn(console, 'error').mockImplementation(() => undefined)
      await settle()
      const r = await loop({ drainTimeoutMs: 300 })
      expect(r.exitCode).toBe(1)
      expect(r.unsettled).toEqual(['game-a:failed'])
      expect(errors).toHaveBeenCalledWith(expect.stringContaining('EXITING WITH UNSETTLED PAYOUTS'))
      errors.mockRestore()
    })
  })

  describe('settle: slow is not failed, stuck is loud', () => {
    it('a pending receipt or a payout waiting behind another never backs off, and the receipt is read every poll', async () => {
      await startWinningGame()
      await stand() // A in flight
      const getStatus = jest.spyOn(chain, 'getStatus')
      const second = `0x${'CD'.repeat(32)}`
      let s2 = ''
      for (let i = 0; !s2; i++) {
        const c = `b-seed-${i}`
        if (!handValue(dealInitialCards(deriveDeck(c, second.toLowerCase(), 0)).playerCards).blackjack) s2 = c
      }
      await state.setPendingCommitment(s2, sha256Hex(s2))
      await move('bet', hydrated('bet', {
        gameId: 'game-b', wagerTxHash: second,
        verifiedWager: { fromAddress: PLAYER, toAddress: DEALER, valueWei: 100n },
      }))
      await state.resolveGameWithPayout({ gameId: 'game-b', dealtCount: 4, payoutWei: 300n })
      const backoff: PayoutBackoff = new Map()
      getStatus.mockClear()
      for (let i = 0; i < 10; i++) await settle(backoff, 1000 + i)
      expect(getStatus).toHaveBeenCalledTimes(10)
      for (const track of backoff.values()) expect(track).toMatchObject({ failures: 0, nextAt: 0 })
      // One confirmation later, the waiting payout is signed in that very poll (no accrued delay).
      chain.mine()
      await settle(backoff, 1011)
      expect(state.getPayout('game-a')?.status).toBe('confirmed')
      expect(state.getPayout('game-b')?.status).toBe('submitted')
    })

    it('a payout whose build keeps failing is retried forever at the 60s cap and never changes state, but alerts', async () => {
      await startWinningGame()
      chain.failBuild = new Error('estimateGas reverted')
      await stand()
      const errors = jest.spyOn(console, 'error').mockImplementation(() => undefined)
      const backoff: PayoutBackoff = new Map()
      const base = state.getPayout('game-a')!.owedAt
      let t = base
      const buildsAt = chain.builds
      await settle(backoff, t)
      await settle(backoff, t + 1) // inside backoff: skipped
      expect(chain.builds).toBe(buildsAt + 1)
      for (let i = 0; i < 30; i++) {
        t += 61000
        await settle(backoff, t)
      }
      expect(state.getPayout('game-a')).toMatchObject({ status: 'owed', amountWei: 200n })
      expect(chain.builds).toBe(buildsAt + 31) // still trying, every 60s
      expect(backoff.get('game-a')!.nextAt - t).toBe(60000) // capped
      const alerts = errors.mock.calls.map((c) => String(c[0])).filter((l) => l.includes('PAYOUT STUCK'))
      expect(alerts.length).toBeGreaterThanOrEqual(2)
      expect(JSON.parse(alerts[0].slice(alerts[0].indexOf('{')))).toMatchObject({ gameId: 'game-a', status: 'owed' })
      expect(state.openExposureWei()).toBe(200n)
      // The moment the payer is funded again it is paid, once.
      chain.failBuild = undefined
      t += 61000
      await settle(backoff, t)
      chain.mine()
      await settle(backoff, t + 1)
      expect(paid()).toBe(200n)
      errors.mockRestore()
    })

    it('re-broadcasts a submitted payout the node dropped, with the SAME bytes, on the 30s boundary; one payout results', async () => {
      await startWinningGame()
      await stand() // submitted at nonce 0
      const p = state.getPayout('game-a')!
      chain.mempool.delete(p.txHash!) // mempool eviction
      const submits = () => chain.events.filter((e) => e === 'submitRaw').length
      const backoff: PayoutBackoff = new Map()
      const T = 10_000_000
      const before = submits()
      await settle(backoff, T) // first sighting: pendingSince = T
      await settle(backoff, T + 29_999)
      expect(submits()).toBe(before)
      await settle(backoff, T + 30_000)
      expect(submits()).toBe(before + 1)
      expect(chain.mempool.get(p.txHash!)?.raw).toBe(p.rawTx)
      await settle(backoff, T + 30_001) // interval restarts after a re-offer
      expect(submits()).toBe(before + 1)
      await settle(backoff, T + 60_000)
      expect(submits()).toBe(before + 2) // (node says "already known"; harmless)
      chain.mine()
      await settle(backoff, T + 60_001)
      expect(chain.builds).toBe(1)
      expect(chain.mined.size).toBe(1)
      expect(paid()).toBe(200n)
      expect(state.getPayout('game-a')?.status).toBe('confirmed')
    })

    it('PAYOUT STUCK for an aged unconfirmed payout carries nonce and txHash and is rate limited; failed re-alerts after a restart', async () => {
      await startWinningGame()
      await stand() // submitted, never mines
      const p = state.getPayout('game-a')!
      const errors = jest.spyOn(console, 'error').mockImplementation(() => undefined)
      const alerts = () => errors.mock.calls.map((c) => String(c[0])).filter((l) => l.includes('PAYOUT STUCK'))
      const backoff: PayoutBackoff = new Map()
      const t0 = p.owedAt
      await settle(backoff, t0 + 1000)
      expect(alerts()).toHaveLength(0) // young
      await settle(backoff, t0 + 6 * 60 * 1000)
      expect(alerts()).toHaveLength(1)
      await settle(backoff, t0 + 7 * 60 * 1000)
      expect(alerts()).toHaveLength(1) // rate limited
      await settle(backoff, t0 + 17 * 60 * 1000)
      expect(alerts()).toHaveLength(2)
      const body = JSON.parse(alerts()[0].slice(alerts()[0].indexOf('{')))
      expect(body).toMatchObject({ gameId: 'game-a', status: 'submitted', nonce: 0, txHash: p.txHash })
      expect(body.ageMs).toBeGreaterThan(5 * 60 * 1000)

      // Reverted on chain: failed, and OPERATOR ACTION again at every restart, not only once.
      chain.revertNext = true
      chain.mine()
      await settle(backoff, t0 + 18 * 60 * 1000)
      expect(state.getPayout('game-a')?.status).toBe('failed')
      errors.mockClear()
      await settle(new Map(), t0 + 60 * 1000) // "restart": fresh in-memory tracking, payout is young
      expect(alerts()).toHaveLength(1)
      expect(alerts()[0]).toContain('OPERATOR ACTION')
      errors.mockRestore()
    })
  })

  describe('operator tool', () => {
    async function failedPayout() {
      await startWinningGame()
      await stand()
      chain.revertNext = true
      chain.mine()
      const errors = jest.spyOn(console, 'error').mockImplementation(() => undefined)
      await settle()
      errors.mockRestore()
      expect(state.getPayout('game-a')?.status).toBe('failed')
    }

    it('list shows every non-confirmed payout', async () => {
      await failedPayout()
      expect(listPayouts(state)).toEqual([
        expect.objectContaining({ gameId: 'game-a', status: 'failed', amountWei: '200', nonce: 0, playerAddress: PLAYER_CANON }),
      ])
    })

    it('plain requeue needs --i-verified-reverted, accepts only failed, and re-signs once', async () => {
      await failedPayout()
      await expect(requeuePayout(state, 'game-a', { verifiedReverted: false })).rejects.toThrow('--i-verified-reverted')
      expect(state.getPayout('game-a')?.status).toBe('failed')

      await requeuePayout(state, 'game-a', { verifiedReverted: true })
      expect(state.getPayout('game-a')).toEqual({ status: 'owed', amountWei: 200n, owedAt: expect.any(Number) })
      await reopen()
      await settle()
      chain.mine()
      await settle()
      expect(state.getPayout('game-a')?.status).toBe('confirmed')
      expect(paid()).toBe(200n) // the reverted tx moved nothing; the fresh one paid once
      expect(chain.builds).toBe(2)
      await expect(requeuePayout(state, 'game-a', { verifiedReverted: true })).rejects.toThrow('confirmed')
    })

    it('plain requeue refuses owed, submitting and submitted payouts', async () => {
      await startWinningGame()
      chain.failBuild = new Error('x')
      await stand()
      await expect(requeuePayout(state, 'game-a', { verifiedReverted: true })).rejects.toThrow('owed')
      chain.failBuild = undefined
      chain.failSubmit = { error: new Error('x'), reachesMempool: false }
      await settle()
      expect(state.getPayout('game-a')?.status).toBe('submitting')
      await expect(requeuePayout(state, 'game-a', { verifiedReverted: true })).rejects.toThrow('submitting')
      await settle(undefined, Date.now() + 1)
      await expect(requeuePayout(state, 'game-a', { verifiedReverted: true })).rejects.toThrow('submitted')
      expect(state.getPayout('game-a')?.rawTx).toBeDefined()
    })

    describe('--nonce-consumed-by (evidence-checked requeue of a signed payout)', () => {
      const PAYER = `0x${'dd'.repeat(20)}`
      const OTHER = `0x${'77'.repeat(32)}`
      type Tx = { from: string; nonce: number; blockNumber: number | null }
      let txs: Record<string, Tx | null>
      let receipts: Record<string, { status: number } | null>
      let count: number
      let boom: string | undefined
      const provider = () => ({
        getTransaction: async (h: string) => {
          if (boom === 'getTransaction') throw new Error('rpc down')
          return txs[h.toLowerCase()] ?? null
        },
        getTransactionReceipt: async (h: string) => {
          if (boom === 'getTransactionReceipt') throw new Error('rpc down')
          return receipts[h.toLowerCase()] ?? null
        },
        getTransactionCount: async () => {
          if (boom === 'getTransactionCount') throw new Error('rpc down')
          return count
        },
      })
      const run = (h = OTHER) =>
        requeueNonceConsumed(state, 'game-a', { otherTxHash: h, payerAddress: PAYER, provider: provider() })

      async function signedPayout(status: 'submitting' | 'submitted') {
        await startWinningGame()
        if (status === 'submitting') chain.failSubmit = { error: new Error('lost'), reachesMempool: false }
        await stand()
        expect(state.getPayout('game-a')?.status).toBe(status)
        const p = state.getPayout('game-a')!
        chain.mempool.delete(p.txHash!) // the old tx is gone from the node
        // Another tx from the payer consumed nonce 0.
        txs = { [OTHER]: { from: PAYER, nonce: 0, blockNumber: 5 } }
        receipts = { [OTHER]: { status: 1 } }
        count = 1
        boom = undefined
        return p
      }
      const unchanged = (p: { txHash?: string }) => {
        expect(state.getPayout('game-a')).toMatchObject({ txHash: p.txHash })
        expect(state.hasSignedUnconfirmedPayout()).toBe(true)
      }

      it.each(['submitting', 'submitted'] as const)('accepts %s when the nonce was consumed, then re-signs at the new nonce and pays once', async (status) => {
        const p = await signedPayout(status)
        await run()
        expect(state.getPayout('game-a')).toEqual({ status: 'owed', amountWei: 200n, owedAt: expect.any(Number) })
        // Fake chain: the external tx took nonce 0.
        chain.mined.set(OTHER, { nonce: 0, to: PLAYER_CANON.replace(/a/gi, 'c'), value: 1n })
        await reopen()
        await settle()
        chain.mine()
        await settle()
        expect(state.getPayout('game-a')?.status).toBe('confirmed')
        expect(chain.mined.get(state.getPayout('game-a')!.txHash!)!.nonce).toBe(1)
        expect(paid()).toBe(200n)
        expect(p.txHash).toBeDefined()
      })

      it('refuses when the old payout tx actually mined', async () => {
        const p = await signedPayout('submitted')
        receipts[p.txHash!.toLowerCase()] = { status: 1 }
        await expect(run()).rejects.toThrow(/HAS a receipt/)
        unchanged(p)
      })

      it('refuses when the old payout tx is still pending on the node', async () => {
        const p = await signedPayout('submitted')
        txs[p.txHash!.toLowerCase()] = { from: PAYER, nonce: 0, blockNumber: null }
        await expect(run()).rejects.toThrow(/still knows/)
        unchanged(p)
      })

      it('refuses when the other tx is from a different sender', async () => {
        const p = await signedPayout('submitted')
        txs[OTHER]!.from = `0x${'ee'.repeat(20)}`
        await expect(run()).rejects.toThrow(/not the payer/)
        unchanged(p)
      })

      it('refuses when the other tx has a different nonce', async () => {
        const p = await signedPayout('submitted')
        txs[OTHER]!.nonce = 7
        await expect(run()).rejects.toThrow(/nonce 7/)
        unchanged(p)
      })

      it('refuses when the other tx is unconfirmed (pending or without a receipt)', async () => {
        const p = await signedPayout('submitted')
        txs[OTHER]!.blockNumber = null
        await expect(run()).rejects.toThrow(/not confirmed/)
        txs[OTHER]!.blockNumber = 5
        receipts[OTHER] = null
        await expect(run()).rejects.toThrow(/not confirmed/)
        unchanged(p)
      })

      it("refuses when the payer's confirmed count does not exceed the nonce", async () => {
        const p = await signedPayout('submitted')
        count = 0
        await expect(run()).rejects.toThrow(/not greater/)
        unchanged(p)
      })

      it.each(['getTransaction', 'getTransactionReceipt', 'getTransactionCount'])('fails closed on an RPC error in %s', async (method) => {
        const p = await signedPayout('submitted')
        boom = method
        await expect(run()).rejects.toThrow(/nothing changed/)
        unchanged(p)
      })

      it('refuses the payout tx itself and refuses non-signed statuses', async () => {
        const p = await signedPayout('submitted')
        await expect(run(p.txHash)).rejects.toThrow(/itself/)
        unchanged(p)
        await state.requeuePayout('game-a', ['submitted'])
        await expect(run()).rejects.toThrow(/owed/)
      })

      it('the CLI needs --payer and a provider, prints the double-payment reminder, and requeues on good evidence', async () => {
        await signedPayout('submitted')
        const log = jest.spyOn(console, 'log').mockImplementation(() => undefined)
        const err = jest.spyOn(console, 'error').mockImplementation(() => undefined)
        expect(await runAdminCli(['requeue', 'game-a', '--nonce-consumed-by', OTHER], state, { provider: provider() })).toBe(1)
        expect(await runAdminCli(['requeue', 'game-a', '--nonce-consumed-by', OTHER, '--payer', PAYER], state)).toBe(1)
        expect(await runAdminCli(['requeue', 'game-a', '--nonce-consumed-by', OTHER, '--payer', PAYER], state, { provider: provider() })).toBe(0)
        expect(log).toHaveBeenCalledWith(DOUBLE_PAYMENT_REMINDER)
        expect(state.getPayout('game-a')?.status).toBe('owed')
        log.mockRestore()
        err.mockRestore()
      })
    })

    it('the plain CLI mode wraps the same guard', async () => {
      await failedPayout()
      const log = jest.spyOn(console, 'error').mockImplementation(() => undefined)
      expect(await runAdminCli(['requeue', 'game-a'], state)).toBe(1)
      expect(await runAdminCli(['requeue', 'game-a', '--i-verified-not-mined'], state)).toBe(1) // old flag is gone
      expect(await runAdminCli(['requeue', 'game-a', '--i-verified-reverted'], state)).toBe(0)
      expect(await runAdminCli(['bogus'], state)).toBe(2)
      log.mockRestore()
    })
  })
})
