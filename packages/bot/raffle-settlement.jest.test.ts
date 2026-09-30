import { createHash, randomBytes } from 'crypto'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import { Transaction, Wallet } from 'ethers'

import { RaffleItem } from '@frank/cashweb/types/messages'
import { MonadAccountTxSigner } from '@frank/wallet/monad-account-tx'
import { MonadHttpClient } from '@frank/wallet/monad-http'
import { verifyRaffleDraw } from '@frank/wallet/message-item-plugins/raffle/draw'
import { JsonRpcProvider } from 'ethers'

import { startFakeRpc } from './demo/fake-rpc'
import { RaffleBotStateStore, RaffleRoundRecord } from './raffle-bot-state'
import {
  beginDrawIfFull,
  createRaffleSettler,
  raffleTick,
  repriceSignedPayout,
  runRaffleLoop,
  RaffleSettlementPorts,
} from './raffle-settlement'
import { sha256Hex } from '@frank/wallet/message-item-plugins/raffle/draw'

const PRICE = 20_000_000_000_000_000n // 0.02 MON
const DUST = 1_848_000_000_000_000n // sweep gas taken from each entry (matches #363's numbers)
const GAS = 1_000_000_000_000_000n
const CAP = 50_000_000_000_000_000n
const A = [
  '0x' + 'a1'.repeat(20),
  '0x' + 'a2'.repeat(20),
  '0x' + 'a3'.repeat(20),
]

/** In-memory chain double: identity + operator balances, a mempool and explicit mining. */
class FakeLedger {
  identity = 0n
  operator = 10n ** 18n
  balances = new Map<string, bigint>()
  nonce = 0
  mempool = new Map<
    string,
    { to: string; value: bigint; nonce: number; fee: bigint }
  >()
  lag = false // receipts/mempool invisible although a tx may have mined
  maxAcceptedFee = 1_000_000n
  repriceCalls = 0
  topSigned = 0
  topMined = new Set<string>()
  autoMineTopUp = true
  toppedRaw = new Map<string, bigint>()
  mined = new Set<string>()
  minedNonces = new Set<number>()
  clock = 1_000_000
  rejectBroadcast = false
  errors: string[] = []
  warns: string[] = []
  broadcastCalls = 0
  signCalls = 0
  topUps = 0
  announces: string[] = []
  announcedAfterPay: boolean[] = []
  refundTxs = 0
  reverted = new Set<string>()
  autoMine = true

  mine() {
    for (const [hash, tx] of this.mempool) {
      if (this.mined.has(hash) || this.reverted.has(hash)) continue
      if (this.minedNonces.has(tx.nonce)) continue // a nonce mines at most once
      this.minedNonces.add(tx.nonce)
      this.mined.add(hash)
      this.identity -= tx.value + (tx.fee * GAS) / 16n
      this.balances.set(tx.to, (this.balances.get(tx.to) ?? 0n) + tx.value)
    }
  }
  mineTopUps() {
    for (const [hash, amt] of this.toppedRaw) {
      if (this.topMined.has(hash)) continue
      this.topMined.add(hash)
      this.operator -= amt
      this.identity += amt
      this.topUps++
    }
  }
  paid(to: string) {
    return this.balances.get(to) ?? 0n
  }
}

type Hooks = Partial<{
  onTopUp: () => void
  onSign: () => void
  onBroadcast: () => void
  onStatus: () => void
  onAnnounce: (to: string) => void
}>

function makePorts(
  l: FakeLedger,
  hooks: Hooks = {},
  winner?: () => string,
): RaffleSettlementPorts {
  return {
    getBalanceWei: async () => l.identity,
    operatorBalanceWei: async () => l.operator,
    sweepDustWei: async () => DUST,
    isTxKnown: async h => !l.lag && (l.mempool.has(h) || l.toppedRaw.has(h)),
    repricePayout: async (prev, budget) => {
      const [, nonce, to, value, fee] = prev.split(':')
      let f = BigInt(fee) * 2n
      const affordable = (budget * 16n) / GAS
      if (f > affordable) f = affordable
      if (f < (BigInt(fee) * 1125n) / 1000n + 1n) return undefined
      l.repriceCalls++
      const rawTx = `raw:${nonce}:${to}:${value}:${f}`
      const txHash = '0x' + createHash('sha256').update(rawTx).digest('hex')
      return { rawTx, txHash }
    },
    payoutGasReserveWei: async () => GAS,
    signTopUp: async amount => {
      hooks.onTopUp?.()
      const rawTx = `top:${l.topSigned++}:${amount}`
      return {
        rawTx,
        txHash: '0x' + createHash('sha256').update(rawTx).digest('hex'),
      }
    },
    broadcastTopUp: async (rawTx, txHash) => {
      l.toppedRaw.set(txHash, BigInt(rawTx.split(':')[2]))
      if (l.autoMineTopUp) l.mineTopUps()
    },
    getTopUpStatus: async h =>
      l.topMined.has(h) && !l.lag ? 'confirmed' : 'pending',
    signPayout: async (to, value) => {
      hooks.onSign?.()
      l.signCalls++
      const nonce = l.nonce++
      const rawTx = `raw:${nonce}:${to}:${value}:8`
      const txHash = '0x' + createHash('sha256').update(rawTx).digest('hex')
      return { rawTx, txHash }
    },
    broadcast: async (rawTx, txHash) => {
      hooks.onBroadcast?.()
      l.broadcastCalls++
      if (l.rejectBroadcast) throw new Error('underpriced')
      const [, nonce, to, value, fee] = rawTx.split(':')
      if (l.minedNonces.has(Number(nonce)) && !l.mined.has(txHash)) {
        throw new Error('nonce too low')
      }
      if (
        BigInt(fee) > l.maxAcceptedFee ||
        l.identity < BigInt(value) + (BigInt(fee) * GAS) / 16n
      ) {
        throw new Error('insufficient funds for gas * price + value')
      }
      l.mempool.set(txHash, {
        to,
        value: BigInt(value),
        nonce: Number(nonce),
        fee: BigInt(fee),
      })
      if (l.autoMine) l.mine()
    },
    getStatus: async txHash => {
      hooks.onStatus?.()
      if (l.reverted.has(txHash)) return 'failed'
      return l.mined.has(txHash) && !l.lag ? 'confirmed' : 'pending'
    },
    announce: async (to, draw) => {
      hooks.onAnnounce?.(to)
      l.announcedAfterPay.push(
        l.paid((draw as any).winnerAddress) >= BigInt((draw as any).potWei),
      )
      l.announces.push(to)
    },
    log: () => {},
    warn: m => void l.warns.push(m),
    error: m => void l.errors.push(m),
  }
}

