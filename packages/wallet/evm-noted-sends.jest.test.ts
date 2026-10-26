import { Wallet, parseEther } from 'ethers'
import {
  EvmNotedSends,
  notedSendGroupKeys,
  type NotedSend,
} from './evm-noted-sends'
import { MemoryRecordStore } from './storage/evm-coin-store'

const CHAIN_ID = 20143n
const BURN = '0x000000000000000000000000000000000000dEaD'
const signer = Wallet.createRandom()

async function signed(to: string, value: bigint, nonce: number, chainId = CHAIN_ID) {
  return signer.signTransaction({
    type: 2,
    chainId,
    nonce,
    to,
    value,
    gasLimit: 21_000n,
    maxFeePerGas: 1n,
    maxPriorityFeePerGas: 1n,
  })
}

describe('EvmNotedSends', () => {
  it("names what each of a note's transactions was for, once, whatever note reports it", async () => {
    const store = new MemoryRecordStore<NotedSend>()
    const noted = new EvmNotedSends(store, { chainId: CHAIN_ID, burnAddress: BURN })
    const stamp = await signed('0x' + '11'.repeat(20), parseEther('0.03'), 0)
    const payment = await signed('0x' + '22'.repeat(20), parseEther('0.5'), 1)
    const burn = await signed(BURN, parseEther('0.01'), 2)
    const transfer = await signed('0x' + '33'.repeat(20), parseEther('1'), 3)
    const foreign = await signed('0x' + '44'.repeat(20), 1n, 4, 10143n)
    const { Transaction } = await import('ethers')
    const hashOf = (raw: string) => Transaction.from(raw).hash!.toLowerCase()

    await noted.recordNote({
      transactions: [stamp, payment, burn, foreign].map(rawTx => ({ rawTx })),
      itemTransactions: new Set([hashOf(payment)]),
      message: { digest: 'aa' },
      notedAtMs: 2000,
    })
    await noted.recordNote({
      transactions: [{ rawTx: transfer, txHash: hashOf(transfer) }],
      itemTransactions: new Set(),
      notedAtMs: 3000,
    })
    // The same bytes again, from a later read of the mailbox: nothing changes.
    await noted.recordNote({
      transactions: [{ rawTx: stamp }],
      itemTransactions: new Set(),
      message: { digest: 'aa' },
      notedAtMs: 9000,
    })
    // A note whose hash does not match its bytes is not taken.
    await noted.recordNote({
      transactions: [{ rawTx: transfer, txHash: '0x' + '00'.repeat(32) }],
      itemTransactions: new Set(),
      notedAtMs: 1,
    })

    const byHash = new Map(noted.all().map(row => [row.txHash, row]))
    expect(byHash.size).toBe(4)
    expect(byHash.has(hashOf(foreign))).toBe(false)
    expect(byHash.get(hashOf(stamp))).toMatchObject({
      purpose: 'stamp',
      valueWei: parseEther('0.03').toString(),
      message: { digest: 'aa', item: false },
      noteIndex: 0,
      notedAtMs: 2000,
      from: signer.address.toLowerCase(),
      nonce: 0,
    })
    expect(byHash.get(hashOf(payment))?.purpose).toBe('contact-payment')
    expect(byHash.get(hashOf(burn))?.purpose).toBe('forum')
    expect(byHash.get(hashOf(transfer))).toMatchObject({
      purpose: 'transfer',
      to: '0x' + '33'.repeat(20),
      notedAtMs: 3000,
    })
  })

  it('names and groups one send the same way whatever notes report it and in whatever order', async () => {
    const { Transaction } = await import('ethers')
    const hashOf = (raw: string) => Transaction.from(raw).hash!.toLowerCase()
    const messageId = '0123456789abcdef0123456789abcdef'
    const recipient = '0x' + '55'.repeat(20)
    // An in-chat payment from three coins, and its message's stamp appended as a stage.
    const payments = await Promise.all(
      [0, 1, 2].map(nonce => signed(recipient, parseEther('0.3'), nonce)),
    )
    const stamps = await Promise.all(
      [3, 4].map(nonce => signed('0x' + '66'.repeat(20), parseEther('0.025'), nonce)),
    )
    const groupWrite = await signer.signTransaction({
      type: 2,
      chainId: CHAIN_ID,
      nonce: 5,
      to: BURN,
      value: 1_000_000_000_000n,
      data: '0x4752505701' + '00'.repeat(32),
      gasLimit: 50_000n,
      maxFeePerGas: 1n,
      maxPriorityFeePerGas: 1n,
    })
    const operation = { id: 'evm-transaction-set:stealth-' + 'ab'.repeat(32) }
    const memberNotes = [
      ...payments.map(rawTx => ({ transactions: [{ rawTx, operation }] })),
      ...stamps.map(rawTx => ({
        transactions: [{ rawTx, operation: { ...operation, stage: `stamp-${messageId}` } }],
      })),
      { transactions: [{ rawTx: groupWrite }] },
    ]
    const messageNote = {
      transactions: stamps.map(rawTx => ({ rawTx })),
      itemTransactions: new Set(payments.map(hashOf)),
      message: { digest: 'dd', messageId },
    }
    const read = async (order: 'members-first' | 'message-first') => {
      const noted = new EvmNotedSends(new MemoryRecordStore<NotedSend>(), {
        chainId: CHAIN_ID,
        burnAddress: BURN,
      })
      const record = (note: (typeof memberNotes)[number]) =>
        noted.recordNote({ ...note, itemTransactions: new Set(), notedAtMs: 1000 })
      if (order === 'message-first')
        await noted.recordNote({ ...messageNote, notedAtMs: 1000 })
      for (const note of memberNotes) await record(note)
      if (order === 'members-first')
        await noted.recordNote({ ...messageNote, notedAtMs: 1000 })
      return new Map(noted.all().map(row => [row.txHash, row]))
    }
    const first = await read('members-first')
    const second = await read('message-first')
    for (const [hash, row] of first) {
      expect(second.get(hash)?.purpose).toBe(row.purpose)
      expect(notedSendGroupKeys(second.get(hash)!)[0]).toBe(
        notedSendGroupKeys(row)[0],
      )
    }
    // The payment's coins are one payment to a contact, the stamp one stamp of its message, and
    // the two are one action: one operation (the stamp is a stage of it) for one message.
    for (const rawTx of payments) {
      expect(first.get(hashOf(rawTx))?.purpose).toBe('contact-payment')
      expect(notedSendGroupKeys(first.get(hashOf(rawTx))!)).toEqual([
        `operation:${operation.id}`,
      ])
    }
    for (const rawTx of stamps) {
      expect(first.get(hashOf(rawTx))?.purpose).toBe('stamp')
      expect(notedSendGroupKeys(first.get(hashOf(rawTx))!)).toEqual([
        `operation:${operation.id}`,
        `message:${messageId}`,
        `message:${messageId}`,
      ])
    }
    // A group write's payment is named by its own calldata, though it goes to the burn address.
    expect(first.get(hashOf(groupWrite))?.purpose).toBe('group-write')
  })
})
