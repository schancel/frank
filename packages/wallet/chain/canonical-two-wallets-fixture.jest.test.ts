import { Transaction, Wallet } from 'ethers'
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
