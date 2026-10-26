import { Wallet, parseEther } from 'ethers'
import { EvmNotedSends, type NotedSend } from './evm-noted-sends'
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
      carriesMessage: true,
      noteDigest: 'aa',
      notedAtMs: 2000,
    })
    await noted.recordNote({
      transactions: [{ rawTx: transfer, txHash: hashOf(transfer) }],
      itemTransactions: new Set(),
      carriesMessage: false,
      notedAtMs: 3000,
    })
    // The same bytes again, from a later read of the mailbox: nothing changes.
    await noted.recordNote({
      transactions: [{ rawTx: stamp }],
      itemTransactions: new Set(),
      carriesMessage: true,
      noteDigest: 'aa',
      notedAtMs: 9000,
    })
    // A note whose hash does not match its bytes is not taken.
    await noted.recordNote({
      transactions: [{ rawTx: transfer, txHash: '0x' + '00'.repeat(32) }],
      itemTransactions: new Set(),
      carriesMessage: false,
      notedAtMs: 1,
    })

    const byHash = new Map(noted.all().map(row => [row.txHash, row]))
    expect(byHash.size).toBe(4)
    expect(byHash.has(hashOf(foreign))).toBe(false)
    expect(byHash.get(hashOf(stamp))).toMatchObject({
      purpose: 'stamp',
      valueWei: parseEther('0.03').toString(),
      noteDigest: 'aa',
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
})
