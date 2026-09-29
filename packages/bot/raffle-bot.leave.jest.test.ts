import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import {
  evaluateLeaveRequest,
  handleLeaveRequest,
  createRefundSweeper,
  drawSpendableWei,
  RefundDeps,
  reservedRefundWei,
  retryPendingRefunds,
} from './raffle-bot.livecheck'
import { RaffleBotStateStore, RaffleRoundRecord } from './raffle-bot-state'

const A = '0x1111111111111111111111111111111111111111'
const B = '0x2222222222222222222222222222222222222222'
const C = '0x3333333333333333333333333333333333333333'
const IDENTITY = '0x9999999999999999999999999999999999999999'

function makeRound(
  entrants: string[],
  extra: Partial<RaffleRoundRecord> = {},
): RaffleRoundRecord {
  return {
    raffleId: 'r1',
    entryPriceWei: '1000',
    maxEntries: 3,
    serverSeedHash: 'h',
    entrants: entrants.map((address, i) => ({ address, txHash: `0x${i}` })),
    ...extra,
  }
}

/** Tracks whether any store mutation is still unflushed, so the fake signer can assert that
 * nothing is submitted while state is dirty. */
class SpyStore extends RaffleBotStateStore {
  dirty = false
  events: string[]
  constructor(dir: string, events: string[]) {
    super(dir)
    this.events = events
  }
  commitLeave(...args: Parameters<RaffleBotStateStore['commitLeave']>) {
    this.dirty = true
    this.events.push('commit')
    super.commitLeave(...args)
  }
  setPendingRefundTx(
    ...args: Parameters<RaffleBotStateStore['setPendingRefundTx']>
  ) {
    this.dirty = true
    this.events.push('journal')
    super.setPendingRefundTx(...args)
  }
  clearPendingRefund(h: string) {
    this.dirty = true
    this.events.push('clear')
    super.clearPendingRefund(h)
  }
  async flush() {
    await super.flush()
    this.dirty = false
    this.events.push('flush')
  }
}