let dir: string
let stores: RaffleBotStateStore[]
async function openStore(
  cls: typeof RaffleBotStateStore = RaffleBotStateStore,
) {
  const s = new cls(dir)
  await s.Open()
  stores.push(s)
  return s
}
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'raffle-settle-'))
  stores = []
})
afterEach(async () => {
  for (const s of stores) await s.Close().catch(() => {})
  rmSync(dir, { recursive: true, force: true })
})

function fullRound(state: RaffleBotStateStore): RaffleRoundRecord {
  const serverSeed = randomBytes(32).toString('hex')
  const round: RaffleRoundRecord = {
    raffleId: 'r1',
    entryPriceWei: PRICE.toString(),
    maxEntries: 3,
    serverSeedHash: sha256Hex(serverSeed),
    entrants: A.map((address, i) => ({
      address,
      txHash: '0x' + String(i + 1).repeat(64),
    })),
  }
  state.setPendingCommitment(serverSeed, round.serverSeedHash)
  state.setCurrentRound(round)
  return round
}

const begin = (state: RaffleBotStateStore) =>
  beginDrawIfFull({
    state,
    newServerSeed: () => randomBytes(32).toString('hex'),
    newRaffleId: () => randomBytes(4).toString('hex'),
    entryPriceWei: PRICE.toString(),
    maxEntries: 3,
  })
const settlerFor = (
  state: RaffleBotStateStore,
  l: FakeLedger,
  hooks?: Hooks,
  cap = CAP,
  perDay = CAP * 5n,
) =>
  createRaffleSettler({
    state,
    ports: makePorts(l, hooks),
    maxTopUpPerRoundWei: cap,
    maxTopUpPerDayWei: perDay,
    now: () => l.clock,
  })

/** #363's exact shape: entries arrive net of sweep gas, so the identity is short of the pot. */
function shortLedger(): FakeLedger {
  const l = new FakeLedger()
  l.identity = 3n * (PRICE - DUST)
  return l
}
const CRASH = new Error('simulated crash')
const once = (fn: () => void) => {
  let done = false
  return () => {
    if (!done) {
      done = true
      fn()
    }
  }
}
const winnerOf = (state: RaffleBotStateStore) =>
  (state.getDraws()[0]?.drawItem as any).winnerAddress as string

