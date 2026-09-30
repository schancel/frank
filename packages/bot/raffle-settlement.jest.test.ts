import { createHash, randomBytes } from 'crypto'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import { Wallet } from 'ethers'

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
  RaffleSettlementPorts,
} from './raffle-settlement'
import { sha256Hex } from '@frank/wallet/message-item-plugins/raffle/draw'

const PRICE = 20_000_000_000_000_000n // 0.02 MON
const DUST = 1_848_000_000_000_000n // sweep gas taken from each entry (matches #363's numbers)
const GAS = 1_000_000_000_000_000n
const CAP = 50_000_000_000_000_000n
const A = ['0x' + 'a1'.repeat(20), '0x' + 'a2'.repeat(20), '0x' + 'a3'.repeat(20)]

/** In-memory chain double: identity + operator balances, a mempool and explicit mining. */
class FakeLedger {
  identity = 0n
  operator = 10n ** 18n
  balances = new Map<string, bigint>()
  nonce = 0
  mempool = new Map<string, { to: string; value: bigint }>()
  mined = new Set<string>()
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
      this.mined.add(hash)
      this.identity -= tx.value + GAS / 2n
      this.balances.set(tx.to, (this.balances.get(tx.to) ?? 0n) + tx.value)
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

function makePorts(l: FakeLedger, hooks: Hooks = {}, winner?: () => string): RaffleSettlementPorts {
  return {
    getBalanceWei: async () => l.identity,
    payoutGasReserveWei: async () => GAS,
    topUpIdentity: async shortfall => {
      hooks.onTopUp?.()
      if (l.operator < shortfall) throw new Error('operator wallet is empty')
      l.operator -= shortfall
      l.identity += shortfall
      l.topUps++
    },
    signPayout: async (to, value) => {
      hooks.onSign?.()
      l.signCalls++
      const nonce = l.nonce++
      const rawTx = `raw:${nonce}:${to}:${value}`
      const txHash = '0x' + createHash('sha256').update(rawTx).digest('hex')
      l.mempool.set(txHash, { to, value }) // signed locally; only visible once broadcast
      l.mempool.delete(txHash)
      ;(l as any)[txHash] = { to, value }
      return { rawTx, txHash }
    },
    broadcast: async (rawTx, txHash) => {
      hooks.onBroadcast?.()
      l.broadcastCalls++
      const [, , to, value] = rawTx.split(':')
      l.mempool.set(txHash, { to, value: BigInt(value) })
      if (l.autoMine) l.mine()
    },
    getStatus: async txHash => {
      hooks.onStatus?.()
      if (l.reverted.has(txHash)) return 'failed'
      return l.mined.has(txHash) ? 'confirmed' : 'pending'
    },
    announce: async (to, draw) => {
      hooks.onAnnounce?.(to)
      l.announcedAfterPay.push(l.paid((draw as any).winnerAddress) >= BigInt((draw as any).potWei))
      l.announces.push(to)
    },
    log: () => {},
    warn: () => {},
  }
}

let dir: string
let stores: RaffleBotStateStore[]
async function openStore(cls: typeof RaffleBotStateStore = RaffleBotStateStore) {
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
    entrants: A.map((address, i) => ({ address, txHash: '0x' + String(i + 1).repeat(64) })),
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
const settlerFor = (state: RaffleBotStateStore, l: FakeLedger, hooks?: Hooks, cap = CAP) =>
  createRaffleSettler({ state, ports: makePorts(l, hooks), maxTopUpWei: cap })

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
    expect(state.getPendingCommitment()!.serverSeedHash).not.toBe(oldSeed.serverSeedHash)
    expect(state.getCurrentRound()!.entrants).toEqual([])
    expect(state.getCurrentRound()!.serverSeedHash).toBe(state.getPendingCommitment()!.serverSeedHash)
    expect(verifyRaffleDraw({ ...(draw.drawItem as any), raffleId: round.raffleId }).valid).toBe(true)
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
      expect([...l.balances.values()].reduce((x, y) => x + y, 0n)).toBe(3n * PRICE)
    })

    it('after persist, before signing (top-up crashes): resumes, paid once', async () => {
      const l = shortLedger()
      const s1 = await openStore()
      fullRound(s1)
      await begin(s1)
      const r = await settlerFor(s1, l, { onTopUp: () => { throw CRASH } })()
      expect(r[0].status).toBe('held')
      expect(l.announces).toEqual([])
      const s2 = await restart(s1)
      await settlerFor(s2, l)()
      expect([...l.balances.values()].reduce((x, y) => x + y, 0n)).toBe(3n * PRICE)
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
      expect([...l.balances.values()].reduce((x, y) => x + y, 0n)).toBe(3n * PRICE)
    })

    it('after persist, broadcast fails: same bytes retried, one payment', async () => {
      const l = shortLedger()
      l.autoMine = false
      const s1 = await openStore()
      fullRound(s1)
      await begin(s1)
      await settlerFor(s1, l, { onBroadcast: once(() => { throw CRASH }) })()
      expect(s1.getDraws()[0].phase).toBe('signed')
      const bytes = s1.getDraws()[0].payout
      const s2 = await restart(s1)
      const settle = settlerFor(s2, l)
      expect((await settle())[0].status).toBe('pending') // broadcast, not yet mined
      expect(s2.getDraws()[0].payout).toEqual(bytes)
      l.mine()
      expect((await settle())[0].status).toBe('done')
      expect(l.signCalls).toBe(1)
      expect([...l.balances.values()].reduce((x, y) => x + y, 0n)).toBe(3n * PRICE)
    })

    it('after broadcast, before reconcile: reconciles by hash, never re-signs, no announce before pay', async () => {
      const l = shortLedger()
      l.autoMine = false
      const s1 = await openStore()
      fullRound(s1)
      await begin(s1)
      // Broadcast succeeds, then the process dies at the status read.
      const hook = { onStatus: () => { if (l.broadcastCalls > 0 && !hook.done) { hook.done = true; throw CRASH } }, done: false }
      await settlerFor(s1, l, hook)()
      expect(l.broadcastCalls).toBe(1)
      expect(l.announces).toEqual([])
      l.mine() // it mined while we were down
      const s2 = await restart(s1)
      await settlerFor(s2, l)()
      expect(l.signCalls).toBe(1)
      expect(l.broadcastCalls).toBe(1) // confirmed by hash: not even re-broadcast
      expect([...l.balances.values()].reduce((x, y) => x + y, 0n)).toBe(3n * PRICE)
      expect(l.announces).toHaveLength(3)
    })

    it('after reconcile, before/while announcing: no second payout, each entrant told once', async () => {
      const l = shortLedger()
      const s1 = await openStore()
      fullRound(s1)
      await begin(s1)
      let n = 0
      const r = await settlerFor(s1, l, { onAnnounce: () => { if (++n === 2) throw CRASH } })()
      expect(r[0].status).toBe('announce-incomplete')
      expect(s1.getDraws()[0].phase).toBe('paid')
      expect(l.announces).toHaveLength(1)
      const s2 = await restart(s1)
      await settlerFor(s2, l)()
      expect(l.signCalls).toBe(1)
      expect(l.announces.sort()).toEqual([...A].sort())
      expect([...l.balances.values()].reduce((x, y) => x + y, 0n)).toBe(3n * PRICE)
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
      for (let i = 0; i < 3; i++) expect((await settle())[0].status).toBe('held')
      expect(l.announces).toEqual([])
      expect(l.signCalls).toBe(0)
      expect(l.refundTxs).toBe(0)
      expect(l.balances.size).toBe(0)
      // The next round is open and accepting entrants while the pot is held.
      expect(state.getCurrentRound()!.entrants).toEqual([])
      expect(state.getDraws()).toHaveLength(1)
      l.operator = 10n ** 18n
      expect((await settle())[0].status).toBe('done')
      expect([...l.balances.values()].reduce((x, y) => x + y, 0n)).toBe(3n * PRICE)
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
      state.setCurrentRound({ ...state.getCurrentRound()!, entrants: A.map((address, i) => ({ address, txHash: '0x' + String(i + 4).repeat(64) })) })
      expect(c.serverSeedHash).toBe(state.getCurrentRound()!.serverSeedHash)
      await begin(state)
      expect(state.getDraws()).toHaveLength(2)
      const settle = settlerFor(state, l)
      expect((await settle()).length).toBe(1) // the second draw is not even attempted
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
      for (let i = 0; i < 4; i++) expect((await settle())[0].status).toBe('pending')
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
      expect([...l.balances.values()].reduce((x, y) => x + y, 0n)).toBe(3n * PRICE)
    })
  })

  it('restart resume: entrants and commitment are stable across a reopen', async () => {
    const s1 = await openStore()
    const round = fullRound(s1)
    const before = s1.getPendingCommitment()
    await s1.Close()
    const s2 = await openStore()
    expect(s2.getCurrentRound()).toEqual({ ...round, entrants: round.entrants.map(e => ({ ...e, address: e.address })) })
    expect(s2.getPendingCommitment()).toEqual(before)
  })
})