describe('leave handling', () => {
  let dir: string
  let store: SpyStore
  let events: string[]
  let submitted: { rawTx: string; hash: string }[]
  let signed: { to: string; value: bigint }[]
  let replies: { action: string; message?: string }[]
  let balance: bigint
  let statuses: Record<string, 'pending' | 'confirmed' | 'failed'>
  let crashOnSubmit: boolean
  let submitError: Error | undefined
  let confirmedNonce: number
  let nextNonce: number

  function deps(): RefundDeps {
    return {
      state: store,
      identityAddress: IDENTITY,
      provider: {
        getBalance: async () => balance,
        getFeeData: async () => ({ maxFeePerGas: 1n } as never),
        getTransactionCount: async () => confirmedNonce,
      },
      signer: {
        buildAndSignTransfer: async (to, value) => {
          // The leave (removal + refund record) must be durable before any money-side work.
          expect(store.dirty).toBe(false)
          signed.push({ to, value })
          const n = signed.length
          return { rawTx: `0xraw${n}`, txHash: `0xtx${n}`, nonce: nextNonce++ }
        },
        submitRaw: async (rawTx, hash) => {
          // Money moves here: state must already be durable.
          expect(store.dirty).toBe(false)
          events.push('submit')
          if (crashOnSubmit) throw new Error('crash after submit')
          if (submitError) throw submitError
          submitted.push({ rawTx, hash })
          return hash
        },
        getStatus: async h => statuses[h] ?? 'pending',
      },
      ensureFunded: async () => {},
    }
  }
  function leave(
    round: RaffleRoundRecord,
    who: string,
    payload: string,
    raffleId = round.raffleId,
  ) {
    return handleLeaveRequest({
      ...deps(),
      round,
      raffleId,
      requesterAddress: who,
      payloadHashHex: payload,
      sendReply: async items => {
        replies.push(items[0] as never)
      },
    })
  }

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'raffle-leave-'))
    events = []
    store = new SpyStore(dir, events)
    await store.Open()
    submitted = []
    signed = []
    replies = []
    balance = 10_000n
    statuses = {}
    crashOnSubmit = false
    submitError = undefined
    confirmedNonce = 0
    nextNonce = 0
  })
  afterEach(async () => {
    await store.Close().catch(() => undefined)
    rmSync(dir, { recursive: true, force: true })
  })

  it('persists removal + refund record before submitting, refunds exact amount to the leaver', async () => {
    const round = makeRound([A, B])
    store.setCurrentRound(round)
    const res = await leave(round, B, 'p1')
    expect(res).toBe('refunded')
    // Mempool acceptance is not payment: the record stays until a receipt is seen.
    expect(store.getPendingRefunds()).toHaveLength(1)
    statuses['0xtx1'] = 'confirmed'
    await retryPendingRefunds(deps(), () => undefined)
    expect(signed).toEqual([{ to: B, value: 1000n }])
    expect(submitted).toEqual([{ rawTx: '0xraw1', hash: '0xtx1' }])
    expect(events.indexOf('flush')).toBeLessThan(events.indexOf('submit'))
    expect(events.indexOf('commit')).toBeLessThan(events.indexOf('submit'))
    expect(events.indexOf('journal')).toBeLessThan(events.indexOf('submit'))
    expect(store.getPendingRefunds()).toEqual([])
    expect(store.getCurrentRound()?.entrants.map(e => e.address)).toEqual([A])
    expect(store.hasProcessed('p1')).toBe(true)
    expect(replies.map(r => r.action)).toEqual(['left'])
  })

  it('insufficient balance leaves a pending refund and an error reply, nothing submitted', async () => {
    const round = makeRound([A, B])
    store.setCurrentRound(round)
    balance = 999n
    const res = await leave(round, B, 'p1')
    expect(res).toBe('refund-pending')
    expect(submitted).toEqual([])
    expect(store.getPendingRefunds()).toEqual([
      { payloadHash: 'p1', recipient: B, amountWei: '1000', raffleId: 'r1' },
    ])
    expect(replies.map(r => r.action)).toEqual(['error'])
    expect(store.getCurrentRound()?.entrants).toHaveLength(1)
  })

  it('retries a pending refund exactly once after a simulated crash (persisted across reopen)', async () => {
    const round = makeRound([A, B])
    store.setCurrentRound(round)
    balance = 999n
    await leave(round, B, 'p1')
    await store.Close()

    // "Restart": fresh store on the same dir, balance now sufficient.
    store = new SpyStore(dir, events)
    await store.Open()
    balance = 10_000n
    expect(store.getPendingRefunds()).toHaveLength(1)
    expect(store.getCurrentRound()?.entrants).toHaveLength(1)
    const first = await retryPendingRefunds(deps(), () => undefined)
    expect(first.stillPending).toEqual(['p1'])
    expect(submitted).toHaveLength(1)
    expect(signed).toEqual([{ to: B, value: 1000n }])
    statuses['0xtx1'] = 'confirmed'
    const second = await retryPendingRefunds(deps(), () => undefined)
    expect(second.confirmed).toEqual(['p1'])
    expect(store.getPendingRefunds()).toEqual([])
    expect(submitted).toHaveLength(1)
  })

  it('crash after submit: replay rebroadcasts the SAME signed tx, or just clears if confirmed; never signs a second refund', async () => {
    const round = makeRound([A, B])
    store.setCurrentRound(round)
    crashOnSubmit = true
    expect(await leave(round, B, 'p1')).toBe('refund-pending')
    expect(signed).toHaveLength(1)
    await store.Close()

    store = new SpyStore(dir, events)
    await store.Open()
    crashOnSubmit = false
    expect(store.getPendingRefunds()[0].txHash).toBe('0xtx1')
    statuses['0xtx1'] = 'confirmed'
    const r = await retryPendingRefunds(deps(), () => undefined)
    expect(r.confirmed).toEqual(['p1'])
    expect(signed).toHaveLength(1) // no second signature
    expect(submitted).toEqual([]) // confirmed: nothing to rebroadcast
    expect(store.getPendingRefunds()).toEqual([])
  })

  it('rejects leave on a full round and does not refund', async () => {
    const round = makeRound([A, B, C]) // maxEntries 3
    store.setCurrentRound(round)
    expect(
      evaluateLeaveRequest({ round, raffleId: 'r1', requesterAddress: A }).ok,
    ).toBe(false)
    const res = await leave(round, A, 'p1')
    expect(res).toBe('rejected')
    expect(signed).toEqual([])
    expect(store.getCurrentRound()?.entrants).toHaveLength(3)
    expect(store.getPendingRefunds()).toEqual([])
    expect(replies[0].message).toMatch(/full/)
  })

  it('rejects a second leave by the same address in the same round', async () => {
    let round = makeRound([A, B])
    store.setCurrentRound(round)
    await leave(round, B, 'p1')
    // B re-enters (entry logic unchanged; leavers carried on the round record).
    round = {
      ...(store.getCurrentRound() as RaffleRoundRecord),
      entrants: [
        ...(store.getCurrentRound() as RaffleRoundRecord).entrants,
        { address: B, txHash: '0xnew' },
      ],
    }
    store.setCurrentRound(round)
    const res = await leave(round, B, 'p2')
    expect(res).toBe('rejected')
    expect(signed).toHaveLength(1)
    expect(replies[1].message).toMatch(/only one leave/)
    expect(store.getCurrentRound()?.entrants.map(e => e.address)).toContain(B)
  })

  it('double leave (same message twice in a row) refunds once', async () => {
    const round = makeRound([A, B])
    store.setCurrentRound(round)
    await leave(round, B, 'p1')
    const after = store.getCurrentRound() as RaffleRoundRecord
    const res = await leave(after, B, 'p2')
    expect(res).toBe('rejected')
    expect(signed).toHaveLength(1)
    expect(submitted).toHaveLength(1)
  })

  it('rejects a stale round id', async () => {
    const round = makeRound([A, B])
    store.setCurrentRound(round)
    const res = await leave(round, B, 'p1', 'old-round')
    expect(res).toBe('rejected')
    expect(signed).toEqual([])
    expect(store.getCurrentRound()?.entrants).toHaveLength(2)
  })

  it('A: journaled refund whose nonce was consumed is discarded and re-signed once', async () => {
    const round = makeRound([A, B])
    store.setCurrentRound(round)
    submitError = new Error('transient rpc failure')
    expect(await leave(round, B, 'p1')).toBe('refund-pending')
    expect(store.getPendingRefunds()[0].nonce).toBe(0)
    submitError = undefined
    confirmedNonce = 1 // another tx (draw payout / other refund) consumed nonce 0
    const r = await retryPendingRefunds(deps(), () => undefined)
    expect(r.stillPending).toEqual(['p1'])
    expect(signed).toHaveLength(2) // re-signed fresh, exactly once more
    expect(store.getPendingRefunds()[0].txHash).toBe('0xtx2')
    expect(submitted).toEqual([{ rawTx: '0xraw2', hash: '0xtx2' }])
    // and the first tx is never rebroadcast
    await retryPendingRefunds(deps(), () => undefined)
    expect(signed).toHaveLength(2)
  })

  it('A: journaled refund that failed on-chain is re-signed', async () => {
    const round = makeRound([A, B])
    store.setCurrentRound(round)
    await leave(round, B, 'p1')
    statuses['0xtx1'] = 'failed'
    await retryPendingRefunds(deps(), () => undefined)
    expect(signed).toHaveLength(2)
    expect(store.getPendingRefunds()[0].txHash).toBe('0xtx2')
  })

  it('A: a mined-late journaled tx is confirmed, never re-signed (count read before receipt)', async () => {
    const round = makeRound([A, B])
    store.setCurrentRound(round)
    await leave(round, B, 'p1')
    confirmedNonce = 1
    statuses['0xtx1'] = 'confirmed'
    const r = await retryPendingRefunds(deps(), () => undefined)
    expect(r.confirmed).toEqual(['p1'])
    expect(signed).toHaveLength(1)
  })

  it('A: a new refund does not get signed while an earlier journaled one cannot be rebroadcast', async () => {
    let round = makeRound([A, B, C], { maxEntries: 5 })
    store.setCurrentRound(round)
    submitError = new Error('rpc down')
    await leave(round, B, 'p1')
    round = store.getCurrentRound() as RaffleRoundRecord
    await leave(round, C, 'p2')
    expect(signed).toHaveLength(1) // p2 deferred, nonce 0 not double-allocated
    expect(
      store.getPendingRefunds().find(r => r.payloadHash === 'p2')?.rawTx,
    ).toBeUndefined()
  })

  it('B: record survives mempool acceptance; a dropped tx (nonce never consumed) is rebroadcast', async () => {
    const round = makeRound([A, B])
    store.setCurrentRound(round)
    await leave(round, B, 'p1')
    expect(store.getPendingRefunds()).toHaveLength(1)
    await retryPendingRefunds(deps(), () => undefined) // still no receipt
    expect(submitted.map(x => x.hash)).toEqual(['0xtx1', '0xtx1'])
    expect(store.getPendingRefunds()).toHaveLength(1)
    expect(signed).toHaveLength(1)
  })

  it('C: sweeper retries within the poll loop with backoff, one at a time', async () => {
    const round = makeRound([A, B])
    store.setCurrentRound(round)
    submitError = new Error('transient')
    await leave(round, B, 'p1')
    submitError = undefined
    let t = 1_000
    const sweeper = createRefundSweeper(deps(), {
      now: () => t,
      baseMs: 100,
      maxMs: 400,
    })
    await sweeper.tick() // sweep 1 (rebroadcast)
    expect(submitted).toHaveLength(1)
    await sweeper.tick() // within backoff: no-op
    expect(submitted).toHaveLength(1)
    t += 100
    await sweeper.tick() // sweep 2
    expect(submitted).toHaveLength(2)
    t += 100 // backoff doubled to 200 -> still too early
    await sweeper.tick()
    expect(submitted).toHaveLength(2)
    t += 100
    statuses['0xtx1'] = 'confirmed'
    await sweeper.tick()
    expect(store.getPendingRefunds()).toEqual([])
  })

  it('D: reservedRefundWei counts every unconfirmed refund so a draw cannot spend it', async () => {
    const round = makeRound([A, B])
    store.setCurrentRound(round)
    await leave(round, B, 'p1') // submitted, unmined
    expect(reservedRefundWei(store)).toBe(1000n)
    // Round refills to 3 entrants (pot 3000) while the refund is unmined; latest balance 3500
    // still includes the refund's 1000, spendable = 2500 < pot -> draw check must refuse.
    const latest = 3500n
    expect(drawSpendableWei(latest, store)).toBe(2500n)
    expect(drawSpendableWei(latest, store) < 3000n).toBe(true)
    statuses['0xtx1'] = 'confirmed'
    await retryPendingRefunds(deps(), () => undefined)
    expect(reservedRefundWei(store)).toBe(0n)
  })

  it('E: unsigned refund retry requires the balance to still cover the current round pot', async () => {
    const round = makeRound([A, B])
    store.setCurrentRound(round)
    balance = 999n
    await leave(round, B, 'p1')
    balance = 1500n // covers refund (1000) but not refund + pot of 1 entrant (1000)
    const r = await retryPendingRefunds(deps(), () => undefined)
    expect(r.stillPending).toEqual(['p1'])
    expect(signed).toHaveLength(0)
  })

  it('loads a round persisted without leavers (backward compatible)', async () => {
    store.setCurrentRound(makeRound([A]))
    await store.Close()
    store = new SpyStore(dir, events)
    await store.Open()
    expect(store.getCurrentRound()?.leavers).toBeUndefined()
    expect(
      evaluateLeaveRequest({
        round: store.getCurrentRound() as RaffleRoundRecord,
        raffleId: 'r1',
        requesterAddress: A,
      }).ok,
    ).toBe(true)
  })
})