describe('raffle draw settlement (#363)', () => {
  it('pays the pot from a short identity (sweep gas topped up), pays before announcing, once', async () => {
    const l = shortLedger()
    const state = await openStore()
    const round = fullRound(state)
    expect(await begin(state)).toBe(true)
    const winner = winnerOf(state)
    const settle = settlerFor(state, l)
    expect((await settle()).map(r => r.status)).toEqual(['done'])
    expect(l.paid(winner)).toBe(3n * PRICE)
    expect(l.announces.sort()).toEqual([...A].sort())
    expect(l.announcedAfterPay.every(Boolean)).toBe(true)
    expect(l.topUps).toBe(1)
    expect(state.getDraws()).toEqual([])
    expect(state.getCurrentRound()?.raffleId).not.toBe(round.raffleId)
    await settle()
    expect(l.signCalls).toBe(1)
    expect(l.announces).toHaveLength(3)
  })

  it('records the draw and rotates the commitment atomically; the draw verifies', async () => {
    const state = await openStore()
    const round = fullRound(state)
    const oldSeed = state.getPendingCommitment()!
    await begin(state)
    const [draw] = state.getDraws()
    expect(draw.phase).toBe('awaiting-funds')
    expect(state.getPendingCommitment()!.serverSeedHash).not.toBe(
      oldSeed.serverSeedHash,
    )
    expect(state.getCurrentRound()!.entrants).toEqual([])
    expect(state.getCurrentRound()!.serverSeedHash).toBe(
      state.getPendingCommitment()!.serverSeedHash,
    )
    expect(
      verifyRaffleDraw({ ...(draw.drawItem as any), raffleId: round.raffleId })
        .valid,
    ).toBe(true)
    // Not full / already drawn: nothing to do.
    expect(await begin(state)).toBe(false)
  })

  describe('crash at each step, then restart from disk', () => {
    async function restart(state: RaffleBotStateStore) {
      await state.Close().catch(() => {})
      return openStore()
    }

    it('before persist (draw record write fails): round stays full, resumed, paid once', async () => {
      const l = shortLedger()
      class Crashy extends RaffleBotStateStore {
        async beginDraw(p: any): Promise<any> {
          throw CRASH
        }
      }
      const s1 = await openStore(Crashy)
      fullRound(s1)
      await s1.flush()
      await expect(begin(s1)).rejects.toBe(CRASH)
      expect(l.announces).toEqual([])
      const s2 = await restart(s1)
      expect(s2.getCurrentRound()!.entrants).toHaveLength(3)
      expect(await begin(s2)).toBe(true)
      await settlerFor(s2, l)()
      expect(l.paid(A.find(a => l.paid(a) > 0n)!)).toBe(3n * PRICE)
      expect([...l.balances.values()].reduce((x, y) => x + y, 0n)).toBe(
        3n * PRICE,
      )
    })

    it('after persist, before signing (top-up crashes): resumes, paid once', async () => {
      const l = shortLedger()
      const s1 = await openStore()
      fullRound(s1)
      await begin(s1)
      const r = await settlerFor(s1, l, {
        onTopUp: () => {
          throw CRASH
        },
      })()
      expect(r[0].status).toBe('held')
      expect(l.announces).toEqual([])
      const s2 = await restart(s1)
      await settlerFor(s2, l)()
      expect([...l.balances.values()].reduce((x, y) => x + y, 0n)).toBe(
        3n * PRICE,
      )
      expect(l.announces).toHaveLength(3)
    })

    it('after signing, before the intent is persisted: nothing was broadcast, re-sign is safe', async () => {
      const l = shortLedger()
      class Crashy extends RaffleBotStateStore {
        async putDraw(d: any) {
          if (d.phase === 'signed') throw CRASH
          return super.putDraw(d)
        }
      }
      const s1 = await openStore(Crashy)
      fullRound(s1)
      await begin(s1)
      await settlerFor(s1, l)()
      expect(l.broadcastCalls).toBe(0)
      expect(l.announces).toEqual([])
      const s2 = await restart(s1)
      await settlerFor(s2, l)()
      expect([...l.balances.values()].reduce((x, y) => x + y, 0n)).toBe(
        3n * PRICE,
      )
    })

    it('after persist, broadcast fails: same bytes retried, one payment', async () => {
      const l = shortLedger()
      l.autoMine = false
      const s1 = await openStore()
      fullRound(s1)
      await begin(s1)
      await settlerFor(s1, l, {
        onBroadcast: once(() => {
          throw CRASH
        }),
      })()
      expect(s1.getDraws()[0].phase).toBe('signed')
      const bytes = s1.getDraws()[0].payout
      const s2 = await restart(s1)
      const settle = settlerFor(s2, l)
      expect((await settle())[0].status).toBe('pending') // broadcast, not yet mined
      expect(s2.getDraws()[0].payout).toEqual(bytes)
      l.mine()
      expect((await settle())[0].status).toBe('done')
      expect(l.signCalls).toBe(1)
      expect([...l.balances.values()].reduce((x, y) => x + y, 0n)).toBe(
        3n * PRICE,
      )
    })

    it('after broadcast, before reconcile: reconciles by hash, never re-signs, no announce before pay', async () => {
      const l = shortLedger()
      l.autoMine = false
      const s1 = await openStore()
      fullRound(s1)
      await begin(s1)
      // Broadcast succeeds, then the process dies at the status read.
      const hook = {
        onStatus: () => {
          if (l.broadcastCalls > 0 && !hook.done) {
            hook.done = true
            throw CRASH
          }
        },
        done: false,
      }
      await settlerFor(s1, l, hook)()
      expect(l.broadcastCalls).toBe(1)
      expect(l.announces).toEqual([])
      l.mine() // it mined while we were down
      const s2 = await restart(s1)
      await settlerFor(s2, l)()
      expect(l.signCalls).toBe(1)
      expect(l.broadcastCalls).toBe(1) // confirmed by hash: not even re-broadcast
      expect([...l.balances.values()].reduce((x, y) => x + y, 0n)).toBe(
        3n * PRICE,
      )
      expect(l.announces).toHaveLength(3)
    })

    it('after reconcile, before/while announcing: no second payout, each entrant told once', async () => {
      const l = shortLedger()
      const s1 = await openStore()
      fullRound(s1)
      await begin(s1)
      let n = 0
      const r = await settlerFor(s1, l, {
        onAnnounce: () => {
          if (++n === 2) throw CRASH
        },
      })()
      expect(r[0].status).toBe('announce-incomplete')
      expect(s1.getDraws()[0].phase).toBe('paid')
      expect(l.announces).toHaveLength(2) // the other recipients are not blocked by one failure
      const s2 = await restart(s1)
      await settlerFor(s2, l)()
      expect(l.signCalls).toBe(1)
      expect(l.announces.sort()).toEqual([...A].sort())
      expect([...l.balances.values()].reduce((x, y) => x + y, 0n)).toBe(
        3n * PRICE,
      )
    })
  })

  describe('insufficient funds', () => {
    it('holds (no throw, no announce, no payout, no refund) and pays after the operator is funded', async () => {
      const l = shortLedger()
      l.operator = 0n
      const state = await openStore()
      fullRound(state)
      await begin(state)
      const settle = settlerFor(state, l)
      for (let i = 0; i < 3; i++)
        expect((await settle())[0].status).toBe('held')
      expect(l.announces).toEqual([])
      expect(l.signCalls).toBe(0)
      expect(l.refundTxs).toBe(0)
      expect(l.balances.size).toBe(0)
      // The next round is open and accepting entrants while the pot is held.
      expect(state.getCurrentRound()!.entrants).toEqual([])
      expect(state.getDraws()).toHaveLength(1)
      l.operator = 10n ** 18n
      expect((await settle())[0].status).toBe('done')
      expect([...l.balances.values()].reduce((x, y) => x + y, 0n)).toBe(
        3n * PRICE,
      )
    })

    it('holds without moving operator funds when the shortfall exceeds the top-up limit', async () => {
      const l = new FakeLedger() // zero-balance identity
      const state = await openStore()
      fullRound(state)
      await begin(state)
      expect((await settlerFor(state, l)())[0].status).toBe('held')
      expect(l.topUps).toBe(0)
      expect(l.announces).toEqual([])
    })

    it('a later full round queues behind a held one and is paid strictly after it', async () => {
      const l = shortLedger()
      l.operator = 0n
      const state = await openStore()
      fullRound(state)
      await begin(state)
      const c = state.getPendingCommitment()!
      state.setCurrentRound({
        ...state.getCurrentRound()!,
        entrants: A.map((address, i) => ({
          address,
          txHash: '0x' + String(i + 4).repeat(64),
        })),
      })
      expect(c.serverSeedHash).toBe(state.getCurrentRound()!.serverSeedHash)
      await begin(state)
      expect(state.getDraws()).toHaveLength(2)
      const settle = settlerFor(state, l)
      expect((await settle()).map(r => r.status)).toEqual(['held', 'queued'])
      expect(l.signCalls).toBe(0)
      l.operator = 10n ** 18n
      l.identity += 3n * (PRICE - DUST) // the second round's swept entries
      const res = await settle()
      expect(res.map(r => r.status)).toEqual(['done', 'done'])
      expect(l.signCalls).toBe(2)
    })
  })

  describe('payout reconciliation', () => {
    it('never re-signs while the tx is merely pending; re-broadcasts the same bytes', async () => {
      const l = shortLedger()
      l.autoMine = false
      const state = await openStore()
      fullRound(state)
      await begin(state)
      const settle = settlerFor(state, l)
      for (let i = 0; i < 4; i++)
        expect((await settle())[0].status).toBe('pending')
      expect(l.signCalls).toBe(1)
      expect(l.announces).toEqual([])
      l.mine()
      expect((await settle())[0].status).toBe('done')
      expect(new Set(l.mined).size).toBe(1)
    })

    it('a reverted (final) payout is re-signed once and paid once', async () => {
      const l = shortLedger()
      const state = await openStore()
      fullRound(state)
      await begin(state)
      const settle = settlerFor(state, l)
      l.autoMine = false
      await settle()
      const first = state.getDraws()[0].payout!.txHash
      l.reverted.add(first)
      await settle() // records the revert, back to awaiting-funds
      l.autoMine = true
      expect((await settle())[0].status).toBe('done')
      expect(l.signCalls).toBe(2)
      expect([...l.balances.values()].reduce((x, y) => x + y, 0n)).toBe(
        3n * PRICE,
      )
    })
  })

  describe('idle exit (loop wiring)', () => {
    const IDLE = 10 * 60_000
    it('never idle-exits while a draw is unsettled, and resumes paying when funded', async () => {
      const l = shortLedger()
      l.operator = 0n
      const state = await openStore()
      fullRound(state)
      await begin(state)
      const settle = settlerFor(state, l)
      const tick = (nowMs: number, last: number) =>
        raffleTick({
          state,
          openDrawIfFull: () => begin(state),
          settle,
          nowMs,
          lastActivityAtMs: last,
          idleTimeoutMs: IDLE,
        })
      // Held for an hour of quiet: still running.
      let t = await tick(l.clock + 60 * 60_000, l.clock)
      expect(t.exit).toBe(false)
      expect(state.getDraws()).toHaveLength(1)
      // Operator funds the wallet: the next tick pays, and progress counts as activity.
      l.operator = 10n ** 18n
      const later = l.clock + 61 * 60_000
      t = await tick(later, l.clock)
      expect(t.exit).toBe(false)
      expect(t.lastActivityAtMs).toBe(later)
      expect(state.getDraws()).toEqual([])
      // Nothing unsettled and quiet for longer than the timeout: the idle exit applies again.
      expect((await tick(later + IDLE + 1, later)).exit).toBe(true)
      expect((await tick(later + IDLE - 1, later)).exit).toBe(false)
    })
  })

  describe('announcements are decoupled from payouts', () => {
    it("a failing announcement never delays a later round's payout; it retries with backoff, once per recipient", async () => {
      const l = shortLedger()
      const state = await openStore()
      fullRound(state)
      await begin(state)
      let broken = true
      const settle = settlerFor(state, l, {
        onAnnounce: to => {
          if (broken && to === A[0]) throw new Error('relay down')
        },
      })
      const r1 = await settle()
      expect(r1[0].status).toBe('announce-incomplete')
      expect(l.announces.sort()).toEqual([A[1], A[2]].sort())
      // A second round fills and is paid although round 1's announcement is still failing.
      const s = state.getCurrentRound()!
      state.setCurrentRound({
        ...s,
        entrants: A.map((address, i) => ({
          address,
          txHash: '0x' + String(i + 7).repeat(64),
        })),
      })
      await begin(state)
      l.identity += 3n * (PRICE - DUST)
      const r2 = await settle()
      expect(r2.map(r => r.status)).toEqual([
        'announce-incomplete',
        'announce-incomplete',
      ])
      expect(l.mined.size).toBe(2) // both payouts confirmed
      expect(l.signCalls).toBe(2)
      // Backoff: no immediate retry; after the delay and a fix, only the missing recipient is sent.
      const before = l.announces.length
      await settle()
      expect(l.announces.length).toBe(before)
      broken = false
      l.clock += 10 * 60_000
      const r3 = await settle()
      expect(r3.map(r => r.status)).toEqual(['done', 'done'])
      expect(l.announces.filter(a => a === A[0])).toHaveLength(2) // once per round, no resend
      expect(l.announces.filter(a => a === A[1])).toHaveLength(2)
    })
  })

  describe('operator top-up limits', () => {
    const total = (l: FakeLedger) =>
      [...l.balances.values()].reduce((x, y) => x + y, 0n)
    it('per-round cap: hold keeps the draw record (also across a restart) and moves nothing', async () => {
      const l = shortLedger()
      const s1 = await openStore()
      fullRound(s1)
      await begin(s1)
      const r = await settlerFor(s1, l, undefined, 1n)()
      expect(r[0].status).toBe('held')
      expect(l.topUps).toBe(0)
      expect(s1.getDraws()).toHaveLength(1)
      await s1.Close()
      const s2 = await openStore()
      expect(s2.getDraws()).toHaveLength(1)
      expect(s2.getDraws()[0].phase).toBe('awaiting-funds')
      // Raising the limit pays it.
      expect((await settlerFor(s2, l)())[0].status).toBe('done')
      expect(total(l)).toBe(3n * PRICE)
    })

    it('per-day ceiling holds even when the per-round cap allows it', async () => {
      const l = shortLedger()
      const state = await openStore()
      fullRound(state)
      await begin(state)
      await state.recordTopUp(l.clock, 100n)
      const r = await settlerFor(state, l, undefined, CAP, 100n + 1n)()
      expect(r[0].status).toBe('held')
      expect(l.topUps).toBe(0)
      l.clock += 25 * 60 * 60_000 // the ledger only counts the trailing 24h
      expect(
        (await settlerFor(state, l, undefined, CAP, 100n + 1n)())[0].status,
      ).toBe('held') // ceiling still below the need
      expect(
        (await settlerFor(state, l, undefined, CAP, CAP)())[0].status,
      ).toBe('done')
    })

    it('an under-paying entry (gap beyond plausible sweep dust) holds without spending operator money', async () => {
      const l = new FakeLedger()
      l.identity = 3n * (PRICE - DUST) - PRICE // one entry effectively missing
      const state = await openStore()
      fullRound(state)
      await begin(state)
      const r = await settlerFor(state, l, undefined, 10n ** 18n, 10n ** 19n)()
      expect(r[0].status).toBe('held')
      expect(l.topUps).toBe(0)
      expect(l.warns.join('\n')).toMatch(/paid less than the entry price/)
      expect(state.getDraws()).toHaveLength(1)
    })

    it('restart between top-up and signing does not top up twice; the spend is persisted', async () => {
      const l = shortLedger()
      const s1 = await openStore()
      fullRound(s1)
      await begin(s1)
      const boom = {
        onSign: once(() => {
          throw CRASH
        }),
      }
      expect((await settlerFor(s1, l, boom)())[0].status).toBe('held')
      expect(l.topUps).toBe(1)
      const spent = s1.getDraws()[0].topUpWei
      expect(BigInt(spent!)).toBeGreaterThan(0n)
      await s1.Close()
      const s2 = await openStore()
      expect(s2.getDraws()[0].topUpWei).toBe(spent)
      await settlerFor(s2, l)()
      expect(l.topUps).toBe(1)
      expect(total(l)).toBe(3n * PRICE)
    })
  })

  describe('stuck payouts', () => {
    it('reports STUCK at error level but never re-prices a tx the node still knows', async () => {
      const l = shortLedger()
      l.autoMine = false
      const state = await openStore()
      fullRound(state)
      await begin(state)
      const settle = settlerFor(state, l)
      await settle()
      l.clock += 20 * 60_000
      await settle()
      expect(l.errors.join('\n')).toMatch(/STUCK payout 0x[0-9a-f]+/)
      expect(l.signCalls).toBe(1)
      expect(state.getDraws()[0].payout!.previous).toEqual([])
      expect(l.announces).toEqual([])
    })

    it('re-prices at the SAME nonce only when the node does not know the tx; at most one mines', async () => {
      const l = shortLedger()
      l.rejectBroadcast = true // e.g. fee cap below the base fee: never accepted
      const state = await openStore()
      fullRound(state)
      await begin(state)
      const settle = settlerFor(state, l)
      await settle()
      const first = state.getDraws()[0].payout!
      await settle()
      expect(state.getDraws()[0].payout!.txHash).toBe(first.txHash) // too early to re-price
      l.clock += 16 * 60_000
      await settle() // re-priced and persisted (still rejected by the node)
      const repriced = state.getDraws()[0].payout!
      expect(repriced.txHash).not.toBe(first.txHash)
      expect(repriced.previous.map(a => a.txHash)).toEqual([first.txHash])
      expect(repriced.rawTx.split(':')[1]).toBe(first.rawTx.split(':')[1]) // same nonce
      l.rejectBroadcast = false
      await settle() // broadcast and mined, persisted, then broadcast and mined
      expect(l.announces).toHaveLength(3)
      expect(l.minedNonces.size).toBe(1)
      expect(l.mined.has(first.txHash)).toBe(false)
      expect([...l.balances.values()].reduce((x, y) => x + y, 0n)).toBe(
        3n * PRICE,
      )
    })
  })

  describe('plausible-dust threshold (1.3x margin)', () => {
    const plausible = ((3n * DUST + GAS) * 13n) / 10n
    const need = 3n * PRICE + GAS
    it('tops up a gap at the margin and holds one just above it', async () => {
      const ok = new FakeLedger()
      ok.identity = need - plausible
      const s1 = await openStore()
      fullRound(s1)
      await begin(s1)
      expect((await settlerFor(s1, ok)())[0].status).toBe('done')

      const over = new FakeLedger()
      over.identity = need - plausible - 1n
      await s1.Close()
      dir = mkdtempSync(join(tmpdir(), 'raffle-settle-'))
      const s2 = await openStore()
      fullRound(s2)
      await begin(s2)
      expect((await settlerFor(s2, over)())[0].status).toBe('held')
      expect(over.topUps).toBe(0)
    })
  })

  describe('replacement payouts and funds (F1)', () => {
    const exact = () => {
      const l = new FakeLedger()
      l.identity = 3n * PRICE + GAS // exactly pot + the first reserve
      return l
    }
    it('a replacement the node rejects falls back to the earlier attempt; pays once', async () => {
      const l = exact()
      l.rejectBroadcast = true // node does not know the original yet
      const state = await openStore()
      fullRound(state)
      await begin(state)
      const settle = settlerFor(state, l)
      await settle()
      l.clock += 16 * 60_000
      l.rejectBroadcast = false
      l.maxAcceptedFee = 8n // the 2x replacement is rejected (insufficient funds / underpriced)
      await settle()
      expect(l.repriceCalls).toBe(1)
      expect(l.errors.join(' ') + l.warns.join(' ')).toMatch(
        /trying the earlier signed attempt/,
      )
      expect(l.minedNonces.size).toBe(1)
      expect(l.announces).toHaveLength(3)
      expect([...l.balances.values()].reduce((x, y) => x + y, 0n)).toBe(
        3n * PRICE,
      )
    })

    it('a replacement never costs more than the gas held; when none is affordable it tops up within the caps', async () => {
      const l = exact()
      l.rejectBroadcast = true
      const state = await openStore()
      fullRound(state)
      await begin(state)
      const settle = settlerFor(state, l)
      await settle()
      l.clock += 16 * 60_000
      await settle() // 1st replacement: capped to exactly the gas held (2x)
      expect(l.repriceCalls).toBe(1)
      expect(l.topUps).toBe(0)
      l.clock += 16 * 60_000
      await settle() // 2nd: nothing valid is affordable -> operator top-up, then a bigger fee
      expect(l.topUps).toBe(1)
      expect(l.repriceCalls).toBe(2)
      const rec = state.getDraws()[0]
      expect(BigInt(rec.topUpWei!)).toBeGreaterThan(0n)
      l.rejectBroadcast = false
      await settle()
      expect(l.minedNonces.size).toBe(1)
      expect([...l.balances.values()].reduce((x, y) => x + y, 0n)).toBe(
        3n * PRICE,
      )
    })

    it('the top-up for a replacement respects the per-round cap (holds the reprice, keeps broadcasting)', async () => {
      const l = exact()
      l.rejectBroadcast = true
      const state = await openStore()
      fullRound(state)
      await begin(state)
      const settle = settlerFor(state, l, undefined, 1n)
      await settle()
      l.clock += 16 * 60_000
      await settle()
      l.clock += 16 * 60_000
      await settle()
      expect(l.topUps).toBe(0)
      expect(l.repriceCalls).toBe(1)
      l.rejectBroadcast = false
      await settle()
      expect(l.minedNonces.size).toBe(1)
    })

    it('lagging node: original mined but invisible for hours, replacements get "nonce too low": ends paid, one nonce, no fresh nonce', async () => {
      const l = shortLedger()
      l.lag = true
      const state = await openStore()
      fullRound(state)
      await begin(state)
      const settle = settlerFor(state, l)
      await settle() // broadcast; it mines, but nothing is visible
      for (let i = 0; i < 9; i++) {
        l.clock += 20 * 60_000
        await settle() // re-prices (same nonce); broadcasts are "nonce too low"
      }
      expect(l.announces).toEqual([])
      expect(l.signCalls).toBe(1) // never a fresh nonce
      expect(state.getDraws()[0].phase).toBe('signed')
      l.lag = false
      await settle()
      expect(l.minedNonces.size).toBe(1)
      expect(l.signCalls).toBe(1)
      expect(l.announces).toHaveLength(3)
      expect([...l.balances.values()].reduce((x, y) => x + y, 0n)).toBe(
        3n * PRICE,
      )
    })
  })

  describe('operator top-up transaction is recorded before broadcast (F5)', () => {
    it('a restart while the first top-up sits unmined never tops up again', async () => {
      const l = shortLedger()
      l.autoMineTopUp = false
      const s1 = await openStore()
      fullRound(s1)
      await begin(s1)
      expect((await settlerFor(s1, l)())[0].status).toBe('held')
      expect(l.topSigned).toBe(1)
      expect(s1.getDraws()[0].pendingTopUp?.txHash).toBeDefined()
      await s1.Close()
      const s2 = await openStore()
      const settle = settlerFor(s2, l)
      expect((await settle())[0].status).toBe('held') // same bytes re-broadcast, still pending
      expect(l.topSigned).toBe(1)
      expect(l.toppedRaw.size).toBe(1)
      l.mineTopUps()
      expect((await settle())[0].status).toBe('done')
      expect(l.topSigned).toBe(1)
      expect(l.topUps).toBe(1)
      expect([...l.balances.values()].reduce((x, y) => x + y, 0n)).toBe(
        3n * PRICE,
      )
    })
  })

  describe('runRaffleLoop wiring', () => {
    it('keeps looping while a draw is unsettled even past maxRounds and the idle timeout', async () => {
      const l = shortLedger()
      l.operator = 0n
      const state = await openStore()
      fullRound(state)
      await begin(state)
      let iterations = 0
      let exited = false
      const out = await runRaffleLoop({
        state,
        openDrawIfFull: () => begin(state),
        settle: settlerFor(state, l),
        pollOnce: async () => {
          iterations++
          if (iterations === 5) l.operator = 10n ** 18n // owner funds the wallet
        },
        sleep: async () => {
          l.clock += 60 * 60_000 // an hour of quiet per iteration
        },
        now: () => l.clock,
        idleTimeoutMs: 10 * 60_000,
        maxRounds: 0,
        onIdleExit: () => {
          exited = true
        },
      })
      expect(iterations).toBeGreaterThanOrEqual(5)
      expect(state.getDraws()).toEqual([])
      expect(exited).toBe(false) // it ended because nothing was left to do, not by idling
      expect([...l.balances.values()].reduce((x, y) => x + y, 0n)).toBe(
        3n * PRICE,
      )
      expect(out.roundsDrawn).toBe(0)
    })

    it('idle-exits when quiet and nothing is unsettled', async () => {
      const l = shortLedger()
      const state = await openStore()
      let exited = false
      await runRaffleLoop({
        state,
        openDrawIfFull: () => begin(state),
        settle: settlerFor(state, l),
        pollOnce: async () => {},
        sleep: async () => {
          l.clock += 60 * 60_000
        },
        now: () => l.clock,
        idleTimeoutMs: 10 * 60_000,
        maxRounds: 5,
        onIdleExit: () => {
          exited = true
        },
      })
      expect(exited).toBe(true)
    })

    it('resumes a persisted full round on its first tick and counts it', async () => {
      const l = shortLedger()
      const state = await openStore()
      fullRound(state) // never drawn: e.g. a crash before the draw was recorded
      const out = await runRaffleLoop({
        state,
        openDrawIfFull: () => begin(state),
        settle: settlerFor(state, l),
        pollOnce: async () => {},
        sleep: async () => {
          l.clock += 60 * 60_000
        },
        now: () => l.clock,
        idleTimeoutMs: 10 * 60_000,
        maxRounds: 1,
      })
      expect(out.roundsDrawn).toBe(1)
      expect(l.announces).toHaveLength(3)
    })
  })

  it('draw and payout records are written with fsync', async () => {
    const l = shortLedger()
    const state = await openStore()
    const db = (state as any).db
    const put = jest.spyOn(db, 'put')
    fullRound(state)
    await state.flush()
    put.mockClear()
    await begin(state)
    await settlerFor(state, l)()
    const syncOf = (call: unknown[]) => (call[2] as any)?.sync === true
    const draws = put.mock.calls.filter(
      c => String(c[0]).startsWith('draw:') || c[0] === '__topup_ledger__',
    )
    expect(draws.length).toBeGreaterThan(3)
    expect(draws.every(syncOf)).toBe(true)
  })

  it('restart resume: entrants and commitment are stable across a reopen', async () => {
    const s1 = await openStore()
    const round = fullRound(s1)
    const before = s1.getPendingCommitment()
    await s1.Close()
    const s2 = await openStore()
    expect(s2.getCurrentRound()).toEqual({
      ...round,
      entrants: round.entrants.map(e => ({ ...e, address: e.address })),
    })
    expect(s2.getPendingCommitment()).toEqual(before)
  })
})