describe('#363 end to end on the fake chain (real signers, zero-balance raffle identity)', () => {
  it('a 3-entrant round pays the winner the full pot and the settler survives', async () => {
    const operator = Wallet.createRandom()
    const identityWallet = Wallet.createRandom()
    const fake = await startFakeRpc({ port: 0, funded: [operator.address] })
    try {
      const provider = new JsonRpcProvider(fake.url, undefined, { staticNetwork: true, cacheTimeout: -1 } as any)
      const httpClient = new MonadHttpClient({ rpcUrl: fake.url })
      const opSigner = new MonadAccountTxSigner({ privateKey: operator.privateKey, provider, httpClient })
      const idSigner = new MonadAccountTxSigner({ privateKey: identityWallet.privateKey, provider, httpClient })
      // Entries arrive net of sweep gas: the identity starts short of the pot.
      const sweep = await opSigner.buildAndSignTransfer(identityWallet.address, 3n * (PRICE - DUST))
      await opSigner.submit(sweep)

      const entrants = [Wallet.createRandom().address, Wallet.createRandom().address, Wallet.createRandom().address]
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
        entrants: entrants.map((address, i) => ({ address, txHash: '0x' + String(i + 1).repeat(64) })),
      })
      await begin(state)
      const winner = (state.getDraws()[0].drawItem as any).winnerAddress as string
      const announced: string[] = []
      const winnerBalanceAtAnnounce: bigint[] = []
      const settle = createRaffleSettler({
        state,
        maxTopUpWei: CAP,
        ports: {
          getBalanceWei: () => provider.getBalance(identityWallet.address, 'latest'),
          payoutGasReserveWei: async () => 60_000n * 50n * 10n ** 9n * 2n,
          topUpIdentity: async shortfall => {
            const tx = await opSigner.buildAndSignTransfer(identityWallet.address, shortfall)
            await opSigner.submit(tx)
          },
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
      expect(fake.transactions().filter(t => t.from.toLowerCase() === identityWallet.address.toLowerCase())).toHaveLength(1)
    } finally {
      await fake.close()
    }
  })
})
