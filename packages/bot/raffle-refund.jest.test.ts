import { createHash } from 'crypto'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import { RaffleBotStateStore, RaffleUnclaimedRecord } from './raffle-bot-state'
import { RaffleRefundPorts, refundUnclaimed } from './raffle-refund'

const ENTRANT = '0x' + 'e1'.repeat(20)
const REC: RaffleUnclaimedRecord = {
  id: `${ENTRANT}:abc`,
  entrant: ENTRANT,
  paymentHashes: ['0x1', '0x2', '0x3', '0x4', '0x5', '0x6', '0x7'],
  sweptWei: '21000',
  reason: 'over the cap',
  atMs: 1,
}

class Chain {
  identity = 100_000n
  refunded = new Map<string, bigint>()
  mined = new Set<string>()
  nonce = 0
  signs = 0
  broadcasts = 0
  autoMine = true
  failNextBroadcast = false
  ports(): RaffleRefundPorts {
    return {
      getBalanceWei: async () => this.identity,
      signTransfer: async (to, value) => {
        this.signs++
        const rawTx = `raw:${this.nonce++}:${to}:${value}`
        return {
          rawTx,
          txHash: '0x' + createHash('sha256').update(rawTx).digest('hex'),
        }
      },
      broadcast: async (rawTx, txHash) => {
        this.broadcasts++
        if (this.failNextBroadcast) {
          this.failNextBroadcast = false
          throw new Error('rpc down')
        }
        if (this.autoMine) this.mine(rawTx, txHash)
      },
      getStatus: async h => (this.mined.has(h) ? 'confirmed' : 'pending'),
    }
  }
  mine(rawTx: string, txHash: string) {
    if (this.mined.has(txHash)) return
    const [, , to, value] = rawTx.split(':')
    this.mined.add(txHash)
    this.identity -= BigInt(value)
    this.refunded.set(to, (this.refunded.get(to) ?? 0n) + BigInt(value))
  }
}

let dir: string
let stores: RaffleBotStateStore[]
const open = async () => {
  const s = new RaffleBotStateStore(dir)
  await s.Open()
  stores.push(s)
  return s
}
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'raffle-refund-'))
  stores = []
})
afterEach(async () => {
  for (const s of stores) await s.Close().catch(() => {})
  rmSync(dir, { recursive: true, force: true })
})

describe('unclaimed records and the operator refund (#363)', () => {
  it('persists an unclaimed record across a restart', async () => {
    const s1 = await open()
    await s1.putUnclaimed(REC)
    await s1.Close()
    const s2 = await open()
    expect(s2.getUnclaimed()).toEqual([REC])
  })

  it('refunds the recorded swept amount once, and a second run never pays again', async () => {
    const c = new Chain()
    const state = await open()
    await state.putUnclaimed(REC)
    const out = await refundUnclaimed({ state, ports: c.ports(), id: REC.id })
    expect(out.status).toBe('refunded')
    expect(c.refunded.get(ENTRANT)).toBe(21000n)
    const again = await refundUnclaimed({ state, ports: c.ports(), id: REC.id })
    expect(again.status).toBe('already-refunded')
    expect(c.signs).toBe(1)
    expect(c.refunded.get(ENTRANT)).toBe(21000n)
  })

  it('restart between recording the signed refund and broadcasting: same bytes, one payment', async () => {
    const c = new Chain()
    c.failNextBroadcast = true // dies right after the signed bytes were persisted
    const s1 = await open()
    await s1.putUnclaimed(REC)
    const first = await refundUnclaimed({
      state: s1,
      ports: c.ports(),
      id: REC.id,
    })
    expect(first.status).toBe('pending')
    const bytes = s1.getUnclaimed()[0].refund
    expect(bytes).toBeDefined()
    await s1.Close()
    const s2 = await open()
    expect(s2.getUnclaimed()[0].refund).toEqual(bytes)
    const second = await refundUnclaimed({
      state: s2,
      ports: c.ports(),
      id: REC.id,
    })
    expect(second.status).toBe('refunded')
    expect(c.signs).toBe(1)
    expect(c.refunded.get(ENTRANT)).toBe(21000n)
  })

  it('a broadcast that mined while the process was down is reconciled by hash without re-broadcast', async () => {
    const c = new Chain()
    c.autoMine = false
    const s1 = await open()
    await s1.putUnclaimed(REC)
    expect(
      (await refundUnclaimed({ state: s1, ports: c.ports(), id: REC.id }))
        .status,
    ).toBe('pending')
    const { rawTx, txHash } = s1.getUnclaimed()[0].refund!
    c.mine(rawTx, txHash)
    const before = c.broadcasts
    expect(
      (await refundUnclaimed({ state: s1, ports: c.ports(), id: REC.id }))
        .status,
    ).toBe('refunded')
    expect(c.broadcasts).toBe(before)
    expect(c.signs).toBe(1)
    expect(c.refunded.get(ENTRANT)).toBe(21000n)
  })

  it('is refused while a draw is unsettled or the identity is short, and for an unknown id', async () => {
    const c = new Chain()
    const state = await open()
    await state.putUnclaimed(REC)
    c.identity = 10n
    expect(
      (await refundUnclaimed({ state, ports: c.ports(), id: REC.id })).status,
    ).toBe('refused')
    expect(
      (await refundUnclaimed({ state, ports: c.ports(), id: 'nope' })).status,
    ).toBe('refused')
    expect(c.signs).toBe(0)
    // An unsettled draw blocks it (shared nonce/balance with payouts, #218).
    c.identity = 100_000n
    await state.putDraw({
      seq: 1,
      raffleId: 'r',
      drawItem: {} as never,
      phase: 'awaiting-funds',
      announcedTo: [],
    })
    expect(
      (await refundUnclaimed({ state, ports: c.ports(), id: REC.id })).status,
    ).toBe('refused')
    expect(c.signs).toBe(0)
  })
})
