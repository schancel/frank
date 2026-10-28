import { Transaction, Wallet } from 'ethers'
import { readCanonicalNativeTransfers } from '../evm-native-receipt'
import {
  mailboxes,
  mockBalances,
  offlineChain,
  offlineHttpModule,
  offlineMailboxModule,
  offlineProviderModule,
} from './canonical-two-wallets.testutil'

beforeEach(() => {
  offlineChain.reset()
  mockBalances.clear()
  mailboxes.clear()
})

test('provider observations preserve the signed mined recipient and transaction body', async () => {
  const signer = new Wallet('0x' + '12'.repeat(32))
  const recipient = new Wallet('0x' + '23'.repeat(32)).address
  const raw = await signer.signTransaction({
    chainId: 10143, nonce: 0, to: recipient, value: 123n,
    gasLimit: 50000n, gasPrice: 3n, type: 0, data: '0xabcd',
  })
  mockBalances.set(signer.address.toLowerCase(), 1000n)
  const provider = offlineProviderModule().createMonadJsonRpcProvider()
  try {
    const hash = offlineChain.mine(raw)
    const receipt = await provider.getTransactionReceipt(hash)
    const body = await provider.getTransaction(hash)
    expect(receipt).toMatchObject({ to: recipient, from: signer.address, status: 1, type: 0 })
    expect(body).toMatchObject({ hash, to: recipient, from: signer.address, value: 123n,
      data: '0xabcd', chainId: 10143n, nonce: 0, gasLimit: 50000n })
    expect(Transaction.from(body).serialized).toBe(raw)
    expect(await provider.getTransaction('0x' + 'aa'.repeat(32))).toBeNull()
  } finally { provider.destroy() }
})

test('HTTP and provider observe one mining event for the same signed transaction', async () => {
  const signer = new Wallet('0x' + '34'.repeat(32))
  const recipient = new Wallet('0x' + '45'.repeat(32)).address
  const raw = await signer.signTransaction({ chainId: 10143, nonce: 0, to: recipient,
    value: 123n, gasLimit: 21000n, gasPrice: 3n })
  mockBalances.set(signer.address.toLowerCase(), 1000n)
  const http = new (offlineHttpModule().MonadHttpClient)()
  const hash = await http.submitRawTransaction(raw)
  offlineChain.mine(raw)
  await http.submitRawTransaction(raw)
  expect(mockBalances.get(recipient.toLowerCase())).toBe(123n)
  expect(mockBalances.get(signer.address.toLowerCase())).toBe(877n)
  expect(await http.getTransactionReceipt(hash)).toEqual({ status: 'success' })
  expect(offlineChain.signedTransactions.get(hash)).toBe(raw)
})

test('combined mailbox preserves the inclusive cursor and explicit inbound direction', async () => {
  const record = { delivery: new Uint8Array([1]), context: new Uint8Array([2]),
    submissionIdentity: 'original', timestampMs: 100 }
  mailboxes.set('subject', [{ ...record, timestampMs: 99 }, record])
  const client = offlineMailboxModule()
  await expect(client.fetchCanonicalMailboxPage({ subject: 'subject', sinceMs: 100 }))
    .resolves.toEqual({ records: [{ ...record, direction: 'in' }] })
})

it('serves identical raw/typed canonical membership and actual signed native receipt facts', async () => {
  const provider = offlineProviderModule().createMonadJsonRpcProvider()
  try {
    const sender = new Wallet('0x' + '11'.repeat(32))
    const receiver = new Wallet('0x' + '22'.repeat(32)).address.toLowerCase()
    const hashes: string[] = []
    for (let nonce = 0; nonce < 3; nonce++) {
      const raw = await sender.signTransaction({
        type: 0,
        chainId: 10143,
        nonce,
        to: nonce === 0 ? sender.address : receiver,
        value: BigInt(nonce + 1),
        gasLimit: 21000n,
        gasPrice: 1n,
      })
      hashes.push(offlineChain.mine(raw))
    }
    const block = await provider.getBlock(1)
    const rawBlock = await provider.send('eth_getBlockByNumber', ['0x1', false])
    expect(rawBlock.transactions).toEqual(hashes)
    expect(block.transactions).toEqual(rawBlock.transactions)
    for (const [index, hash] of hashes.entries()) {
      const typed = await provider.getTransactionReceipt(hash)
      const raw = await provider.send('eth_getTransactionReceipt', [hash])
      expect(raw.transactionHash).toBe(typed.hash)
      expect(raw.blockHash).toBe(block.hash)
      expect(raw.transactionIndex).toBe(`0x${index.toString(16)}`)
      expect(typed.index).toBe(index)
    }
    const facts = await readCanonicalNativeTransfers({
      rpc: provider,
      chainIdentifier: 'monad-testnet',
      address: receiver,
      blockNumber: 1,
      maximumBlock: 1,
    })
    expect(facts.map(fact => [fact.txHash, fact.amount, fact.from])).toEqual([
      [hashes[1], '2', sender.address.toLowerCase()],
      [hashes[2], '3', sender.address.toLowerCase()],
    ])
    expect(Transaction.from(offlineChain.signedTransactions.get(hashes[2]!)!).hash).toBe(
      facts[1]!.txHash,
    )
    await expect(
      provider.send('eth_getTransactionByHash', ['0x' + '99'.repeat(32)]),
    ).resolves.toBeNull()
    await expect(provider.send('eth_getLogs', [])).rejects.toThrow('unexpected raw provider call')
  } finally {
    provider.destroy()
  }
})

it('still rejects inconsistent receipt inclusion instead of bypassing canonical validation', async () => {
  const provider = offlineProviderModule().createMonadJsonRpcProvider()
  try {
    const sender = new Wallet('0x' + '33'.repeat(32))
    const receiver = new Wallet('0x' + '44'.repeat(32)).address.toLowerCase()
    for (let nonce = 0; nonce < 2; nonce++)
      offlineChain.mine(
        await sender.signTransaction({
          type: 0,
          chainId: 10143,
          nonce,
          to: receiver,
          value: 1n,
          gasLimit: 21000n,
          gasPrice: 1n,
        }),
      )
    const receipt = provider.getTransactionReceipt.bind(provider)
    // A consumer's local typed node remains the authority for raw reads too.
    jest.spyOn(provider, 'getTransactionReceipt').mockImplementation(async (hash: string) => {
      const result = await receipt(hash)
      return result ? { ...result, index: 0 } : null
    })
    await expect(
      readCanonicalNativeTransfers({
        rpc: provider,
        chainIdentifier: 'monad-testnet',
        address: receiver,
        blockNumber: 1,
        maximumBlock: 1,
      }),
    ).rejects.toThrow('receipt inclusion mismatch')
  } finally {
    provider.destroy()
  }
})
