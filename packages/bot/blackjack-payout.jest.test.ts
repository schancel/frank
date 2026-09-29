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
  settlePayouts,
} from './blackjack-bot.livecheck'

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
})