describe('#363 end to end on the fake chain (real signers, zero-balance raffle identity)', () => {
  it('a 3-entrant round pays the winner the full pot and the settler survives', async () => {
    const operator = Wallet.createRandom()
    const identityWallet = Wallet.createRandom()
    const fake = await startFakeRpc({ port: 0, funded: [operator.address] })
    try {
      const provider = new JsonRpcProvider(fake.url, undefined, {
        staticNetwork: true,
        cacheTimeout: -1,
      } as any)
      const httpClient = new MonadHttpClient({ rpcUrl: fake.url })
      const opSigner = new MonadAccountTxSigner({
        privateKey: operator.privateKey,
        provider,
        httpClient,
      })
      const idSigner = new MonadAccountTxSigner({
        privateKey: identityWallet.privateKey,
        provider,
        httpClient,
      })
      // Entries arrive net of sweep gas: the identity starts short of the pot.
      const sweep = await opSigner.buildAndSignTransfer(
        identityWallet.address,
        3n * (PRICE - DUST),
      )
      await opSigner.submit(sweep)

      const entrants = [
        Wallet.createRandom().address,
        Wallet.createRandom().address,
        Wallet.createRandom().address,
      ]
      const state = new RaffleBotStateStore(dir)
      await state.Open()
      stores.push(state)
      const serverSeed = 'ab'.repeat(32)
      state.setPendingCommitment(serverSeed, sha256Hex(serverSeed))
      state.setCurrentRound({
        raffleId: 'e2e',
        entryPriceWei: PRICE.toString(),
        maxEntries: 3,
        serverSeedHash: sha256Hex(serverSeed),
        entrants: entrants.map((address, i) => ({
          address,
          txHash: '0x' + String(i + 1).repeat(64),
        })),
      })
      await begin(state)
      const winner = (state.getDraws()[0].drawItem as any)
        .winnerAddress as string
      const announced: string[] = []
      const winnerBalanceAtAnnounce: bigint[] = []
      const settle = createRaffleSettler({
        state,
        maxTopUpPerRoundWei: CAP,
        maxTopUpPerDayWei: CAP * 5n,
        ports: {
          getBalanceWei: () =>
            provider.getBalance(identityWallet.address, 'latest'),
          operatorBalanceWei: () =>
            provider.getBalance(operator.address, 'latest'),
          sweepDustWei: async () => DUST,
          isTxKnown: async () => true,
          repricePayout: async () => {
            throw new Error('not used')
          },
          error: m => process.stderr.write(m + '\n'),
          payoutGasReserveWei: async () => 60_000n * 50n * 10n ** 9n * 2n,
          signTopUp: async amount => {
            const tx = await opSigner.buildAndSignTransfer(
              identityWallet.address,
              amount,
            )
            return { rawTx: tx.rawTx, txHash: tx.txHash }
          },
          broadcastTopUp: async (raw, hash) => {
            await opSigner.submitRaw(raw, hash)
          },
          getTopUpStatus: h => opSigner.getStatus(h),
          signPayout: async (to, value) => {
            const t = await idSigner.buildAndSignTransfer(to, value)
            return { rawTx: t.rawTx, txHash: t.txHash }
          },
          broadcast: async (raw, hash) => {
            await idSigner.submitRaw(raw, hash)
          },
          getStatus: h => idSigner.getStatus(h),
          announce: async (to: string, _d: RaffleItem) => {
            announced.push(to)
            winnerBalanceAtAnnounce.push(await provider.getBalance(winner))
          },
          log: () => {},
          warn: m => process.stderr.write(m + '\n'),
        },
      })
      // The RPC client caches receipts briefly, so the first pass may report the just-broadcast tx
      // as pending; the next tick reconciles by hash.
      let status = (await settle())[0].status
      for (let i = 0; i < 5 && status !== 'done'; i++) {
        expect(announced).toEqual([]) // never announced before the payout is confirmed
        await new Promise(r => setTimeout(r, 300))
        status = (await settle())[0].status
      }
      expect(status).toBe('done')
      expect(await provider.getBalance(winner)).toBe(3n * PRICE)
      expect(announced).toHaveLength(3)
      expect(winnerBalanceAtAnnounce.every(b => b === 3n * PRICE)).toBe(true)
      // Only the operator top-up and the single payout ever left the identity.
      expect(
        fake
          .transactions()
          .filter(
            t => t.from.toLowerCase() === identityWallet.address.toLowerCase(),
          ),
      ).toHaveLength(1)
    } finally {
      await fake.close()
    }
  })
})

