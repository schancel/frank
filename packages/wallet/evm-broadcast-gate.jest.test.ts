/**
 * The per-coin wait that puts each account's transactions on the node in nonce order
 * (`EvmBroadcastGate`): a transaction is handed over once the one below it in its account is
 * sent. Exact hand-over sequences for each way a set arises: a bundle whose payment holds the
 * lower or the higher nonce, payments of several messages stacked on one account, an abandoned
 * nonce taken by a filler, a successor whose hand-over completes only after its predecessor's,
 * and the resume after a restart. No chain: whether a node keeps or refuses a gapped
 * transaction is a property of the node, checked on the real network.
 */
import { Transaction, Wallet } from 'ethers'
import { EvmBroadcastGate, PredecessorNotSentError } from './evm-broadcast-gate'

const key = (n: number) => '0x' + n.toString(16).padStart(64, '0')
const main = new Wallet(key(11))
const other = new Wallet(key(12))
const recipient = new Wallet(key(13)).address
const fresh = new Wallet(key(14)).address

/** A signed transfer; the value tells transfers apart in a sequence. */
async function tx(from: Wallet, nonce: number, to: string, value: bigint) {
  return from.signTransaction(
    Transaction.from({
      type: 2,
      chainId: 10143n,
      nonce,
      to,
      value,
      gasLimit: 21_000n,
      maxFeePerGas: 3n,
      maxPriorityFeePerGas: 1n,
    }),
  )
}
const describeTx = (raw: string) => {
  const t = Transaction.from(raw)
  return `${t.from === main.address ? 'main' : 'other'}:${t.nonce}:${t.value}`
}

/** A node that records what it is handed, each hand-over taking `delayMs` (per nonce). */
function node(delayMs: (raw: string) => number = () => 0) {
  const handed: string[] = []
  const send = async (raw: string) => {
    await new Promise(resolve => setTimeout(resolve, delayMs(raw)))
    handed.push(describeTx(raw))
  }
  return { handed, send }
}

/** Settled below `from` per account: what the coin list knows is mined. */
const minedBelow =
  (from: Record<string, number>) => (account: string, nonce: number) =>
    nonce < (from[account] ?? 0)
const MAIN = main.address.toLowerCase()
const OTHER = other.address.toLowerCase()

describe('EvmBroadcastGate', () => {
  it('a bundle whose self-send holds the lower nonce: the self-send goes first, then the payment', async () => {
    const gate = new EvmBroadcastGate(minedBelow({ [MAIN]: 4 }))
    const n = node()
    const payment = await tx(main, 5, recipient, 100n)
    const selfSend = await tx(main, 4, fresh, 7n)
    await gate.submit([payment, selfSend], n.send)
    expect(n.handed).toEqual(['main:4:7', 'main:5:100'])
  })

  it('a bundle whose payment holds the lower nonce: the payment first, then the self-sends', async () => {
    const gate = new EvmBroadcastGate(minedBelow({ [MAIN]: 4 }))
    const n = node()
    const payment = await tx(main, 4, recipient, 100n)
    const selfSends = [await tx(main, 6, fresh, 9n), await tx(main, 5, fresh, 7n)]
    await gate.submit([...selfSends, payment], n.send)
    expect(n.handed).toEqual(['main:4:100', 'main:5:7', 'main:6:9'])
  })

  it('a successor whose hand-over is quick still completes only after its slow predecessor; another account is not held', async () => {
    const gate = new EvmBroadcastGate(minedBelow({ [MAIN]: 0, [OTHER]: 7 }))
    // The lower nonce takes 50 ms to hand over; the one above and the other account's, none.
    const n = node(raw => (Transaction.from(raw).nonce === 0 ? 50 : 0))
    const first = await tx(main, 0, recipient, 1n)
    const second = await tx(main, 1, recipient, 2n)
    const elsewhere = await tx(other, 7, recipient, 4n)
    await gate.submit([second, elsewhere, first], n.send)
    expect(n.handed).toEqual(['other:7:4', 'main:0:1', 'main:1:2'])
  })

  it('payments of several messages stacked on one account, each submitted by its own message, delivered out of order: the later one waits for the earlier', async () => {
    const gate = new EvmBroadcastGate(minedBelow({ [MAIN]: 0 }))
    const n = node()
    const first = await tx(main, 0, recipient, 1n)
    const second = await tx(main, 1, recipient, 2n)
    const third = await tx(main, 2, recipient, 3n)
    // The third message's answer came first, then the second's: both wait.
    expect(await gate.submit([third], n.send)).toEqual([{ rawTx: third, waiting: true }])
    expect(await gate.submit([second], n.send)).toEqual([{ rawTx: second, waiting: true }])
    expect(n.handed).toEqual([])
    await gate.submit([first], n.send)
    await new Promise(resolve => setTimeout(resolve, 30))
    expect(n.handed).toEqual(['main:0:1', 'main:1:2', 'main:2:3'])
  })

  it('the earlier message\'s payment seen in the mempool (the relay broadcast it) lets the later one go', async () => {
    const gate = new EvmBroadcastGate(minedBelow({ [MAIN]: 0 }))
    const n = node()
    const second = await tx(main, 1, recipient, 2n)
    await gate.submit([second], n.send)
    expect(n.handed).toEqual([])
    gate.markSent(MAIN, 0)
    await new Promise(resolve => setTimeout(resolve, 30))
    expect(n.handed).toEqual(['main:1:2'])
  })

  it('an abandoned nonce taken by a filler: the payment above waits until the filler is out', async () => {
    const gate = new EvmBroadcastGate(minedBelow({ [MAIN]: 2 }))
    const n = node()
    const above = await tx(main, 3, recipient, 50n)
    await gate.submit([above], n.send)
    expect(n.handed).toEqual([])
    const filler = await tx(main, 2, main.address, 1n)
    await gate.submit([filler], n.send)
    await new Promise(resolve => setTimeout(resolve, 30))
    expect(n.handed).toEqual(['main:2:1', 'main:3:50'])
  })

  it('a predecessor the node refuses in the same set stops the one above it; a later set offers both', async () => {
    const gate = new EvmBroadcastGate(minedBelow({ [MAIN]: 0 }))
    const handed: string[] = []
    let down = true
    const send = async (raw: string) => {
      if (down) throw new Error('node unreachable')
      handed.push(describeTx(raw))
    }
    const a = await tx(main, 0, recipient, 1n)
    const b = await tx(main, 1, recipient, 2n)
    const results = await gate.submit([a, b], send)
    expect(results[1].error).toBeInstanceOf(PredecessorNotSentError)
    expect(handed).toEqual([])
    down = false
    await gate.submit([b, a], send)
    expect(handed).toEqual(['main:0:1', 'main:1:2'])
  })

  it('the resume after a restart: what the list shows mined needs no wait, the rest goes per account in nonce order, a repeated transaction once', async () => {
    // A fresh gate: nothing in memory, only what the coin list says (main mined below 10).
    const gate = new EvmBroadcastGate(minedBelow({ [MAIN]: 10, [OTHER]: 0 }))
    const n = node()
    const a = await tx(main, 10, recipient, 1n)
    const selfOfB = await tx(main, 11, fresh, 5n)
    const b = await tx(main, 12, recipient, 2n)
    const c = await tx(other, 0, recipient, 3n)
    await gate.submit([b, c, a, selfOfB, b], n.send)
    expect(n.handed.filter(entry => entry.startsWith('main'))).toEqual([
      'main:10:1',
      'main:11:5',
      'main:12:2',
    ])
    expect(n.handed).toHaveLength(4)
  })
})