describe("repriceSignedPayout (the bot's real replacement signing)", () => {
  const wallet = Wallet.createRandom()
  const to = '0x' + '77'.repeat(20)
  const FEE = 50n * 10n ** 9n
  async function prev(nonce = 7) {
    return wallet.signTransaction({
      type: 2,
      chainId: 10143,
      nonce,
      to,
      value: 123n,
      gasLimit: 21000n,
      maxFeePerGas: FEE,
      maxPriorityFeePerGas: 2n * 10n ** 9n,
    })
  }
  const signer = async (t: string, v: bigint, o: any) => {
    const raw = await wallet.signTransaction({
      type: 2,
      chainId: 10143,
      to: t,
      value: v,
      ...o,
    })
    return { rawTx: raw, txHash: Transaction.from(raw).hash as string }
  }

  it('keeps nonce, recipient, value and gas limit and raises the fee', async () => {
    const p = await prev()
    const out = await repriceSignedPayout({
      previousRawTx: p,
      gasBudgetWei: 10n ** 18n,
      sign: signer,
    })
    const a = Transaction.from(p)
    const b = Transaction.from(out!.rawTx)
    expect(b.nonce).toBe(a.nonce)
    expect(b.to).toBe(a.to)
    expect(b.value).toBe(a.value)
    expect(b.gasLimit).toBe(a.gasLimit)
    expect(b.maxFeePerGas).toBe(FEE * 2n)
    expect(b.maxPriorityFeePerGas! > a.maxPriorityFeePerGas!).toBe(true)
    expect(b.hash).not.toBe(a.hash)
  })

  it('never costs more than the gas budget, and refuses when no valid bump fits', async () => {
    const p = await prev()
    const budget = (21000n * (FEE * 3n)) / 2n // 1.5x
    const out = await repriceSignedPayout({
      previousRawTx: p,
      gasBudgetWei: budget,
      sign: signer,
    })
    const b = Transaction.from(out!.rawTx)
    expect(b.gasLimit * b.maxFeePerGas!).toBeLessThanOrEqual(budget)
    expect(b.maxFeePerGas! > FEE).toBe(true)
    expect(
      await repriceSignedPayout({
        previousRawTx: p,
        gasBudgetWei: 21000n * FEE,
        sign: signer,
      }),
    ).toBeUndefined()
  })
})
